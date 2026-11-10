import { randomBytes } from 'node:crypto'
import { and, desc, eq } from 'drizzle-orm'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { getUser, requireUser } from '../auth'
import { db } from '../db/index'
import { oauthClients, oauthCodes, oauthGrants } from '../db/schema'
import { AppError, forbidden, notFound } from '../errors'
import { recordFailure } from '../guard'
import { isWellKnownClient, memberNameClashes, reservedClientName } from '../clientName'
import { accessRangeSchema, updateGrantRangeSchema } from '@inkling/shared'
import type { ClientNameNotice } from '@inkling/shared'
import { rangeToColumns, rangeView, validateRange } from '../tokenRange'
import { idParam } from '../helpers'
import { handBackConnections } from '../teamAgents'
import {
  ACCESS_TOKEN_TTL_MS,
  AUTH_CODE_TTL_MS,
  canWriteFromScopes,
  findClient,
  grantedScope,
  isAllowedRedirectUri,
  mcpResourceUrl,
  newOpaqueToken,
  OAUTH_SCOPE,
  publicOrigin,
  REFRESH_TOKEN_TTL_MS,
  redirectUriMatches,
  requestedAccess,
  sha256,
  SUPPORTED_SCOPES,
  verifyPkce,
} from '../oauth'
import { resourceWithoutProfile } from '../mcpProfile'

/**
 * OAuth 2.1 for the remote MCP connector (MCP authorization spec 2025-06-18)
 *
 *   GET  /.well-known/oauth-protected-resource[/mcp]  RFC 9728 protected resource metadata
 *   GET  /.well-known/oauth-authorization-server       RFC 8414 authorization server metadata
 *   POST /oauth/register                                RFC 7591 dynamic client registration (public clients)
 *   POST /oauth/token                                   authorization_code(+PKCE S256) / refresh_token (rotating)
 *   GET  /oauth/authorize                               ← no server route: the SPA consent screen handles it
 *
 *   /api/oauth/*  (session cookie only)
 *   GET    /api/oauth/authorize/info   client info for the consent screen + pre-validation
 *   POST   /api/oauth/authorize        allow/deny → { redirectTo }
 *   GET    /api/oauth/grants           connected apps
 *   PATCH  /api/oauth/grants/:id       change the connection's range (docs/adr/1200-*)
 *   DELETE /api/oauth/grants/:id       disconnect (tokens revoked immediately)
 */

// strict per-IP limits for the token / registration endpoints
const strictRateLimit = { rateLimit: { max: 20, timeWindow: '1 minute' } }

/** RFC 6749 §5.2 error response */
function oauthError(
  reply: FastifyReply,
  status: number,
  error: string,
  description: string,
): FastifyReply {
  return reply
    .code(status)
    .header('Cache-Control', 'no-store')
    .send({ error, error_description: description })
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined
}

/** redirect_uri with query parameters appended (existing query kept) */
function withParams(redirectUri: string, params: Record<string, string | undefined>): string {
  const u = new URL(redirectUri)
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) u.searchParams.set(k, v)
  }
  return u.toString()
}

/**
 * Resource indicator (RFC 8707) — only this server's /mcp (or origin) is allowed; `/mcp?profile=core`
 * and `?profile=full` name the same resource (tool profiles, docs/adr/2000-*).
 */
function isOurResource(req: FastifyRequest, resource: string): boolean {
  const origin = publicOrigin(req)
  const norm = resourceWithoutProfile(resource).replace(/\/+$/, '')
  return norm === origin || norm === `${origin}/mcp`
}

// ---------------------------------------------------------------------------
// Public (root) endpoints — registered in the same plugin scope as /mcp (shared CORS hook)
// ---------------------------------------------------------------------------

