import { randomBytes } from 'node:crypto'
import { and, desc, eq, gt, sql } from 'drizzle-orm'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { AGENT_TOKEN_MAX_PER_USER, AGENT_TOKEN_PREFIX } from '@inkling/shared'
import type { AgentTokenDTO, CreateAgentTokenInput } from '@inkling/shared'
import { db } from './db/index'
import { oauthClients, oauthGrants } from './db/schema'
import { AppError } from './errors'
import { banRemainingMs, RATE_LIMIT_MESSAGE, recordFailure } from './guard'
import { isWellKnownClient, memberNameClashes, reservedClientName } from './clientName'
import { canWriteFromScopes, sanitizeClientName, sha256, STORED_SCOPE_FULL, STORED_SCOPE_READ_ONLY } from './oauth'
import { rangeToColumns, rangeView, validateRange } from './tokenRange'
import type { StoredRange } from './tokenRange'
import { recordAudit } from './workspaceAdmin'
import type { AuditActor } from './workspaceAdmin'
import { suggestOnlyStates } from './agentTaint'
import { handBackConnections } from './teamAgents'

/**
 * Agent connection tokens (docs/adr/2060-* .. 2063-*).
 *
 *   ink_agt_<43 base64url characters>   (32 random bytes)
 *
 * A person makes one in Settings › Connections, names it and picks what an OAuth consent screen offers
 * (read or read+write, a range). It is stored as an OAuth grant of kind 'token' on an oauth_clients row of
 * its own whose name is that name: `getBearerUser` finds it by `sha256(token)` like any access token, so
 * from there on it is the same agent connection as one made by the OAuth flow — `grant:<id>`, the
 * client name as the "via" label, agent blocks, edit locks, policies, claims, usage, inbox and hand-offs,
 * suggest-only after flagged content. Only the way it was issued differs:
 *   - one access token valid until the chosen expiry (no refresh: the refresh hash is a hash of random
 *     bytes nobody holds, and /oauth/token refuses kind 'token' anyway);
 *   - its client row has no redirect URIs, so the authorize flow can never use it;
 *   - made and revoked in a browser session only, audited in the workspaces it reaches.
 * Personal API tokens (`ink_pat_`) are a different thing and stay 401 at /mcp (docs/adr/1201-*).
 */

const TOKEN_RE = new RegExp(`^${AGENT_TOKEN_PREFIX}[A-Za-z0-9_-]{43}$`)
/** oauth_clients ids of agent connection tokens (OAuth registrations are `ink_c_…`). */
export const TOKEN_CLIENT_PREFIX = 'ink_tc_'

export function isAgentTokenShaped(token: string): boolean {
  return token.startsWith(AGENT_TOKEN_PREFIX)
}

export function newAgentToken(): string {
  return `${AGENT_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`
}

/** Display prefix kept in the database: `ink_agt_` + 4 characters. */
export function agentTokenDisplayPrefix(token: string): string {
  return token.slice(0, AGENT_TOKEN_PREFIX.length + 4)
}

/**
 * The name as it will read in "<person> (via <name>)": sanitised like an OAuth client name; product and
 * operator names are refused, and so is another member's display name (the OAuth consent screen only
 * warns for well-known app names such as "Claude Code", and so does this).
 */
export async function checkAgentTokenName(raw: string, userId: string): Promise<string> {
  const name = sanitizeClientName(raw)
  if (!name) throw new AppError(400, 'VALIDATION', 'Give the connection a name')
  const reserved = reservedClientName(name)
  if (reserved) {
    throw new AppError(400, 'CLIENT_NAME_RESERVED', `"${name}" is reserved (it reads like "${reserved}"). Name the app or agent that will use it`)
  }
  if (!isWellKnownClient(name)) {
    const clash = await memberNameClashes(name, userId)
    if (clash) {
      throw new AppError(
        400,
        'CLIENT_NAME_CLASH',
        `"${name}" is the name of a member (${clash.workspaces.map((w) => w.name).join(', ')}): the agent's edits would read as theirs. Pick another name`,
      )
    }
  }
  return name
}

