import { createHash } from 'node:crypto'
import type { FastifyRequest } from 'fastify'
import { API_TOKEN_PREFIX } from '@inkling/shared'

/**
 * Key for the global request rate limit (index.ts). A personal API token gets its own bucket
 * (docs/adr/1201-*): scripts on one machine or behind one NAT do not share a budget with the browser,
 * and a busy token cannot exhaust its owner's IP for others. The key is a hash prefix, so the raw
 * token never sits in limiter memory. The limiter runs on onRequest, before the token is looked up:
 * an invalid token also gets a bucket, but answers 401 and counts as a failure for the IP ban
 * (auth.ts), which then refuses every token-shaped request from that IP. Everything else: the IP.
 */
export function rateLimitKey(req: FastifyRequest): string {
  const h = req.headers.authorization
  if (typeof h === 'string') {
    const m = /^Bearer\s+(\S+)\s*$/i.exec(h.trim())
    if (m && m[1].startsWith(API_TOKEN_PREFIX)) {
      return 'pat:' + createHash('sha256').update(m[1]).digest('base64url').slice(0, 22)
    }
  }
  return req.ip
}
