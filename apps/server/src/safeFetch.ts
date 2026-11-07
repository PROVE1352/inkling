/**
 * safeFetch — the single entry point for server-side requests to user-supplied URLs.
 *
 * Every outbound fetch whose target is influenced by a user (link previews, webhooks,
 * imports by URL, ...) MUST go through this module. It defends against SSRF:
 *
 *  - scheme allowlist (https only; http opt-in), no credentials in the URL
 *  - port allowlist (default 80/443)
 *  - optional host allowlist (exact host or "*.suffix")
 *  - DNS is resolved up front and EVERY returned address must be public
 *    (loopback, private, link-local, CGNAT, multicast, reserved, IPv6 ULA,
 *    IPv4-mapped/compatible/NAT64/6to4/Teredo embeddings are all rejected)
 *  - the connection is pinned to the validated IP (custom `lookup`), so a second
 *    DNS answer cannot rebind the socket to an internal address
 *  - redirects are followed manually (max 3 by default) and each hop is re-validated
 *  - connect timeout + total deadline, streaming response-size cap, content-type check
 *
 * See docs/adr/0500-safe-fetch-ssrf-guard.md.
 */
import dns from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import type { LookupFunction } from 'node:net'

export type SafeFetchErrorCode =
  | 'invalid_url'
  | 'scheme_not_allowed'
  | 'credentials_in_url'
  | 'port_not_allowed'
  | 'host_not_allowed'
  | 'blocked_address'
  | 'dns_failed'
  | 'too_many_redirects'
  | 'timeout'
  | 'too_large'
  | 'content_type'
  | 'network'

export class SafeFetchError extends Error {
  constructor(
    public readonly code: SafeFetchErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'SafeFetchError'
  }
}

export interface SafeFetchOptions {
  method?: 'GET' | 'HEAD' | 'POST'
  headers?: Record<string, string>
  /** Request body (POST only). Redirects are never followed for requests with a body. */
  body?: string | Buffer
  /** Allow plain http:// (default false → https only). */
  allowHttp?: boolean
  /** Allowed ports. Default: [80, 443] (80 only matters with allowHttp). */
  allowedPorts?: number[]
  /**
   * Optional host allowlist. Entries are exact hostnames ("hooks.slack.com") or
   * wildcard suffixes ("*.example.com", matches sub-domains only). Checked on every hop.
   */
  allowedHosts?: string[]
  /** Optional path-prefix check applied together with allowedHosts (every hop). */
  allowedPathPrefixes?: string[]
  /** Max redirects to follow (default 3). 0 = return the 3xx response as is. */
  maxRedirects?: number
  /** Socket connect timeout in ms (default 3000). */
  connectTimeoutMs?: number
  /** Whole-operation deadline including redirects and body (default 8000). */
  timeoutMs?: number
  /** Response body cap in bytes (default 1 MiB). */
  maxBytes?: number
  /**
   * When the body exceeds maxBytes: false (default) → throw 'too_large';
   * true → stop reading and return the first maxBytes bytes with truncated=true.
   */
  truncate?: boolean
  /**
   * Accepted response content types (prefix match on the media type, case-insensitive,
   * e.g. ["text/html", "application/xhtml+xml"]). Checked before reading the body
   * for 2xx responses. Omit to accept anything.
   */
  allowedContentTypes?: string[]
  /** External abort signal. */
  signal?: AbortSignal
  /**
   * TEST ONLY: additionally permit loopback addresses (127.0.0.0/8, ::1) and http.
   * Ignored unless NODE_ENV !== 'production'. Callers must gate this behind an explicit
   * test-mode env flag; it exists only so smoke tests can use a local fake receiver.
   */
  unsafeAllowLoopbackForTests?: boolean
}

export interface SafeFetchResponse {
  status: number
  headers: http.IncomingHttpHeaders
  /** Final URL after redirects. */
  url: string
  /** Lower-cased media type without parameters ('' if absent). */
  contentType: string
  body: Buffer
  truncated: boolean
  /** Number of redirects followed. */
  redirects: number
}

const DEFAULT_PORTS = [80, 443]
const DEFAULT_UA = 'Mozilla/5.0 (compatible; InklingBot/1.0)'

