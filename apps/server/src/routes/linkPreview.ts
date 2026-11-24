import type { FastifyInstance, FastifyRequest } from 'fastify'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { getUser, requireUser, SESSION_COOKIE } from '../auth'
import { rateLimitKey } from '../rateLimitKey'
import { AppError } from '../errors'
import { getLinkPreview } from '../linkPreview'
import { SafeFetchError } from '../safeFetch'

const querySchema = z.object({ url: z.string().min(1).max(2048) })

/**
 * Per-session limiter key. The rate-limit hook runs on onRequest (before requireUser), so the
 * user id is not resolved yet; the session cookie identifies the browser session instead
 * (hashed so the raw token never lands in limiter memory). Falls back to the client IP.
 * A request with an Authorization header is keyed by rateLimitKey (the API token, else the IP), never
 * by its cookie: auth.ts reads the bearer first, so a cookie sent beside it would only pick a fresh
 * bucket per request.
 */
export function sessionKey(req: FastifyRequest): string {
  if (req.headers.authorization !== undefined) return 'lp-' + rateLimitKey(req)
  const sid = (req.cookies as Record<string, string | undefined> | undefined)?.[SESSION_COOKIE]
  return sid ? 'lp:' + createHash('sha256').update(sid).digest('base64url').slice(0, 22) : 'lp-ip:' + req.ip
}

/** Link previews one account may ask for in a sliding minute, whatever credential or address it uses. */
export const PREVIEWS_PER_MINUTE = 30
const recent = new Map<string, number[]>()

/**
 * The per-account count, in the handler once the person is known: the route's own limit is keyed by
 * the request (cookie, token or address), so several tokens, or a cookie with a non-bearer
 * Authorization header from changing IPv6 /64s, would each get a bucket of their own. In memory, per
 * process; throws 429 RATE_LIMITED before anything is fetched.
 */
export function takePreviewSlot(userId: string, now = Date.now()): void {
  const times = (recent.get(userId) ?? []).filter((t) => now - t < 60_000)
  if (times.length >= PREVIEWS_PER_MINUTE) {
    recent.set(userId, times)
    throw new AppError(429, 'RATE_LIMITED', 'Too many link previews in the last minute; try again shortly')
  }
  times.push(now)
  recent.set(userId, times)
}

// Old entries go once a minute, so the map holds only people who asked recently.
setInterval(() => {
  const now = Date.now()
  for (const [k, v] of recent) {
    const keep = v.filter((t) => now - t < 60_000)
    if (keep.length) recent.set(k, keep)
    else recent.delete(k)
  }
}, 60_000).unref()

/** Test hook. */
export function _resetPreviewSlots(): void {
  recent.clear()
}

export async function registerLinkPreviewRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/link-preview?url= — Open Graph / title / description / favicon of an external page.
  // Login required. The server fetch goes through safeFetch (SSRF guard). Failures return 422
  // with a generic message so the endpoint cannot be used as an internal-network oracle.
  app.get(
    '/link-preview',
    {
      preHandler: requireUser,
      config: { rateLimit: { max: PREVIEWS_PER_MINUTE, timeWindow: '1 minute', keyGenerator: sessionKey } },
    },
    async (req, reply) => {
      const { url } = querySchema.parse(req.query)
      takePreviewSlot(getUser(req).id)
      let preview
      try {
        preview = await getLinkPreview(url)
      } catch (e) {
        if (e instanceof SafeFetchError) preview = null
        else throw e
      }
      if (!preview) throw new AppError(422, 'PREVIEW_UNAVAILABLE', 'No preview available for this link')
      // Browser-side cache keeps re-renders of the same card from hitting the limiter.
      reply.header('Cache-Control', 'private, max-age=3600')
      return { preview }
    },
  )
}
