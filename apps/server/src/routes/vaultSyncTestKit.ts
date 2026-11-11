/**
 * Test-only kit for the vault-sync readiness suites (vaultSyncReadiness / vaultSyncSecurity /
 * vaultSyncScale *.db.test.ts): a listening Fastify app with the routes `inklingctl sync` calls,
 * fault injection on chosen requests, and a runner for the real CLI (spawned through tsx).
 * Never imported by production code. Import it lazily inside a `[db]` suite: the route modules
 * open the database connection on import.
 */
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { ZodError } from 'zod'
import { AppError } from '../errors'

/**
 * Which request to break and how:
 *  - `before`: the connection is cut before the handler runs (nothing happened on the server);
 *  - `after`: the handler ran and committed, the response is lost (the client sees a network error);
 *  - `kill`: the handler ran and committed, then the CLI process is killed with SIGKILL (no state save).
 */
export interface Fault {
  mode: 'before' | 'after' | 'kill'
  /** 1-based index among the requests that `match` accepts. */
  nth: number
  match?: (method: string, url: string) => boolean
}

export interface SyncApp {
  app: FastifyInstance
  url: string
  /** every request the app saw, in order (method + url without query) */
  seen: { method: string; url: string }[]
  arm(f: Fault | null): void
  /** true once the armed fault fired */
  fired(): boolean
  /** true when a request cut in `before` mode still reached its handler (a broken harness) */
  leaked(): boolean
  /** the CLI process currently running (for `kill`) */
  setChild(c: ChildProcess | null): void
  close(): Promise<void>
}

export async function buildSyncApp(opts: { rateLimit?: boolean; extra?: (api: FastifyInstance) => Promise<void> } = {}): Promise<SyncApp> {
  const app = Fastify()
  await app.register(import('@fastify/cookie'))
  await app.register(import('@fastify/multipart'), { limits: { fileSize: 25 * 1024 * 1024, files: 300 } })
  if (opts.rateLimit) {
    // as index.ts registers it (global 300/min, per-route overrides, per-token keys)
    const { rateLimitKey } = await import('../rateLimitKey')
    await app.register(import('@fastify/rate-limit'), {
      global: true,
      max: 300,
      timeWindow: '1 minute',
      errorResponseBuilder: () => new AppError(429, 'RATE_LIMITED', 'Too many requests'),
      keyGenerator: rateLimitKey,
    })
  }
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

  const seen: { method: string; url: string }[] = []
  let fault: Fault | null = null
  let count = 0
  let didFire = false
  let child: ChildProcess | null = null
  let cut: object | null = null
  let leak = false
  const hit = (req: FastifyRequest): boolean => {
    if (!fault || didFire) return false
    const url = req.url.split('?')[0]
    if (fault.match && !fault.match(req.method, url)) return false
    count++
    return count === fault.nth
  }
  const marked = new WeakSet<object>()
  app.addHook('onRequest', async (req, reply) => {
    seen.push({ method: req.method, url: req.url.split('?')[0] })
    if (hit(req)) {
      if (fault!.mode === 'before') {
        // the handler never runs: the request is taken over and its connection cut
        didFire = true
        cut = req
        reply.hijack()
        req.raw.socket.destroy()
        return reply
      }
      marked.add(req)
    }
  })
  app.addHook('preHandler', async (req) => {
    if (req === cut) leak = true
  })
  app.addHook('onSend', async (req, _reply, payload) => {
    if (!marked.has(req)) return payload
    didFire = true
    if (fault!.mode === 'kill' && child) {
      child.kill('SIGKILL')
      await new Promise((r) => setTimeout(r, 50))
    }
    req.raw.socket.destroy()
    return payload
  })

  await app.register(
    async (api) => {
      await (await import('./workspaces')).registerWorkspaceRoutes(api)
      await (await import('./pages')).registerPageRoutes(api)
      await (await import('./pageContent')).registerPageContentRoutes(api)
      await (await import('./context')).registerContextRoutes(api)
      await (await import('./comments')).registerCommentRoutes(api)
      await (await import('./ink')).registerInkRoutes(api)
      await (await import('./editLock')).registerEditLockRoutes(api)
      await (await import('./apiTokens')).registerApiTokenRoutes(api)
      await (await import('./files')).registerFileRoutes(api)
      await (await import('./sync')).registerSyncRoutes(api)
      // restricted mode pieces, as index.ts registers them (docs/adr/2503-*)
      await (await import('../restricted')).registerRestrictedMode(api)
      if (opts.extra) await opts.extra(api)
    },
    { prefix: '/api' },
  )
  await (await import('./files')).registerFileDownloadRoute(app)
  await app.listen({ port: 0, host: '127.0.0.1' })
  const addr = app.server.address()
  const url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  return {
    app,
    url,
    seen,
    arm(f) {
      fault = f
      count = 0
      didFire = false
      cut = null
      leak = false
    },
    fired: () => didFire,
    leaked: () => leak,
    setChild(c) {
      child = c
    },
    close: () => app.close(),
  }
}

const require = createRequire(import.meta.url)
const tsxCli = require.resolve('tsx/cli')
const cliEntry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../cli/src/index.ts')

/** Runs the real CLI: `inklingctl sync <vault> --server … --workspace …` as the given credential. */
export function runSync(
  s: SyncApp,
  vault: string,
  o: { workspaceId: string; auth: string; home: string; args?: string[] },
): Promise<{ code: number | null; signal: string | null; out: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tsxCli, cliEntry, 'sync', vault, '--server', s.url, '--workspace', o.workspaceId, ...(o.args ?? [])], {
      env: { ...process.env, HOME: o.home, INKLING_TOKEN: o.auth },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    s.setChild(child)
    let out = ''
    child.stdout.on('data', (b) => (out += String(b)))
    child.stderr.on('data', (b) => (out += String(b)))
    child.on('error', reject)
    child.on('close', (code, signal) => {
      s.setChild(null)
      resolve({ code, signal, out })
    })
  })
}
