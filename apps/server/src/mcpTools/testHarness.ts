/**
 * Test-only harness: a Fastify app with the /api routes the MCP tools call, plus helpers that mint
 * users, workspaces, pages and OAuth access tokens, and an MCP client connected in memory to
 * buildMcpServer. Used by the [db] suites of the agent tools; never imported by production code.
 *
 * Import it lazily inside a `[db]` suite (it opens the database connection on import).
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import { createSession, SESSION_COOKIE } from '../auth'
import type { AuthUser } from '../auth'
import { db } from '../db/index'
import * as schema from '../db/schema'
import { AppError } from '../errors'
import { generateInviteCodeColumns } from '../helpers'
import { blocksToStateBuffer } from '../md/convert'
import type { AnyBlock } from '../md/convert'
import { buildMcpServer } from '../mcp'
import { sha256 } from '../oauth'
import type { ToolCtx } from './core'

export async function buildTestApp(): Promise<FastifyInstance> {
  const app = Fastify()
  await app.register(import('@fastify/cookie'))
  await app.register(import('@fastify/multipart'), { limits: { fileSize: 25 * 1024 * 1024, files: 300 } })
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) {
      if (err.retryAfter) reply.header('Retry-After', String(err.retryAfter))
      return reply.code(err.status).send({ error: { ...(err.details ?? {}), code: err.code, message: err.message } })
    }
    if (err instanceof ZodError) {
      const issue = err.issues[0]
      return reply.code(400).send({ error: { code: 'VALIDATION', message: issue ? `${issue.path.join('.')}: ${issue.message}` : 'Validation failed' } })
    }
    const statusCode = (err as { statusCode?: number }).statusCode
    if (statusCode && statusCode >= 400 && statusCode < 500) {
      return reply.code(statusCode).send({ error: { code: 'VALIDATION', message: String((err as Error).message) } })
    }
    console.error(err)
    return reply.code(500).send({ error: { code: 'INTERNAL', message: String(err) } })
  })
  await app.register(
    async (api) => {
      await (await import('../routes/workspaces')).registerWorkspaceRoutes(api)
      await (await import('../routes/workspaceAdmin')).registerWorkspaceAdminRoutes(api)
      await (await import('../routes/pages')).registerPageRoutes(api)
      await (await import('../routes/pageContent')).registerPageContentRoutes(api)
      await (await import('../routes/editLock')).registerEditLockRoutes(api)
      await (await import('../routes/tasks')).registerTaskRoutes(api)
      await (await import('../routes/ink')).registerInkRoutes(api)
      await (await import('../routes/context')).registerContextRoutes(api)
      await (await import('../routes/changes')).registerChangeRoutes(api)
      await (await import('../routes/catchUp')).registerCatchUpRoutes(api)
      await (await import('../routes/snapshots')).registerSnapshotRoutes(api)
      await (await import('../routes/largePages')).registerLargePageRoutes(api)
      await (await import('../routes/splitPage')).registerSplitPageRoutes(api)
      await (await import('../routes/templates')).registerTemplateRoutes(api)
      await (await import('../routes/collections')).registerCollectionRoutes(api)
      await (await import('../routes/exportImport')).registerExportImportRoutes(api)
      await (await import('../routes/comments')).registerCommentRoutes(api)
      await (await import('../routes/notifications')).registerNotificationRoutes(api)
      await (await import('../routes/activity')).registerActivityRoutes(api)
      await (await import('../routes/inbox')).registerInboxRoutes(api)
      await (await import('../routes/later')).registerLaterRoutes(api)
      await (await import('../routes/threads')).registerThreadRoutes(api)
      await (await import('../routes/oauth')).registerOAuthApiRoutes(api)
      await (await import('../routes/sidebarPrefs')).registerSidebarPrefsRoutes(api)
      await (await import('../routes/files')).registerFileRoutes(api)
    },
    { prefix: '/api' },
  )
  await (await import('../routes/files')).registerFileDownloadRoute(app)
  await app.ready()
  return app
}

const tag = () => randomUUID().slice(0, 8)

export interface TestUser extends AuthUser {
  cookie: string
}

export async function makeUser(name = 'u'): Promise<TestUser> {
  const [u] = await db
    .insert(schema.users)
    .values({ email: `${name}-${tag()}@t.t`, name, passwordHash: 'x' })
    .returning()
  const { token } = await createSession(u.id)
  return { id: u.id, email: u.email, name: u.name, isAdmin: u.isAdmin, cookie: `${SESSION_COOKIE}=${token}` }
}

export async function makeWorkspace(owner: { id: string }, members: { id: string }[] = [], name = `WS ${tag()}`) {
  // the invite code is stored as its hash plus a sealed copy, like the routes do (docs/adr/1110-*)
  const id = randomUUID()
  const [ws] = await db
    .insert(schema.workspaces)
    .values({ id, name, ...(await generateInviteCodeColumns(db, id)) })
    .returning()
  await db.insert(schema.workspaceMembers).values([
    { workspaceId: ws.id, userId: owner.id, role: 'owner' as const },
    ...members.map((m) => ({ workspaceId: ws.id, userId: m.id, role: 'member' as const })),
  ])
  return ws
}

/** A doc page with the given blocks stored in page_docs (indexes are NOT built; call the indexer). */
export async function makeDocPage(
  workspaceId: string,
  by: string,
  title: string,
  blocks: AnyBlock[],
  extra: Partial<typeof schema.pages.$inferInsert> = {},
) {
  const [p] = await db
    .insert(schema.pages)
    .values({ workspaceId, title, createdBy: by, kind: 'doc', ...extra })
    .returning()
  await db.insert(schema.pageDocs).values({ pageId: p.id, state: blocksToStateBuffer(blocks) })
  return p
}

