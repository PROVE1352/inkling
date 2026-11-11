import { createHash } from 'node:crypto'
import type { FastifyRequest } from 'fastify'
import { API_TOKEN_PREFIX } from '@inkling/shared'
import { ipPrefixKey } from './ipPrefix'

/**
 * Key for the global request rate limit (index.ts). A personal API token gets its own bucket
 * (docs/adr/1201-*): scripts on one machine or behind one NAT do not share a budget with the browser,
 * and a busy token cannot exhaust its owner's IP for others. The key is a hash prefix, so the raw
 * token never sits in limiter memory. The limiter runs on onRequest, before the token is looked up:
 * an invalid token also gets a bucket, but answers 401 and counts as a failure for the IP ban
 * (auth.ts), which then refuses every token-shaped request from that IP. Everything else: the IP,
 * an IPv6 address as its /64 (0.22 security fix F6, docs/adr/2537-*: one subscriber holds at least a
 * /64, so a full-address key gave each of its addresses a budget) and an IPv4-mapped one as IPv4.
 */
export function rateLimitKey(req: FastifyRequest): string {
  const h = req.headers.authorization
  if (typeof h === 'string') {
    const m = /^Bearer\s+(\S+)\s*$/i.exec(h.trim())
    if (m && m[1].startsWith(API_TOKEN_PREFIX)) {
      return 'pat:' + createHash('sha256').update(m[1]).digest('base64url').slice(0, 22)
    }
  }
  return ipPrefixKey(req.ip, 64)
}