export async function registerOAuthRoutes(app: FastifyInstance): Promise<void> {
  // The token endpoint is application/x-www-form-urlencoded by spec — parsed in this scope only.
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_req, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(body as string)))
    },
  )

  // CORS for browser-based MCP clients (Inspector etc.). These are bearer/public endpoints that never
  // use cookies, so a wildcard origin is safe (credentials not allowed).
  app.addHook('onRequest', async (_req, reply) => {
    reply.header('Access-Control-Allow-Origin', '*')
    reply.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
    reply.header(
      'Access-Control-Allow-Headers',
      'authorization, content-type, accept, mcp-protocol-version, mcp-session-id, last-event-id',
    )
    reply.header(
      'Access-Control-Expose-Headers',
      'www-authenticate, mcp-session-id, mcp-protocol-version',
    )
    reply.header('Access-Control-Max-Age', '600')
  })
  const preflight = async (_req: FastifyRequest, reply: FastifyReply) => reply.code(204).send()
  app.options('/.well-known/*', preflight)
  app.options('/oauth/*', preflight)
  app.options('/mcp', preflight)

  const protectedResource = async (req: FastifyRequest) => ({
    resource: mcpResourceUrl(req),
    authorization_servers: [publicOrigin(req)],
    bearer_methods_supported: ['header'],
    scopes_supported: [...SUPPORTED_SCOPES],
    resource_name: 'Inkling',
  })
  app.get('/.well-known/oauth-protected-resource', protectedResource)
  app.get('/.well-known/oauth-protected-resource/mcp', protectedResource)

  app.get('/.well-known/oauth-authorization-server', async (req) => {
    const origin = publicOrigin(req)
    return {
      issuer: origin,
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/oauth/token`,
      registration_endpoint: `${origin}/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: [...SUPPORTED_SCOPES],
    }
  })

  // ── Dynamic client registration (public clients only) ─────────────────
  app.post('/oauth/register', { config: strictRateLimit }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const uris = body.redirect_uris
    if (
      !Array.isArray(uris) ||
      uris.length === 0 ||
      uris.length > 10 ||
      !uris.every((u) => typeof u === 'string' && u.length <= 2000 && isAllowedRedirectUri(u))
    ) {
      return oauthError(
        reply,
        400,
        'invalid_redirect_uri',
        'redirect_uris must be https or http://localhost (127.0.0.1) URLs',
      )
    }
    const method = str(body.token_endpoint_auth_method) ?? 'none'
    if (method !== 'none') {
      return oauthError(
        reply,
        400,
        'invalid_client_metadata',
        'Only public clients (token_endpoint_auth_method=none) are supported',
      )
    }
    const rawName = str(body.client_name)?.trim() ?? ''
    const name = (rawName || new URL(uris[0] as string).hostname).slice(0, 100)
    // Names that pass for the product or an operator are refused (docs/adr/0978-*).
    const reserved = reservedClientName(name)
    if (reserved) {
      return oauthError(
        reply,
        400,
        'invalid_client_metadata',
        `client_name "${name}" is reserved (looks like "${reserved}"); use the name of your app`,
      )
    }
    const id = `ink_c_${randomBytes(16).toString('base64url')}`
    const [row] = await db
      .insert(oauthClients)
      .values({ id, name, redirectUris: uris as string[] })
      .returning({ createdAt: oauthClients.createdAt })

    return reply
      .code(201)
      .header('Cache-Control', 'no-store')
      .send({
        client_id: id,
        client_id_issued_at: Math.floor(row.createdAt.getTime() / 1000),
        client_name: name,
        redirect_uris: uris,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      })
  })

  // ── Token endpoint ────────────────────────────────────────────────────
  app.post('/oauth/token', { config: strictRateLimit }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const grantType = str(body.grant_type)
    const clientId = str(body.client_id)

    if (grantType === 'authorization_code') {
      const code = str(body.code)
      const verifier = str(body.code_verifier)
      const redirectUri = str(body.redirect_uri)
      if (!code || !verifier) {
        return oauthError(reply, 400, 'invalid_request', 'code and code_verifier are required')
      }
      // single use: deleted as it is read (only one of two concurrent exchanges succeeds)
      const [row] = await db
        .delete(oauthCodes)
        .where(eq(oauthCodes.codeHash, sha256(code)))
        .returning()
      if (!row || row.expiresAt.getTime() <= Date.now()) {
        await recordFailure(req, 'oauth-token')
        return oauthError(reply, 400, 'invalid_grant', 'Authorization code is invalid or expired')
      }
      if (clientId && clientId !== row.clientId) {
        return oauthError(reply, 400, 'invalid_grant', 'Client mismatch')
      }
      if (redirectUri !== row.redirectUri) {
        return oauthError(reply, 400, 'invalid_grant', 'redirect_uri mismatch')
      }
      if (!verifyPkce(verifier, row.codeChallenge)) {
        return oauthError(reply, 400, 'invalid_grant', 'PKCE verification failed')
      }

      const accessToken = newOpaqueToken('ink_at_')
      const refreshToken = newOpaqueToken('ink_rt_')
      const now = Date.now()
      await db.insert(oauthGrants).values({
        clientId: row.clientId,
        userId: row.userId,
        scope: row.scope,
        accessHash: sha256(accessToken),
        accessExpiresAt: new Date(now + ACCESS_TOKEN_TTL_MS),
        refreshHash: sha256(refreshToken),
        refreshExpiresAt: new Date(now + REFRESH_TOKEN_TTL_MS),
        // the range chosen on the consent screen (docs/adr/1200-*); refresh never changes it
        rangeKind: row.rangeKind,
        rangeWorkspaceIds: row.rangeWorkspaceIds,
        rangePageId: row.rangePageId,
      })
      return reply
        .header('Cache-Control', 'no-store')
        .header('Pragma', 'no-cache')
        .send({
          access_token: accessToken,
          token_type: 'Bearer',
          expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
          refresh_token: refreshToken,
          scope: row.scope ?? OAUTH_SCOPE,
        })
    }

    if (grantType === 'refresh_token') {
      const refresh = str(body.refresh_token)
      if (!refresh) {
        return oauthError(reply, 400, 'invalid_request', 'refresh_token is required')
      }
      const hash = sha256(refresh)
      const grant = (
        await db.select().from(oauthGrants).where(eq(oauthGrants.refreshHash, hash)).limit(1)
      )[0]
      if (!grant) {
        await recordFailure(req, 'oauth-token')
        // reuse of an already rotated (revoked) refresh token → likely theft; revoke the whole grant.
        await db.delete(oauthGrants).where(eq(oauthGrants.prevRefreshHash, hash))
        return oauthError(reply, 400, 'invalid_grant', 'Invalid refresh token')
      }
      if (grant.refreshExpiresAt.getTime() <= Date.now()) {
        await db.delete(oauthGrants).where(eq(oauthGrants.id, grant.id))
        return oauthError(reply, 400, 'invalid_grant', 'Refresh token expired')
      }
      if (clientId && clientId !== grant.clientId) {
        return oauthError(reply, 400, 'invalid_grant', 'Client mismatch')
      }

      const accessToken = newOpaqueToken('ink_at_')
      const refreshToken = newOpaqueToken('ink_rt_')
      const now = Date.now()
      // conditional update (refresh_hash = old) — only one concurrent refresh succeeds
      const updated = await db
        .update(oauthGrants)
        .set({
          accessHash: sha256(accessToken),
          accessExpiresAt: new Date(now + ACCESS_TOKEN_TTL_MS),
          refreshHash: sha256(refreshToken),
          prevRefreshHash: hash,
          refreshExpiresAt: new Date(now + REFRESH_TOKEN_TTL_MS),
        })
        .where(and(eq(oauthGrants.id, grant.id), eq(oauthGrants.refreshHash, hash)))
        .returning({ id: oauthGrants.id })
      if (updated.length === 0) {
        return oauthError(reply, 400, 'invalid_grant', 'Invalid refresh token')
      }
      return reply
        .header('Cache-Control', 'no-store')
        .header('Pragma', 'no-cache')
        .send({
          access_token: accessToken,
          token_type: 'Bearer',
          expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
          refresh_token: refreshToken,
          scope: grant.scope ?? OAUTH_SCOPE,
        })
    }

    return oauthError(reply, 400, 'unsupported_grant_type', 'Unsupported grant_type')
  })
}

