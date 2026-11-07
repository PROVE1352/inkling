import Fastify from 'fastify'
import { mkdir, readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { ZodError } from 'zod'
import { attachCollab, destroyCollab } from './collab'
import { closeDb, db, runMigrations } from './db/index'
import { sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { enabledExperimentalFeatures } from './features'
import { lifecycle, withTimeout } from './lifecycle'
import { assertOriginConfigured } from './origin'
import { maskUrlSecrets } from './util'
import { users } from './db/schema'
import { startReminderScheduler } from './md/reminders'
import { startReadFlusher } from './pageReads'
import { backfillPageTags } from './md/tagIndex'
import { backfillPageTasks } from './md/taskIndex'
import { backfillPageTexts } from './md/textIndex'
import { backfillPageChunks } from './context/chunkIndex'
import { env, mailEnabled } from './env'
import { AppError } from './errors'
import { registerApiCachePolicy, staticCacheControl } from './httpCache'
import { guardHook, initGuard, RATE_LIMIT_MESSAGE } from './guard'
import { registerMcpRoutes } from './mcp'
import { registerAdminRoutes } from './routes/admin'
import { registerAuthRoutes } from './routes/auth'
import { registerBookmarkRoutes } from './routes/bookmarks'
import { registerCollectionRoutes } from './routes/collections'
import { registerIcalApiRoutes, registerIcalFeedRoute } from './routes/ical'
import { registerCommentRoutes } from './routes/comments'
import { registerExportImportRoutes } from './routes/exportImport'
import { registerFileDownloadRoute, registerFileRoutes } from './routes/files'
import { registerInkRoutes } from './routes/ink'
import { registerNotificationRoutes } from './routes/notifications'
import { registerNotionRoutes } from './routes/notion'
import { registerOAuthApiRoutes, registerOAuthRoutes } from './routes/oauth'
import { registerPageContentRoutes } from './routes/pageContent'
import { registerEditLockRoutes } from './routes/editLock'
import { registerContextRoutes } from './routes/context'
import { registerChangeRoutes } from './routes/changes'
import { registerTaskRoutes } from './routes/tasks'
import { registerPageRoutes } from './routes/pages'
import { registerPublicRoutes } from './routes/public'
import { registerSnapshotRoutes } from './routes/snapshots'
import { registerTemplateRoutes } from './routes/templates'
import { registerWorkspaceRoutes } from './routes/workspaces'
import { registerWorkspaceAdminRoutes } from './routes/workspaceAdmin'
import { isExperimentalEnabled } from './features'
import { registerPluginRoutes } from './plugins/routes'
import { registerQueryRoutes } from './routes/query'
import { registerSyncRoutes } from './routes/sync'
import { registerEmbedCsp } from './embedCsp'
import { registerLinkPreviewRoutes } from './routes/linkPreview'
import { registerShareMetaRoutes } from './routes/shareMeta'
import { registerWebhookRoutes } from './routes/webhooks'
import { initWebhooks } from './webhooks'
import { registerBackupRoutes } from './backup/routes'
import { registerVersionRoutes } from './version'

const MAX_FILE_BYTES = 25 * 1024 * 1024

/** Whether the path is an API/file/collab path excluded from the SPA fallback */
function isReservedPath(url: string): boolean {
  const pathname = url.split('?')[0]
  return (
    pathname === '/api' ||
    pathname.startsWith('/api/') ||
    pathname === '/files' ||
    pathname.startsWith('/files/') ||
    pathname === '/collab' ||
    // MCP remote connector (OAuth metadata, token, registration, MCP endpoint); /oauth/authorize is the SPA consent screen
    pathname === '/mcp' ||
    pathname.startsWith('/.well-known/') ||
    pathname === '/oauth/token' ||
    pathname === '/oauth/register'
  )
}

// ---------------------------------------------------------------------------
// Process lifecycle (B-H1, B-H2, docs/adr/0805-*). Handlers are installed before anything else
// runs, so a signal during boot or migrations is handled too.
// ---------------------------------------------------------------------------

let appRef: FastifyInstance | null = null
let stopReminders: (() => void) | null = null
let stopReadFlusher: (() => Promise<void>) | null = null
let shutdownStarted = false

/** Hard cap for the whole shutdown; compose gives the container 30 s (stop_grace_period). */
const SHUTDOWN_WATCHDOG_MS = 25_000
const COLLAB_FLUSH_TIMEOUT_MS = 10_000
const HTTP_CLOSE_TIMEOUT_MS = 8_000

function log(level: 'info' | 'error' | 'warn', msg: string, err?: unknown): void {
  if (appRef) {
    if (err) appRef.log[level]({ err }, msg)
    else appRef.log[level](msg)
  } else if (level === 'error') console.error(msg, err ?? '')
  else console.log(msg)
}

/**
 * Graceful shutdown: (1) refuse new collab upgrades and stop accepting TCP connections,
 * (2) flush live Yjs documents (bounded), (3) close Fastify — in-flight requests finish (bounded),
 * (4) close the DB pool. A watchdog forces the exit if any step hangs.
 */
async function shutdown(reason: string, exitCode = 0): Promise<void> {
  if (shutdownStarted) return
  shutdownStarted = true
  lifecycle.shuttingDown = true
  log('info', `[inkling] ${reason} — shutting down`)
  const watchdog = setTimeout(() => {
    console.error('[inkling] shutdown watchdog fired — forcing exit')
    process.exit(exitCode || 1)
  }, SHUTDOWN_WATCHDOG_MS)
  watchdog.unref()

  const step = async (name: string, fn: () => Promise<unknown>, ms: number) => {
    try {
      await withTimeout(Promise.resolve().then(fn), ms, name)
    } catch (err) {
      log('error', `[inkling] shutdown: ${name} failed`, err)
    }
  }
  stopReminders?.()
  // ERR_SERVER_NOT_RUNNING from the later app.close() is tolerated by Fastify.
  if (appRef?.server.listening) appRef.server.close()
  await step('collab flush', () => destroyCollab(), COLLAB_FLUSH_TIMEOUT_MS)
  const a = appRef
  if (a) await step('http close', () => a.close(), HTTP_CLOSE_TIMEOUT_MS)
  // buffered page read counts (docs/adr/0953-*) — after HTTP so in-flight reads are counted
  if (stopReadFlusher) await step('read counter flush', () => stopReadFlusher!(), 3_000)
  await step('db close', () => closeDb(), 6_000)
  process.exit(exitCode)
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
// A rejected promise nobody awaited (e.g. a debounced collab store that failed after its retries)
// is logged, not fatal: Node's default would kill the process and drop every unsaved document.
process.on('unhandledRejection', (reason) => {
  log('error', '[inkling] unhandled promise rejection', reason)
})
// A synchronous exception that escaped every handler leaves unknown state: log it, then shut down
// gracefully (flushing documents) and let the container restart policy bring the process back.
process.on('uncaughtException', (err) => {
  log('error', '[inkling] uncaught exception', err)
  void shutdown('uncaughtException', 1)
})

/** Readiness probe cache (B-M5): `select 1` at most every 5 s. */
let readyCache: { at: number; ok: boolean } | null = null
async function databaseReady(): Promise<boolean> {
  const now = Date.now()
  if (readyCache && now - readyCache.at < 5_000) return readyCache.ok
  let ok = false
  try {
    await withTimeout(db.execute(sql`select 1`), 2_000, 'readiness probe')
    ok = true
  } catch {
    ok = false
  }
  readyCache = { at: now, ok }
  return ok
}

async function main(): Promise<void> {
  // 0) Configuration that must not silently fall back to request headers (C-M1).
  assertOriginConfigured()

  // 1) Prepare the upload directory
  await mkdir(path.join(env.dataDir, 'uploads'), { recursive: true })
  //    Scratch space for streamed imports/exports (docs/adr/0751-*): anything left there or as a
  //    partial upload belongs to a request of a previous process and is safe to drop at boot.
  await rm(path.join(env.dataDir, 'tmp'), { recursive: true, force: true })
  await mkdir(path.join(env.dataDir, 'tmp'), { recursive: true })
  for (const f of await readdir(path.join(env.dataDir, 'uploads'))) {
    if (f.startsWith('.upload-')) await rm(path.join(env.dataDir, 'uploads', f), { force: true })
  }

  // 2) Migrations (the server does not start without a DB)
  try {
    await runMigrations()
  } catch (err) {
    console.error('[inkling] Migration failed; the server cannot start', err)
    process.exit(1)
  }

  // 3) Fastify instance
  //    trustProxy: only addresses trusted as front proxies (default loopback + private ranges, env
  //    TRUST_PROXY). X-Forwarded-For on connections straight from the internet is ignored, so a
  //    spoofed IP cannot dodge a ban or get someone else's IP banned. Request/connection timeouts
  //    keep slow clients from holding workers.
  const app = Fastify({
    logger: {
      // Request URLs carry bearer secrets (iCal feed / public share tokens, OAuth codes, reset
      // codes): mask them before they reach the logs (C-L8).
      serializers: {
        req(req) {
          return {
            method: req.method,
            url: maskUrlSecrets(req.url),
            hostname: req.hostname,
            remoteAddress: req.ip,
            remotePort: req.socket?.remotePort,
          }
        },
      },
    },
    trustProxy: env.trustProxy,
    // Whole-request cap: 25 MB uploads and 50 MB folder imports on slow links need minutes (B-M2).
    requestTimeout: 300_000,
    connectionTimeout: 30000,
  })
  appRef = app

  // Allow POST/DELETE without a body (logout, invite code regeneration, snapshot restore...).
  // The web fetch wrapper always sets Content-Type: application/json, and the default JSON parser
  // rejects an empty body with FST_ERR_CTP_EMPTY_JSON_BODY, causing a 500 → empty body = undefined.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_req, body, done) => {
      const raw = body as string
      if (!raw || raw.trim() === '') return done(null, undefined)
      try {
        done(null, JSON.parse(raw))
      } catch (err) {
        ;(err as { statusCode?: number }).statusCode = 400
        done(err as Error, undefined)
      }
    },
  )

  // 4) Plugins
  await app.register(import('@fastify/cookie'))
  await app.register(import('@fastify/multipart'), {
    // Bounded non-file parts too (C-L10): busboy's defaults allow unlimited fields/parts.
    limits: {
      fileSize: MAX_FILE_BYTES,
      files: 1,
      fields: 20,
      fieldSize: 100 * 1024,
      parts: 40,
      headerPairs: 200,
    },
  })

  // Rate limit: a gentle global limit (300/min). auth/login, register and join override it per
  // route with a strict 10/min. 429s use the app error format ({error:{code,message}}).
  await app.register(import('@fastify/rate-limit'), {
    global: true,
    max: 300,
    timeWindow: '1 minute',
    // Static assets (SPA shell, hashed bundles, icons) are not counted: the first visit's SW
    // precache (~60 files) alone used up the limit, so browsing a public folder or the next API
    // calls got 429s. Only API, MCP, OAuth and files count.
    allowList: (req) => {
      const url = req.url
      return (
        req.method === 'GET' &&
        !/^\/(api|mcp|oauth|files|collab|\.well-known)(\/|\?|$)/.test(url)
      )
    },
    // The plugin throws this return value → returning an AppError makes the global error
    // handler's AppError branch answer 429 + the {error:{code,message}} app format.
    errorResponseBuilder: () =>
      new AppError(429, 'RATE_LIMITED', RATE_LIMIT_MESSAGE),
  })

  // Brute-force protection: IPs banned for repeated failures get a 429 on auth/token paths before any expensive work.
  await initGuard((msg) => app.log.info(msg))
  app.addHook('onRequest', guardHook)
  // CSP frame-src for HTML responses without their own CSP (embed providers) — docs/adr/0501-*
  registerEmbedCsp(app)
  initWebhooks((msg) => app.log.warn(msg))

  // 7) Static file serving (in production when WEB_DIST is set)
  if (env.webDist) {
    const webRoot = env.webDist
    await app.register(import('@fastify/static'), {
      root: webRoot,
      wildcard: false,
      // Hashed build output immutable, SPA shell revalidated (docs/adr/0752-*).
      cacheControl: false,
      // @fastify/static 10: setHeaders receives the FastifyReply (was raw ServerResponse in 8.x).
      setHeaders: (reply, filePath) => {
        reply.header('Cache-Control', staticCacheControl(path.relative(webRoot, filePath)))
      },
    })
  }

  // 5) Global error handler
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      if (err.retryAfter) reply.header('Retry-After', String(err.retryAfter))
      return reply
        .code(err.status)
        .send({ error: { ...(err.details ?? {}), code: err.code, message: err.message } })
    }
    if (err instanceof ZodError) {
      const issue = err.issues[0]
      const at = issue?.path.join('.') ?? ''
      const message = issue ? `${at}: ${issue.message}` : 'Validation failed'
      return reply.code(400).send({ error: { code: 'VALIDATION', message } })
    }
    const statusCode = (err as { statusCode?: number }).statusCode
    const code = (err as { code?: string }).code
    if (statusCode === 413 || code === 'FST_REQ_FILE_TOO_LARGE') {
      return reply.code(413).send({
        error: { code: 'PAYLOAD_TOO_LARGE', message: 'File is too large (max 25MB)' },
      })
    }
    if (statusCode === 415) {
      return reply
        .code(415)
        .send({ error: { code: 'UNSUPPORTED_TYPE', message: 'Unsupported media type' } })
    }
    // Explicit 4xx Fastify errors (e.g. a malformed JSON body) keep their status instead of becoming 500
    if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
      return reply
        .code(statusCode)
        .send({ error: { code: 'BAD_REQUEST', message: 'Invalid request' } })
    }
    req.log.error(err)
    return reply
      .code(500)
      .send({ error: { code: 'INTERNAL', message: 'Internal server error' } })
  })

  // 404 / SPA fallback
  app.setNotFoundHandler((req, reply) => {
    // A missing hashed asset (old tab after a deploy) must be a 404, not the SPA shell served as
    // JavaScript — the client then reloads instead of failing on HTML (P-web request).
    const pathname = req.url.split('?')[0]
    const missingAsset = pathname.startsWith('/assets/')
    if (env.webDist && req.method === 'GET' && !isReservedPath(req.url) && !missingAsset) {
      return reply.sendFile('index.html')
    }
    return reply
      .code(404)
      .send({ error: { code: 'NOT_FOUND', message: 'The requested resource was not found' } })
  })

  // 6) Routes: /api group + /files/:id + /api/health
  await app.register(
    async (api) => {
      // API responses: private + no-store by default, content ETag on GET JSON (ADR 0752).
      registerApiCachePolicy(api)
      // X-Inkling-Build on every /api response + GET /api/version (docs/adr/0990-*). First, so the header hook covers every route.
      registerVersionRoutes(api)
      // Health checks run every 10–30 s and would dominate the request log, so they are not logged.
      api.get('/health', { logLevel: 'silent' }, async () => ({ ok: true }))
      // Readiness (B-M5): 503 while the database is unreachable. /health stays pure liveness so
      // a DB outage does not make the orchestrator restart a healthy process in a loop.
      api.get('/health/ready', { logLevel: 'silent' }, async (_req, reply) => {
        const ok = await databaseReady()
        return reply.code(ok ? 200 : 503).send({ ok, db: ok })
      })
      await registerAuthRoutes(api)
      await registerAdminRoutes(api)
      await registerWorkspaceRoutes(api)
      await registerWorkspaceAdminRoutes(api)
      await registerPageRoutes(api)
      await registerPageContentRoutes(api)
      // Edit lock and agent instruction pages (docs/adr/0970-*, 0975-*)
      await registerEditLockRoutes(api)
      // Agent retrieval: find_context, outline/section, batch read, section patch (docs/adr/0926-0930)
      await registerContextRoutes(api)
      // Change feed for agents: changes_since (docs/adr/0932-*)
      await registerChangeRoutes(api)
      await registerTaskRoutes(api)
      await registerSnapshotRoutes(api)
      await registerInkRoutes(api)
      await registerTemplateRoutes(api)
      await registerCollectionRoutes(api)
      await registerIcalApiRoutes(api)
      await registerExportImportRoutes(api)
      await registerNotionRoutes(api)
      await registerBookmarkRoutes(api)
      await registerCommentRoutes(api)
      await registerNotificationRoutes(api)
      await registerFileRoutes(api)
      // Public web sharing (M15): unauthenticated. No session/membership preHandler, only the token + scope gate.
      await registerPublicRoutes(api)
      // MCP connector consent screen and connected-app management (session cookie only)
      await registerOAuthApiRoutes(api)
      // Plugin API v0 (experimental: plugins) — docs/PLUGINS.md
      if (isExperimentalEnabled('plugins')) await registerPluginRoutes(api)
      // Dataview-style Query block (stable) — docs/QUERY.md
      await registerQueryRoutes(api)
      // Obsidian vault two-way sync (experimental: vault-sync) — docs/adr/0200-*
      if (isExperimentalEnabled('vault-sync')) await registerSyncRoutes(api)
      // Link preview cards + workspace Slack/Discord webhooks (stable) — docs/adr/0502-*, 0504-*
      await registerLinkPreviewRoutes(api)
      await registerWebhookRoutes(api)
      // Admin → Backups status, trigger and download (sidecar-based) — docs/BACKUP.md
      await registerBackupRoutes(api)
    },
    { prefix: '/api' },
  )
  // MCP remote connector: OAuth 2.1 metadata/registration/token + /mcp (CORS and the form parser are scoped here)
  await app.register(async (pub) => {
    registerApiCachePolicy(pub)
    await registerOAuthRoutes(pub)
    await registerMcpRoutes(pub, app)
  })
  await registerFileDownloadRoute(app)
  // iCal subscription feed /ical/<token>.ics (token-authenticated, outside /api)
  await registerIcalFeedRoute(app)
  // Open Graph meta for public share links /s/:token (only when WEB_DIST is set) — docs/adr/0503-*
  await registerShareMetaRoutes(app)

  // 8) Listen
  await app.listen({ port: env.port, host: '0.0.0.0' })

  // 9) Hocuspocus collaboration upgrade connections
  attachCollab(app.server)

  // 9.5) Background body-text backfill (pages with page_docs but no page_texts)
  //      + global tag index backfill (extract #tags from page_docs without tag rows)
  void backfillPageTexts((msg) => app.log.info(msg))
  void backfillPageTags((msg) => app.log.info(msg))
  //      + dated tasks inside documents (page_tasks): only documents without the marker, low priority
  void backfillPageTasks((msg) => app.log.info(msg))
  //      + section index for agent retrieval (page_chunks, docs/adr/0926-*): pages without a current
  //        marker, 50 per batch with event-loop yields, at most 50k pages per boot
  void backfillPageChunks((msg) => app.log.info(msg))

  // 9.6) M17 due-date reminder scheduler: one delayed scan after boot + a rescan every hour.
  //      shutdown calls stop to clear the timer.
  stopReminders = startReminderScheduler((msg) => app.log.info(msg))
  // Page read counters: flushed every minute (docs/adr/0953-*)
  stopReadFlusher = startReadFlusher((msg) => app.log.info(msg))

  // 10) Boot summary (B-M6, C-M10)
  const flags = enabledExperimentalFeatures()
  app.log.info(`[inkling] experimental features: ${flags.length ? flags.join(', ') : '(none)'}`)
  app.log.info(
    `[inkling] signup key required: ${env.signupRequireKey ? 'yes' : 'no'}, mail: ${mailEnabled ? 'on' : 'off'}, ` +
      `public origin: ${env.publicUrl ?? env.appUrl ?? '(request host — set PUBLIC_URL)'}, secure cookies: ${env.cookieSecure ? 'yes' : 'no'}`,
  )
  if (env.signupRequireKey) {
    const any = await db.select({ id: users.id }).from(users).limit(1)
    if (any.length === 0) {
      app.log.warn(
        '[inkling] no accounts yet and signups need a key: create the first admin key with ' +
          '`deploy/signup-key.sh` (the first account to sign up becomes admin).',
      )
    }
  }
}

main().catch((err) => {
  console.error('[inkling] Boot failed', err)
  if (shutdownStarted) return
  process.exit(1)
})