/**
 * Mint an OAuth access token for `user` (a grant on a throwaway client). `scope` is stored as
 * given (null = legacy grant without a scope).
 */
export async function mintToken(user: { id: string }, scope: string | null = 'notes', clientName = 'Test Agent') {
  const clientId = `test-${tag()}${tag()}`
  await db.insert(schema.oauthClients).values({ id: clientId, name: clientName, redirectUris: ['https://example.com/cb'] })
  const token = randomBytes(24).toString('base64url')
  const refresh = randomBytes(24).toString('base64url')
  const now = Date.now()
  await db.insert(schema.oauthGrants).values({
    clientId,
    userId: user.id,
    scope,
    accessHash: sha256(token),
    accessExpiresAt: new Date(now + 3_600_000),
    refreshHash: sha256(refresh),
    refreshExpiresAt: new Date(now + 86_400_000),
  })
  return token
}

/**
 * An MCP client talking to buildMcpServer in memory. `ctxOverrides` lets a test set fields the
 * /mcp handler would normally derive from the token (e.g. canWrite, user.via).
 */
export async function connectMcp(
  app: FastifyInstance,
  user: AuthUser,
  token: string,
  ctxOverrides: Partial<ToolCtx> = {},
) {
  const ctx: ToolCtx = {
    app,
    token,
    ip: '127.0.0.1',
    user,
    origin: 'https://notes.example.com',
    canWrite: true,
    ...ctxOverrides,
  }
  const server = buildMcpServer(ctx)
  const [clientT, serverT] = InMemoryTransport.createLinkedPair()
  await server.connect(serverT)
  const client = new Client({ name: 'inkling-test', version: '1.0.0' })
  await client.connect(clientT)
  /** Call a tool; returns its text (joined) and isError. */
  const tool = async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await client.callTool({ name, arguments: args })) as {
      content?: { type: string; text?: string }[]
      isError?: boolean
    }
    const out = (res.content ?? []).map((c) => c.text ?? '').join('\n')
    return { text: out, isError: res.isError === true }
  }
  const close = async () => {
    await client.close()
    await server.close()
  }
  return { client, tool, close, ctx }
}