// ---------------------------------------------------------------------------
// /api/oauth/* — consent screen and grant management (browser session only)
// ---------------------------------------------------------------------------

/** Session cookie only — an MCP token must not approve or revoke other apps. */
async function requireCookieUser(req: FastifyRequest): Promise<void> {
  await requireUser(req)
  if (req.authVia !== 'cookie') throw forbidden('A browser login session is required')
}

const authorizeQuerySchema = z.object({
  client_id: z.string().min(1).max(200),
  redirect_uri: z.string().min(1).max(2000),
})

/** The info query may also carry the request's scope so the consent screen can preselect access. */
const authorizeInfoQuerySchema = authorizeQuerySchema.extend({
  scope: z.string().max(500).optional(),
})

const authorizeBodySchema = authorizeQuerySchema.extend({
  response_type: z.string().max(50).optional(),
  code_challenge: z.string().max(200).optional(),
  code_challenge_method: z.string().max(20).optional(),
  state: z.string().max(2000).optional(),
  scope: z.string().max(500).optional(),
  resource: z.string().max(2000).optional(),
  decision: z.enum(['allow', 'deny']),
  /**
   * The user's consent choice (docs/adr/0935-*). Never widens the request: a client that asked
   * only for 'read' gets 'read'. Absent (an older SPA build) = what the client requested.
   */
  access: z.enum(['read', 'write']).optional(),
  /**
   * What the connection may see (docs/adr/1200-*): everything, some workspaces, or one subtree.
   * Absent (an older SPA build) = everything, as before.
   */
  range: accessRangeSchema.optional(),
})