// ---------------------------------------------------------------------------
// Address classification
// ---------------------------------------------------------------------------

const blockedV4 = new net.BlockList()
for (const [addr, prefix] of [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // RFC1918
  ['100.64.0.0', 10], // CGNAT (RFC6598)
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local (cloud metadata 169.254.169.254)
  ['172.16.0.0', 12], // RFC1918
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16], // RFC1918
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + broadcast
] as const) {
  blockedV4.addSubnet(addr, prefix, 'ipv4')
}

const blockedV6 = new net.BlockList()
for (const [addr, prefix] of [
  ['::', 96], // unspecified, ::1 loopback, IPv4-compatible (deprecated)
  ['::ffff:0:0', 96], // IPv4-mapped (embedded v4 is checked separately, but never connect)
  ['64:ff9b::', 96], // NAT64 well-known prefix
  ['64:ff9b:1::', 48], // local-use NAT64
  ['100::', 64], // discard-only
  ['2001::', 23], // IETF protocol assignments (incl. Teredo 2001::/32)
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4 (embeds IPv4)
  ['fc00::', 7], // unique local (ULA)
  ['fe80::', 10], // link-local
  ['fec0::', 10], // site-local (deprecated)
  ['ff00::', 8], // multicast
] as const) {
  blockedV6.addSubnet(addr, prefix, 'ipv6')
}

/** Expand an IPv6 literal into 8 numeric groups (handles "::" and a dotted v4 tail). */
function ipv6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase()
  const pct = s.indexOf('%')
  if (pct >= 0) s = s.slice(0, pct)
  // Rewrite a dotted IPv4 tail ("::ffff:1.2.3.4") as two hex groups first.
  const lastColon = s.lastIndexOf(':')
  const maybeV4 = s.slice(lastColon + 1)
  if (maybeV4.includes('.')) {
    if (!net.isIPv4(maybeV4)) return null
    const o = maybeV4.split('.').map(Number)
    s = s.slice(0, lastColon + 1) + ((o[0] << 8) | o[1]).toString(16) + ':' + ((o[2] << 8) | o[3]).toString(16)
  }
  const parts = s.split('::')
  if (parts.length > 2) return null
  const head = parts[0] ? parts[0].split(':') : []
  const rest = parts.length === 2 && parts[1] ? parts[1].split(':') : []
  let groups: string[]
  if (parts.length === 2) {
    const fill = 8 - head.length - rest.length
    if (fill < 1) return null
    groups = [...head, ...Array<string>(fill).fill('0'), ...rest]
  } else {
    groups = head
  }
  if (groups.length !== 8) return null
  const nums = groups.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN))
  if (nums.some((n) => !Number.isFinite(n))) return null
  return nums
}

