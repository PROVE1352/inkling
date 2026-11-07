import type { FastifyInstance, FastifyRequest } from 'fastify'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { requireUser, SESSION_COOKIE } from '../auth'
import { AppError } from '../errors'
import { getLinkPreview } from '../linkPreview'
import { SafeFetchError } from '../safeFetch'

const querySchema = z.object({ url: z.string().min(1).max(2048) })

/**
 * Per-session limiter key. The rate-limit hook runs on onRequest (before requireUser), so the
 * user id is not resolved yet; the session cookie identifies the browser session instead
 * (hashed so the raw token never lands in limiter memory). Falls back to the client IP.
 */
function sessionKey(req: FastifyRequest): string {
  const sid = (req.cookies as Record<string, string | undefined> | undefined)?.[SESSION_COOKIE]
  return sid ? 'lp:' + createHash('sha256').update(sid).digest('base64url').slice(0, 22) : 'lp-ip:' + req.ip
}

export async function registerLinkPreviewRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/link-preview?url= — Open Graph / title / description / favicon of an external page.
  // Login required. The server fetch goes through safeFetch (SSRF guard). Failures return 422
  // with a generic message so the endpoint cannot be used as an internal-network oracle.
  app.get(
    '/link-preview',
    {
      preHandler: requireUser,
      config: { rateLimit: { max: 30, timeWindow: '1 minute', keyGenerator: sessionKey } },
    },
    async (req, reply) => {
      const { url } = querySchema.parse(req.query)
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
