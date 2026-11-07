import type { IncomingHttpHeaders } from 'node:http'
import type { FastifyInstance } from 'fastify'
import { env } from './env'
import { AppError } from './errors'

/**
 * Cross-site request refusal (C-L4, docs/adr/1062-*).
 *
 * State-changing requests (anything but GET/HEAD/OPTIONS) under /api and the /collab WebSocket
 * upgrade must come from the site's own origin. Browsers always send `Origin` on such requests and
 * on WebSocket handshakes, so:
 *
 *   - `Authorization` present            → skip (bearer clients carry no ambient credential; a
 *                                           cross-site page cannot set the header without a CORS
 *                                           preflight, which /api never grants)
 *   - `Origin` (else `Referer`) present  → must equal an allowed origin, else 403
 *   - `Origin: null`                     → 403 (opaque origin: sandboxed frame, privacy redirect)
 *   - `Sec-Fetch-Site: cross-site`       → 403
 *   - neither header                     → allowed: not a browser (inklingctl, curl, scripts)
 *
 * Allowed origins: PUBLIC_URL and APP_URL. With neither set (development without mail, where
 * origin.ts already falls back to the request host), the origin must match the request `Host`, and
 * any loopback origin is accepted on a loopback host (the Vite dev proxy rewrites Host to
 * localhost:3001 while the browser sends Origin http://localhost:5173). A loopback PUBLIC_URL
 * likewise accepts any loopback origin.
 *
 * /oauth/token, /oauth/register and /mcp are outside /api and are not checked: non-browser MCP
 * clients call them cross-origin by design. SameSite=Lax on the session cookie stays as the first
 * layer; this check also covers sibling subdomains, which Lax treats as same-site.
 */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

function originOf(url: string): string | null {
  try {
    const u = new URL(url)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return u.origin
  } catch {
    return null
  }
}

/** Configured origins (PUBLIC_URL, APP_URL), normalized; empty when neither is set. */
export function configuredOrigins(): string[] {
  const out = new Set<string>()
  for (const v of [env.publicUrl, env.appUrl]) {
    const o = v ? originOf(v) : null
    if (o) out.add(o)
  }
  return [...out]
}

function isLoopbackHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127\.\d+\.\d+\.\d+$/.test(h)
}

function hostnameOf(host: string): string {
  // "[::1]:3001" → "[::1]", "localhost:3001" → "localhost"
  if (host.startsWith('[')) return host.slice(0, host.indexOf(']') + 1)
  return host.split(':')[0]
}

export type OriginVerdict = { ok: true } | { ok: false; reason: string }

/**
 * Decide whether a request's browser origin is acceptable. Pure (unit-tested): `allowed` empty
 * means "not configured", then `requestHost` (the Host header) is the reference.
 */
export function checkRequestOrigin(
  headers: IncomingHttpHeaders,
  allowed: string[],
  requestHost: string | undefined,
): OriginVerdict {
  const fetchSite = headerValue(headers['sec-fetch-site'])
  if (fetchSite === 'cross-site') return { ok: false, reason: 'cross-site' }

  const originHeader = headerValue(headers.origin)
  let origin: string | null
  if (originHeader !== undefined) {
    if (originHeader === 'null') return { ok: false, reason: 'opaque origin' }
    origin = originOf(originHeader)
    if (!origin) return { ok: false, reason: 'malformed origin' }
  } else {
    const referer = headerValue(headers.referer)
    if (referer === undefined) return { ok: true } // not a browser
    origin = originOf(referer)
    if (!origin) return { ok: false, reason: 'malformed referer' }
  }

  const o = new URL(origin)
  if (allowed.length > 0) {
    if (allowed.includes(origin)) return { ok: true }
    // A loopback PUBLIC_URL (local development) also accepts the other loopback ports (Vite).
    if (isLoopbackHost(o.hostname) && allowed.some((a) => isLoopbackHost(new URL(a).hostname))) return { ok: true }
    return { ok: false, reason: `origin ${origin}` }
  }
  // Not configured: compare with the request's own Host.
  if (!requestHost) return { ok: false, reason: 'no host' }
  if (o.host.toLowerCase() === requestHost.toLowerCase()) return { ok: true }
  if (isLoopbackHost(o.hostname) && isLoopbackHost(hostnameOf(requestHost))) return { ok: true }
  return { ok: false, reason: `origin ${origin}` }
}

function headerValue(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0]
  return v === undefined || v === '' ? undefined : v
}

export const crossSiteRefused = () =>
  new AppError(403, 'CROSS_SITE_REQUEST', 'Cross-site request refused. Open Inkling at its own address and try again.')

/**
 * onRequest hook for the /api scope: refuses state-changing browser requests from another origin.
 * Register it inside the `/api` plugin so it never sees /oauth/token, /oauth/register or /mcp.
 */
export function registerOriginCheck(api: FastifyInstance): void {
  api.addHook('onRequest', async (req) => {
    if (SAFE_METHODS.has(req.method)) return
    if (req.headers.authorization) return
    const verdict = checkRequestOrigin(req.headers, configuredOrigins(), req.headers.host)
    if (!verdict.ok) {
      req.log.warn(`[csrf] refused ${req.method} ${req.routeOptions?.url ?? '(no route)'}: ${verdict.reason}`)
      throw crossSiteRefused()
    }
  })
}

/** Same rule for the /collab WebSocket upgrade (raw Node request headers). */
export function upgradeOriginAllowed(headers: IncomingHttpHeaders): OriginVerdict {
  return checkRequestOrigin(headers, configuredOrigins(), headerValue(headers.host))
}