/** Validates client_id + redirect_uri — on failure answer 400 instead of redirecting (no open redirect) */
async function validateClientRedirect(clientId: string, redirectUri: string) {
  const client = await findClient(clientId)
  if (!client) throw new AppError(400, 'INVALID_CLIENT', 'Unknown app. Connect again from the app.')
  if (!redirectUriMatches(redirectUri, client.redirectUris)) {
    throw new AppError(400, 'INVALID_REDIRECT', "The app's redirect URL does not match the registered one.")
  }
  return client
}

export async function registerOAuthApiRoutes(app: FastifyInstance): Promise<void> {
  // app name / redirect host for the consent screen
  app.get('/oauth/authorize/info', { preHandler: requireCookieUser }, async (req) => {
    const q = authorizeInfoQuerySchema.parse(req.query)
    const client = await validateClientRedirect(q.client_id, q.redirect_uri)
    const user = getUser(req)
    const clash = await memberNameClashes(client.name, user.id)
    const nameNotice: ClientNameNotice | null = clash
      ? { member: clash.member, workspaces: clash.workspaces.map((w) => w.name), blocking: !isWellKnownClient(client.name) }
      : null
    return {
      client: { id: client.id, name: client.name },
      nameNotice,
      redirectHost: new URL(q.redirect_uri).host,
      // 'read' = the client asked only for read access → the consent screen offers read-only only
      requestedAccess: requestedAccess(q.scope),
    }
  })

  // allow/deny → returns the URL back to the client's redirect_uri (the SPA navigates)
  app.post(
    '/oauth/authorize',
    { preHandler: requireCookieUser, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req) => {
      const user = getUser(req)
      const b = authorizeBodySchema.parse(req.body)
      try {
        await validateClientRedirect(b.client_id, b.redirect_uri)
      } catch (err) {
        await recordFailure(req, 'oauth-authorize')
        throw err
      }
      const back = (params: Record<string, string | undefined>) => ({
        redirectTo: withParams(b.redirect_uri, { ...params, state: b.state }),
      })

      if (b.decision === 'deny') {
        return back({ error: 'access_denied', error_description: 'The user denied access' })
      }
      // A client named like a member would make its writes read as that person's (docs/adr/0978-*).
      const [client] = await db.select({ name: oauthClients.name }).from(oauthClients).where(eq(oauthClients.id, b.client_id)).limit(1)
      // Product/operator names are refused everywhere; a member's name is handled per workspace at
      // request time and shown as a notice on the consent screen (docs/adr/1007-*).
      if (client && reservedClientName(client.name)) {
        throw new AppError(
          400,
          'CLIENT_NAME_RESERVED',
          `This app calls itself "${client.name}", which matches a reserved name. Connect an app with its own name.`,
        )
      }
      if (b.response_type !== 'code') {
        return back({ error: 'unsupported_response_type' })
      }
      if (
        !b.code_challenge ||
        b.code_challenge_method !== 'S256' ||
        !/^[A-Za-z0-9_-]{43}$/.test(b.code_challenge)
      ) {
        return back({ error: 'invalid_request', error_description: 'PKCE (S256) is required' })
      }
      if (b.resource && !isOurResource(req, b.resource)) {
        return back({ error: 'invalid_target', error_description: 'Unknown resource' })
      }

      const range = b.range ?? { kind: 'all' as const }
      await validateRange(user.id, range)
      const code = newOpaqueToken('ink_code_')
      await db.insert(oauthCodes).values({
        ...rangeToColumns(range),
        codeHash: sha256(code),
        clientId: b.client_id,
        userId: user.id,
        redirectUri: b.redirect_uri,
        codeChallenge: b.code_challenge,
        scope: grantedScope(b.scope, b.access),
        resource: b.resource ?? null,
        expiresAt: new Date(Date.now() + AUTH_CODE_TTL_MS),
      })
      return back({ code })
    },
  )

  // connected apps (mine only)
  app.get('/oauth/grants', { preHandler: requireCookieUser }, async (req) => {
    const user = getUser(req)
    const rows = await db
      .select({
        id: oauthGrants.id,
        clientName: oauthClients.name,
        scope: oauthGrants.scope,
        rangeKind: oauthGrants.rangeKind,
        rangeWorkspaceIds: oauthGrants.rangeWorkspaceIds,
        rangePageId: oauthGrants.rangePageId,
        createdAt: oauthGrants.createdAt,
        lastUsedAt: oauthGrants.lastUsedAt,
      })
      .from(oauthGrants)
      .innerJoin(oauthClients, eq(oauthClients.id, oauthGrants.clientId))
      .where(eq(oauthGrants.userId, user.id))
      .orderBy(desc(oauthGrants.createdAt))
    const grants = []
    for (const r of rows) {
      grants.push({
        id: r.id,
        clientName: r.clientName,
        // additive: legacy (null/'notes') grants report full access
        access: canWriteFromScopes(r.scope ?? '') ? ('write' as const) : ('read' as const),
        // additive (docs/adr/1200-*): what the connection may see
        range: await rangeView(user.id, r),
        createdAt: r.createdAt.toISOString(),
        lastUsedAt: r.lastUsedAt ? r.lastUsedAt.toISOString() : null,
      })
    }
    return { grants }
  })

  // change what a connection may see (docs/adr/1200-*); takes effect on its next request
  app.patch('/oauth/grants/:id', { preHandler: requireCookieUser }, async (req) => {
    const user = getUser(req)
    const id = idParam(req.params)
    const { range } = updateGrantRangeSchema.parse(req.body)
    await validateRange(user.id, range)
    const updated = await db
      .update(oauthGrants)
      .set(rangeToColumns(range))
      .where(and(eq(oauthGrants.id, id), eq(oauthGrants.userId, user.id)))
      .returning({ id: oauthGrants.id })
    if (updated.length === 0) throw notFound()
    return { ok: true }
  })

  // disconnect — access/refresh tokens revoked immediately
  app.delete('/oauth/grants/:id', { preHandler: requireCookieUser }, async (req, reply) => {
    const user = getUser(req)
    const id = idParam(req.params)
    const deleted = await db
      .delete(oauthGrants)
      .where(and(eq(oauthGrants.id, id), eq(oauthGrants.userId, user.id)))
      .returning({ id: oauthGrants.id })
    if (deleted.length === 0) throw notFound()
    // what was handed to this connection falls to its person (docs/adr/1863-*)
    await handBackConnections(deleted.map((d) => `grant:${d.id}`))
    return reply.code(204).send()
  })
}