/** Live workspaces of `userId` that the range reaches: where an agent connection token is audited. */
async function workspacesInRange(exec: Pick<typeof db, 'execute'>, userId: string, r: StoredRange): Promise<string[]> {
  const rows = (await exec.execute(sql`
    SELECT m.workspace_id AS id FROM workspace_members m
      JOIN workspaces w ON w.id = m.workspace_id AND w.deleted_at IS NULL
     WHERE m.user_id = ${userId}::uuid
       AND (${r.rangeKind}::text IS NULL OR ${r.rangeKind}::text = 'all'
            OR (${r.rangeKind}::text = 'workspaces' AND m.workspace_id = ANY(${`{${(r.rangeWorkspaceIds ?? []).join(',')}}`}::uuid[]))
            OR (${r.rangeKind}::text = 'subtree' AND m.workspace_id = (SELECT p.workspace_id FROM pages p WHERE p.id = ${r.rangePageId}::uuid)))
     ORDER BY m.workspace_id
  `)) as unknown as { id: string }[]
  return rows.map((x) => x.id)
}

function rangeKindOf(r: StoredRange): string {
  return r.rangeKind ?? 'all'
}

export async function createAgentToken(
  actor: { id: string; name: string },
  input: CreateAgentTokenInput,
): Promise<{ id: string; secret: string }> {
  const name = await checkAgentTokenName(input.name, actor.id)
  await validateRange(actor.id, input.range)
  const secret = newAgentToken()
  const expiresAt = new Date(Date.now() + input.expiresInDays * 86_400_000)
  const range = rangeToColumns(input.range)
  const access = input.access
  return db.transaction(async (tx) => {
    // the cap counts live tokens; serialised per person so two tabs cannot both pass it
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('agent-tokens:' || ${actor.id}))`)
    const [{ n }] = (await tx.execute(sql`
      SELECT count(*)::int AS n FROM oauth_grants
       WHERE user_id = ${actor.id}::uuid AND kind = 'token' AND access_expires_at > now()
    `)) as unknown as { n: number }[]
    if (n >= AGENT_TOKEN_MAX_PER_USER) {
      throw new AppError(409, 'TOO_MANY_TOKENS', `You can hold at most ${AGENT_TOKEN_MAX_PER_USER} agent connection tokens. Revoke one first`)
    }
    const clientId = `${TOKEN_CLIENT_PREFIX}${randomBytes(16).toString('base64url')}`
    await tx.insert(oauthClients).values({ id: clientId, name, redirectUris: [] })
    const [row] = await tx
      .insert(oauthGrants)
      .values({
        clientId,
        userId: actor.id,
        kind: 'token',
        scope: access === 'write' ? STORED_SCOPE_FULL : STORED_SCOPE_READ_ONLY,
        ...range,
        accessHash: sha256(secret),
        accessExpiresAt: expiresAt,
        // never handed out: nobody can refresh this grant (and /oauth/token refuses kind 'token')
        refreshHash: sha256(`unusable:${randomBytes(32).toString('base64url')}`),
        refreshExpiresAt: expiresAt,
        tokenPrefix: agentTokenDisplayPrefix(secret),
      })
      .returning({ id: oauthGrants.id })
    for (const workspaceId of await workspacesInRange(tx, actor.id, range)) {
      await recordAudit(tx, {
        workspaceId,
        actor: { id: actor.id, name: actor.name },
        action: 'agent.token_created',
        target: { type: 'connection', id: `grant:${row.id}`, label: name },
        after: { access, range: rangeKindOf(range), expiresAt: expiresAt.toISOString() },
      })
    }
    return { id: row.id, secret }
  })
}

type GrantRow = {
  id: string
  name: string
  prefix: string | null
  scope: string | null
  rangeKind: string | null
  rangeWorkspaceIds: string[] | null
  rangePageId: string | null
  createdAt: Date
  expiresAt: Date
  lastUsedAt: Date | null
}

const listColumns = {
  id: oauthGrants.id,
  name: oauthClients.name,
  prefix: oauthGrants.tokenPrefix,
  scope: oauthGrants.scope,
  rangeKind: oauthGrants.rangeKind,
  rangeWorkspaceIds: oauthGrants.rangeWorkspaceIds,
  rangePageId: oauthGrants.rangePageId,
  createdAt: oauthGrants.createdAt,
  expiresAt: oauthGrants.accessExpiresAt,
  lastUsedAt: oauthGrants.lastUsedAt,
}

async function toDtos(userId: string, rows: GrantRow[]): Promise<AgentTokenDTO[]> {
  const states = await suggestOnlyStates(rows.map((r) => `grant:${r.id}`))
  const out: AgentTokenDTO[] = []
  for (const r of rows) {
    out.push({
      id: r.id,
      name: r.name,
      prefix: r.prefix ?? AGENT_TOKEN_PREFIX,
      access: canWriteFromScopes(r.scope ?? '') ? 'write' : 'read',
      range: await rangeView(userId, r),
      createdAt: r.createdAt.toISOString(),
      expiresAt: r.expiresAt.toISOString(),
      lastUsedAt: r.lastUsedAt ? r.lastUsedAt.toISOString() : null,
      suggestOnly: states.get(`grant:${r.id}`) ?? null,
    })
  }
  return out
}

/** The person's agent connection tokens, newest first (expired ones until the hourly purge removes them). */
export async function listAgentTokens(userId: string): Promise<AgentTokenDTO[]> {
  const rows = await db
    .select(listColumns)
    .from(oauthGrants)
    .innerJoin(oauthClients, eq(oauthClients.id, oauthGrants.clientId))
    .where(and(eq(oauthGrants.userId, userId), eq(oauthGrants.kind, 'token')))
    .orderBy(desc(oauthGrants.createdAt), desc(oauthGrants.id))
  return toDtos(userId, rows)
}

export async function getAgentToken(userId: string, id: string): Promise<AgentTokenDTO | null> {
  const rows = await db
    .select(listColumns)
    .from(oauthGrants)
    .innerJoin(oauthClients, eq(oauthClients.id, oauthGrants.clientId))
    .where(and(eq(oauthGrants.id, id), eq(oauthGrants.userId, userId), eq(oauthGrants.kind, 'token')))
    .limit(1)
  return rows.length ? (await toDtos(userId, rows))[0] : null
}

/**
 * Revoke one of the owner's connections by grant id — an OAuth grant or an agent connection token
 * (the Connections screen and DELETE /oauth/grants/:id both land here). The token stops at once; a
 * token's own client row goes with it, and its revocation is audited. Returns false when there is no
 * such connection of `actor`.
 */
export async function revokeConnection(actor: AuditActor, id: string): Promise<boolean> {
  const deleted = await db.transaction(async (tx) => {
    const rows = await tx
      .delete(oauthGrants)
      .where(and(eq(oauthGrants.id, id), eq(oauthGrants.userId, actor.id)))
      .returning({
        id: oauthGrants.id,
        kind: oauthGrants.kind,
        clientId: oauthGrants.clientId,
        rangeKind: oauthGrants.rangeKind,
        rangeWorkspaceIds: oauthGrants.rangeWorkspaceIds,
        rangePageId: oauthGrants.rangePageId,
      })
    const row = rows[0]
    if (!row) return null
    if (row.kind === 'token') {
      const [client] = await tx
        .delete(oauthClients)
        .where(and(eq(oauthClients.id, row.clientId), sql`${oauthClients.id} LIKE ${`${TOKEN_CLIENT_PREFIX}%`}`))
        .returning({ name: oauthClients.name })
      for (const workspaceId of await workspacesInRange(tx, actor.id, row)) {
        await recordAudit(tx, {
          workspaceId,
          actor: { id: actor.id, name: actor.name },
          action: 'agent.token_revoked',
          target: { type: 'connection', id: `grant:${row.id}`, label: client?.name ?? null },
        })
      }
    }
    return row
  })
  if (!deleted) return false
  // what was handed to this connection falls to its person (docs/adr/1863-*)
  await handBackConnections([`grant:${deleted.id}`])
  return true
}

/**
 * Change one of the owner's connections' range (PATCH /oauth/grants/:id, for OAuth grants and agent tokens alike).
 * For an agent connection token the change is audited in every workspace the old or the new range reaches, so an
 * admin sees a token start (or stop) reaching their workspace. False when there is no such connection.
 */
export async function updateConnectionRange(actor: AuditActor, id: string, range: StoredRange): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [before] = await tx
      .select({
        kind: oauthGrants.kind,
        name: oauthClients.name,
        rangeKind: oauthGrants.rangeKind,
        rangeWorkspaceIds: oauthGrants.rangeWorkspaceIds,
        rangePageId: oauthGrants.rangePageId,
      })
      .from(oauthGrants)
      .innerJoin(oauthClients, eq(oauthClients.id, oauthGrants.clientId))
      .where(and(eq(oauthGrants.id, id), eq(oauthGrants.userId, actor.id)))
      .for('update', { of: oauthGrants })
      .limit(1)
    if (!before) return false
    await tx.update(oauthGrants).set(range).where(eq(oauthGrants.id, id))
    if (before.kind === 'token') {
      const reached = new Set([...(await workspacesInRange(tx, actor.id, before)), ...(await workspacesInRange(tx, actor.id, range))])
      for (const workspaceId of [...reached].sort()) {
        await recordAudit(tx, {
          workspaceId,
          actor: { id: actor.id, name: actor.name },
          action: 'agent.token_range_changed',
          target: { type: 'connection', id: `grant:${id}`, label: before.name },
          before: { range: rangeKindOf(before) },
          after: { range: rangeKindOf(range) },
        })
      }
    }
    return true
  })
}

// ---------------------------------------------------------------------------
// Guessing at /mcp (docs/adr/2062-*)
// ---------------------------------------------------------------------------

/**
 * Milliseconds an IP is still banned, for a request that presents an agent connection token: a banned
 * IP gets 429 before the lookup, like a personal API token at REST (auth.ts). Other bearer shapes are
 * not refused here (OAuth clients routinely present an expired `ink_at_` token and then refresh).
 */
export function agentTokenBanMs(req: FastifyRequest, token: string | null): number {
  return token && isAgentTokenShaped(token) ? banRemainingMs(req.ip) : 0
}

/** The 429 for a banned IP presenting an agent connection token (the app's RATE_LIMITED shape). */
export function agentTokenBanned(req: FastifyRequest, reply: FastifyReply, token: string | null): FastifyReply {
  const sec = Math.max(1, Math.ceil(agentTokenBanMs(req, token) / 1000))
  return reply
    .code(429)
    .header('Retry-After', String(sec))
    .send({ error: { code: 'RATE_LIMITED', message: RATE_LIMIT_MESSAGE } })
}

/**
 * A 401 at /mcp for an agent connection token: counted towards the IP ban (guard.ts) unless the token
 * exists and only ran out (a forgotten config is not an attack). Only the failure is recorded, never the
 * token.
 */
export async function noteAgentTokenFailure(req: FastifyRequest, token: string | null): Promise<void> {
  if (!token || !isAgentTokenShaped(token)) return
  if (TOKEN_RE.test(token)) {
    const known = await db
      .select({ id: oauthGrants.id })
      .from(oauthGrants)
      .where(and(eq(oauthGrants.accessHash, sha256(token)), eq(oauthGrants.kind, 'token')))
      .limit(1)
    if (known.length) return
  }
  await recordFailure(req, 'agent-token')
}

/** Live agent connection tokens of a person (tests, admin status). */
export async function countAgentTokens(userId: string): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(oauthGrants)
    .where(and(eq(oauthGrants.userId, userId), eq(oauthGrants.kind, 'token'), gt(oauthGrants.accessExpiresAt, new Date())))
  return r?.n ?? 0
}