/** If an IPv6 address embeds an IPv4 address (mapped, compatible, NAT64, 6to4), return it. */
export function embeddedIPv4(ip: string): string | null {
  const g = ipv6Groups(ip)
  if (!g) return null
  const v4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`
  const zeros = (n: number) => g.slice(0, n).every((x) => x === 0)
  // ::ffff:a.b.c.d (mapped) and ::ffff:0:a.b.c.d (SIIT translated)
  if (zeros(5) && g[5] === 0xffff) return v4(g[6], g[7])
  if (zeros(4) && g[4] === 0xffff && g[5] === 0) return v4(g[6], g[7])
  // ::a.b.c.d (compatible)
  if (zeros(6)) return v4(g[6], g[7])
  // 64:ff9b::a.b.c.d (NAT64)
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return v4(g[6], g[7])
  // 2002:AABB:CCDD::/48 (6to4)
  if (g[0] === 0x2002) return v4(g[1], g[2])
  return null
}

function isLoopback(ip: string): boolean {
  if (net.isIPv4(ip)) return ip.startsWith('127.')
  const g = ipv6Groups(ip)
  if (!g) return false
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true
  const v4 = embeddedIPv4(ip)
  return !!v4 && v4.startsWith('127.') && g[5] === 0xffff
}

/**
 * True when the IP literal is NOT a globally routable unicast address and therefore
 * must never be contacted. Unparseable input is treated as blocked.
 */
export function isBlockedAddress(ip: string): boolean {
  const family = net.isIP(ip)
  if (family === 4) return blockedV4.check(ip, 'ipv4')
  if (family === 6) {
    const v4 = embeddedIPv4(ip)
    if (v4 && blockedV4.check(v4, 'ipv4')) return true
    const stripped = ip.split('%')[0]
    return blockedV6.check(stripped, 'ipv6')
  }
  return true
}

// ---------------------------------------------------------------------------
// URL / host validation
// ---------------------------------------------------------------------------

function hostMatches(host: string, pattern: string): boolean {
  const p = pattern.toLowerCase()
  if (p.startsWith('*.')) return host.endsWith(p.slice(1)) && host.length > p.length - 1
  return host === p
}

function testLoopbackAllowed(opts: SafeFetchOptions): boolean {
  return !!opts.unsafeAllowLoopbackForTests && process.env.NODE_ENV !== 'production'
}

/** Synchronous checks on a URL (scheme, credentials, port, host allowlist, literal IPs). */
export function validateUrl(raw: string | URL, opts: SafeFetchOptions = {}): URL {
  let u: URL
  try {
    // WHATWG parsing normalises decimal/octal/hex IPv4 forms ("2130706433", "0x7f.1")
    u = typeof raw === 'string' ? new URL(raw) : new URL(raw.href)
  } catch {
    throw new SafeFetchError('invalid_url', 'Invalid URL')
  }
  const testLoop = testLoopbackAllowed(opts)
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && (opts.allowHttp || testLoop))) {
    throw new SafeFetchError('scheme_not_allowed', `Scheme ${u.protocol} is not allowed`)
  }
  if (u.username || u.password) {
    throw new SafeFetchError('credentials_in_url', 'Credentials in URL are not allowed')
  }
  const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80
  const ports = opts.allowedPorts ?? DEFAULT_PORTS
  const host = hostnameOf(u)
  const literal = net.isIP(host) !== 0
  if (!ports.includes(port) && !(testLoop && literal && isLoopback(host))) {
    throw new SafeFetchError('port_not_allowed', `Port ${port} is not allowed`)
  }
  if (!host) throw new SafeFetchError('invalid_url', 'Missing host')
  if (opts.allowedHosts && opts.allowedHosts.length > 0) {
    const okHost = opts.allowedHosts.some((p) => hostMatches(host, p))
    if (!okHost && !(testLoop && literal && isLoopback(host))) {
      throw new SafeFetchError('host_not_allowed', 'Host is not in the allowlist')
    }
    if (okHost && opts.allowedPathPrefixes && opts.allowedPathPrefixes.length > 0) {
      if (!opts.allowedPathPrefixes.some((p) => u.pathname.startsWith(p))) {
        throw new SafeFetchError('host_not_allowed', 'Path is not in the allowlist')
      }
    }
  }
  if (host === 'localhost' || host.endsWith('.localhost')) {
    if (!testLoop) throw new SafeFetchError('blocked_address', 'Host resolves to a blocked address')
  }
  if (literal && isBlockedAddress(host) && !(testLoop && isLoopback(host))) {
    throw new SafeFetchError('blocked_address', 'Host resolves to a blocked address')
  }
  return u
}

/** URL.hostname with IPv6 brackets removed and trailing dot stripped, lower-cased. */
function hostnameOf(u: URL): string {
  let h = u.hostname.toLowerCase()
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1)
  if (h.endsWith('.')) h = h.slice(0, -1)
  return h
}

interface Resolved {
  address: string
  family: 4 | 6
}

/** Resolve a hostname and require every answer to be a public address. */
export async function resolvePublic(host: string, opts: SafeFetchOptions = {}): Promise<Resolved> {
  const testLoop = testLoopbackAllowed(opts)
  const fam = net.isIP(host)
  if (fam) {
    if (isBlockedAddress(host) && !(testLoop && isLoopback(host))) {
      throw new SafeFetchError('blocked_address', 'Host resolves to a blocked address')
    }
    return { address: host, family: fam as 4 | 6 }
  }
  let addrs: dns.LookupAddress[]
  try {
    addrs = await dns.promises.lookup(host, { all: true, order: 'verbatim' })
  } catch {
    throw new SafeFetchError('dns_failed', 'Could not resolve host')
  }
  if (addrs.length === 0) throw new SafeFetchError('dns_failed', 'Could not resolve host')
  // Reject if ANY answer is internal: a mixed answer set is a classic rebinding setup.
  for (const a of addrs) {
    if (isBlockedAddress(a.address) && !(testLoop && isLoopback(a.address))) {
      throw new SafeFetchError('blocked_address', 'Host resolves to a blocked address')
    }
  }
  const pick = addrs.find((a) => a.family === 4) ?? addrs[0]
  return { address: pick.address, family: pick.family as 4 | 6 }
}

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

function pinnedLookup(pinned: Resolved): LookupFunction {
  return ((_hostname: string, options: dns.LookupOptions, cb: (...args: unknown[]) => void) => {
    if (options && options.all) cb(null, [{ address: pinned.address, family: pinned.family }])
    else cb(null, pinned.address, pinned.family)
  }) as unknown as LookupFunction
}

function mediaType(h: string | string[] | undefined): string {
  const v = Array.isArray(h) ? h[0] : h
  return (v ?? '').split(';')[0].trim().toLowerCase()
}

interface HopResult {
  status: number
  headers: http.IncomingHttpHeaders
  body: Buffer
  truncated: boolean
  contentType: string
}

function oneHop(
  u: URL,
  pinned: Resolved,
  opts: SafeFetchOptions,
  signal: AbortSignal,
  readBody: (status: number) => boolean,
): Promise<HopResult> {
  const maxBytes = opts.maxBytes ?? 1024 * 1024
  const connectTimeoutMs = opts.connectTimeoutMs ?? 3000
  const mod = u.protocol === 'https:' ? https : http
  const headers: Record<string, string> = {
    'user-agent': DEFAULT_UA,
    accept: '*/*',
    // No compression: the size cap then bounds memory exactly (no decompression bombs).
    'accept-encoding': 'identity',
  }
  for (const [k, v] of Object.entries(opts.headers ?? {})) headers[k.toLowerCase()] = v
  // The caller may not re-enable compression or override the framing headers.
  headers['accept-encoding'] = 'identity'
  delete headers['host']
  delete headers['transfer-encoding']
  if (opts.body !== undefined) headers['content-length'] = String(Buffer.byteLength(opts.body))

  return new Promise<HopResult>((resolve, reject) => {
    let settled = false
    const fail = (e: SafeFetchError) => {
      if (settled) return
      settled = true
      req.destroy()
      reject(e)
    }
    const req = mod.request(
      {
        protocol: u.protocol,
        hostname: hostnameOf(u),
        port: u.port || undefined,
        path: u.pathname + u.search,
        method: opts.method ?? 'GET',
        headers,
        agent: false,
        lookup: pinnedLookup(pinned),
        // SNI + certificate verification still use the real hostname.
        servername: net.isIP(hostnameOf(u)) ? undefined : hostnameOf(u),
        signal,
      },
      (res) => {
        const status = res.statusCode ?? 0
        const contentType = mediaType(res.headers['content-type'])
        // Second line of defence: the socket really is connected to the pinned address.
        const remote = res.socket?.remoteAddress
        if (remote && remote !== pinned.address && remote !== `::ffff:${pinned.address}`) {
          res.destroy()
          return fail(new SafeFetchError('blocked_address', 'Connected address mismatch'))
        }
        if (!readBody(status)) {
          res.resume()
          settled = true
          return resolve({ status, headers: res.headers, body: Buffer.alloc(0), truncated: false, contentType })
        }
        if (
          status >= 200 &&
          status < 300 &&
          opts.allowedContentTypes &&
          opts.allowedContentTypes.length > 0 &&
          !opts.allowedContentTypes.some((t) => contentType.startsWith(t.toLowerCase()))
        ) {
          res.destroy()
          return fail(new SafeFetchError('content_type', `Unexpected content type: ${contentType || 'none'}`))
        }
        const declared = Number(res.headers['content-length'])
        if (!opts.truncate && Number.isFinite(declared) && declared > maxBytes) {
          res.destroy()
          return fail(new SafeFetchError('too_large', 'Response too large'))
        }
        const chunks: Buffer[] = []
        let size = 0
        res.on('data', (chunk: Buffer) => {
          if (settled) return
          const room = maxBytes - size
          if (chunk.length > room) {
            if (!opts.truncate) {
              res.destroy()
              return fail(new SafeFetchError('too_large', 'Response too large'))
            }
            if (room > 0) chunks.push(chunk.subarray(0, room))
            size = maxBytes
            settled = true
            res.destroy()
            req.destroy()
            return resolve({ status, headers: res.headers, body: Buffer.concat(chunks), truncated: true, contentType })
          }
          chunks.push(chunk)
          size += chunk.length
        })
        res.on('end', () => {
          if (settled) return
          settled = true
          resolve({ status, headers: res.headers, body: Buffer.concat(chunks), truncated: false, contentType })
        })
        res.on('error', () => fail(new SafeFetchError('network', 'Response stream error')))
      },
    )
    req.on('socket', (sock) => {
      const t = setTimeout(() => fail(new SafeFetchError('timeout', 'Connect timeout')), connectTimeoutMs)
      const clear = () => clearTimeout(t)
      sock.once('connect', clear)
      sock.once('secureConnect', clear)
      sock.once('close', clear)
    })
    req.on('error', (err: NodeJS.ErrnoException) => {
      if (signal.aborted) return fail(new SafeFetchError('timeout', 'Request timed out'))
      fail(new SafeFetchError('network', `Request failed${err.code ? `: ${err.code}` : ''}`))
    })
    if (opts.body !== undefined) req.write(opts.body)
    req.end()
  })
}

/**
 * Fetch a user-influenced URL safely. Throws SafeFetchError for policy violations,
 * timeouts and network failures. Non-2xx statuses are returned, not thrown.
 */
export async function safeFetch(rawUrl: string | URL, opts: SafeFetchOptions = {}): Promise<SafeFetchResponse> {
  const timeoutMs = opts.timeoutMs ?? 8000
  const maxRedirects = opts.body !== undefined ? 0 : (opts.maxRedirects ?? 3)
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  const onOuterAbort = () => ctrl.abort()
  opts.signal?.addEventListener('abort', onOuterAbort, { once: true })
  try {
    let u = validateUrl(rawUrl, opts)
    for (let hop = 0; ; hop++) {
      if (ctrl.signal.aborted) throw new SafeFetchError('timeout', 'Request timed out')
      const pinned = await Promise.race([
        resolvePublic(hostnameOf(u), opts),
        new Promise<never>((_, rej) =>
          ctrl.signal.addEventListener('abort', () => rej(new SafeFetchError('timeout', 'Request timed out')), {
            once: true,
          }),
        ),
      ])
      const isRedirect = (s: number) => s >= 300 && s < 400 && s !== 304
      const res = await oneHop(u, pinned, opts, ctrl.signal, (s) => !(isRedirect(s) && maxRedirects > 0))
      if (isRedirect(res.status) && maxRedirects > 0) {
        const loc = res.headers.location
        if (!loc) return { ...res, url: u.href, redirects: hop }
        if (hop >= maxRedirects) throw new SafeFetchError('too_many_redirects', 'Too many redirects')
        let next: URL
        try {
          next = new URL(Array.isArray(loc) ? loc[0] : loc, u)
        } catch {
          throw new SafeFetchError('invalid_url', 'Invalid redirect location')
        }
        // https → http downgrade is only allowed when http is allowed at all.
        u = validateUrl(next, opts)
        continue
      }
      return { ...res, url: u.href, redirects: hop }
    }
  } catch (e) {
    if (e instanceof SafeFetchError) throw e
    if (ctrl.signal.aborted) throw new SafeFetchError('timeout', 'Request timed out')
    throw new SafeFetchError('network', 'Request failed')
  } finally {
    clearTimeout(timer)
    opts.signal?.removeEventListener('abort', onOuterAbort)
  }
}
