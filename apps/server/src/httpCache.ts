import { createHash } from 'node:crypto'
import path from 'node:path'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

/**
 * HTTP caching policy (docs/adr/0752-*).
 *
 *  - Static SPA files: content-hashed build output is immutable for a year; the shell
 *    (index.html, sw.js, registerSW.js, manifest) must always revalidate so a deploy is picked
 *    up; other public files (icons) get a day.
 *  - API: every response is `private` (never stored by a shared cache/proxy) and `no-store`
 *    unless the route chose otherwise. GET JSON responses get a content-hash weak ETag with
 *    `private, no-cache`, so the browser revalidates and an unchanged body costs a 304.
 *    Routes that can validate *before* doing the work (collections) set their own ETag.
 */

/** Matches an If-None-Match header against one ETag (weak comparison, list and `*` aware). */
export function ifNoneMatch(header: string | string[] | undefined, etag: string): boolean {
  if (!header) return false
  const raw = Array.isArray(header) ? header.join(',') : header
  const bare = etag.replace(/^W\//, '')
  return raw.split(',').some((t) => {
    const v = t.trim()
    return v === '*' || v.replace(/^W\//, '') === bare
  })
}

const HASHED_ASSET = /^assets\/|^workbox-[0-9a-f]{6,}\.js$/
const SHELL_FILES = new Set(['index.html', 'sw.js', 'registerSW.js', 'manifest.webmanifest'])

/** @fastify/static setHeaders: Cache-Control by file role. `rel` is relative to WEB_DIST. */
export function staticCacheControl(rel: string): string {
  const p = rel.split(path.sep).join('/').replace(/^\/+/, '')
  if (HASHED_ASSET.test(p)) return 'public, max-age=31536000, immutable'
  if (SHELL_FILES.has(p) || p.endsWith('.html')) return 'no-cache'
  return 'public, max-age=86400'
}

/**
 * Validates a conditional GET *before* the route does its work. `parts` must cover everything
 * the response depends on (viewer, workspace version, index epoch, date, query string).
 * Sets ETag + `private, no-cache`; returns true when a 304 was sent (the handler must return).
 */
export function precheckEtag(
  req: FastifyRequest,
  reply: FastifyReply,
  parts: (string | number)[],
): boolean {
  const h = createHash('sha1').update(`${req.url}|${parts.join('|')}`).digest('base64url')
  const etag = `W/"v-${h}"`
  reply.header('Cache-Control', 'private, no-cache')
  reply.header('ETag', etag)
  if (ifNoneMatch(req.headers['if-none-match'], etag)) {
    void reply.code(304).send()
    return true
  }
  return false
}

/** Below this size hashing costs more than the transfer it could save. */
const ETAG_MIN_BYTES = 1024

/** Registers the API cache policy on an encapsulated scope (the /api prefix, /mcp, /oauth). */
export function registerApiCachePolicy(app: FastifyInstance): void {
  app.addHook('onSend', async (req: FastifyRequest, reply: FastifyReply, payload: unknown) => {
    if (reply.hasHeader('cache-control')) return payload
    const status = reply.statusCode
    const isJson = String(reply.getHeader('content-type') ?? '').startsWith('application/json')
    if (
      req.method === 'GET' &&
      status === 200 &&
      isJson &&
      !reply.hasHeader('etag') &&
      (typeof payload === 'string' || Buffer.isBuffer(payload)) &&
      payload.length >= ETAG_MIN_BYTES
    ) {
      const etag = `W/"${createHash('sha1').update(payload).digest('base64url')}"`
      reply.header('ETag', etag)
      reply.header('Cache-Control', 'private, no-cache')
      if (ifNoneMatch(req.headers['if-none-match'], etag)) {
        reply.code(304)
        reply.removeHeader('content-length')
        return ''
      }
      return payload
    }
    reply.header('Cache-Control', 'private, no-store')
    return payload
  })
}
