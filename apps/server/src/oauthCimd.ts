/**
 * OAuth Client ID Metadata Documents (CIMD, docs/adr/2280-* .. 2282-*): a client whose `client_id` is
 * an https URL is described by the JSON document at that URL (draft-ietf-oauth-client-id-metadata-
 * document-03; MCP authorization 2025-11-25). This module checks the URL, fetches the document
 * through safeFetch (SSRF guard, no redirects, 5 KiB, 5 s), validates it and keeps it in a small
 * in-memory cache. Routes in routes/oauth.ts decide what to do with the result.
 *
 * Off unless OAUTH_CIMD=1. OAUTH_CIMD_ALLOWED_HOSTS limits which client_id hosts are accepted
 * (exact host or "*.suffix"; empty = any public https host). OAUTH_CIMD_TEST_ALLOW_LOOPBACK=1
 * (ignored when NODE_ENV=production) lets tests serve documents from http://127.0.0.1.
 *
 * Single process: the cache, the fetch budget and the in-flight map live in this module (one
 * instance per deployment, like the other caches, docs/adr/0753-*).
 */
import { isAllowedRedirectUri, sanitizeClientName } from './oauth'
import { safeFetch, SafeFetchError } from './safeFetch'
import type { SafeFetchErrorCode } from './safeFetch'

// ---------------------------------------------------------------------------
// Configuration (read at call time so a test can switch it per case)
// ---------------------------------------------------------------------------

export interface CimdConfig {
  enabled: boolean
  /** Lower-cased host patterns (exact or "*.suffix"); empty = any host. */
  allowedHosts: string[]
  /** TEST ONLY: http and loopback document URLs (never when NODE_ENV=production). */
  testLoopback: boolean
}

export function cimdConfig(): CimdConfig {
  return {
    enabled: process.env.OAUTH_CIMD?.trim() === '1',
    allowedHosts: (process.env.OAUTH_CIMD_ALLOWED_HOSTS ?? '')
      .split(/[\s,]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    testLoopback: process.env.OAUTH_CIMD_TEST_ALLOW_LOOPBACK === '1' && process.env.NODE_ENV !== 'production',
  }
}

/** Limits (draft §10.11 recommends reading at most 5 kilobytes). */
export const CIMD_MAX_BYTES = 5 * 1024
export const CIMD_TIMEOUT_MS = 5_000
export const CIMD_MAX_URL_LENGTH = 2_000
/** Cache lifetime bounds (draft §6.2): floor, the value when the response names none, ceiling. */
export const CIMD_MIN_TTL_MS = 60_000
export const CIMD_DEFAULT_TTL_MS = 5 * 60_000
export const CIMD_MAX_TTL_MS = 24 * 60 * 60_000
/** A valid document is kept this long past its freshness to stand in during transient failures (§6.1). */
export const CIMD_STALE_MS = 7 * 24 * 60 * 60_000
export const CIMD_CACHE_ENTRIES = 500
/** After a failed fetch the same URL is not fetched again for this long (rate limit, §6.2; the failure itself is not cached). */
export const CIMD_RETRY_GAP_MS = 30_000
/** Fetches per minute across all URLs. */
export const CIMD_FETCHES_PER_MINUTE = 60

const MAX_REDIRECT_URIS = 20
const MAX_CLIENT_NAME = 100
const SHARED_SECRET_METHODS = new Set(['client_secret_basic', 'client_secret_post', 'client_secret_jwt'])

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * transient: network, timeout, 5xx/429, rate limit → try again later; previously cached valid
 * metadata stays usable. terminal: the URL or document is not acceptable.
 */
export type CimdErrorKind = 'transient' | 'terminal'
export type CimdErrorCode =
  | 'disabled'
  | 'bad_url'
  | 'host_not_allowed'
  | 'own_origin'
  | 'blocked'
  | 'redirect'
  | 'status'
  | 'too_large'
  | 'content_type'
  | 'not_json'
  | 'client_id_mismatch'
  | 'invalid_metadata'
  | 'unsupported_auth'
  | 'unavailable'
  | 'rate_limited'

export class CimdError extends Error {
  constructor(
    public readonly kind: CimdErrorKind,
    public readonly code: CimdErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'CimdError'
  }
}

const terminal = (code: CimdErrorCode, message: string) => new CimdError('terminal', code, message)

// ---------------------------------------------------------------------------
// client_id URL (draft §3)
// ---------------------------------------------------------------------------

/** A client_id that has a URL scheme. DCR ids (`ink_c_…`) and agent token clients (`ink_tc_…`) never contain ':'. */
export function isUrlClientId(clientId: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(clientId)
}

function hostMatches(host: string, pattern: string): boolean {
  if (pattern.startsWith('*.')) return host.endsWith(pattern.slice(1)) && host.length > pattern.length - 1
  return host === pattern
}

const LOOPBACK_LITERALS = new Set(['127.0.0.1', '[::1]', 'localhost'])

/**
 * Checks a client_id URL without fetching it: https, a host, no userinfo, a path other than "/",
 * no "." or ".." segments, no fragment (all on the raw string: URL() would normalise them away),
 * at most 2,000 characters, not on this server's own origin (§10.1, and a public file on this
 * server must not pass for an app), and inside OAUTH_CIMD_ALLOWED_HOSTS when that is set.
 * A query is allowed (the draft says SHOULD NOT, not MUST NOT). Returns the parsed URL.
 */
export function checkClientIdUrl(raw: string, ownOrigin: string | null, cfg: CimdConfig = cimdConfig()): URL {
  if (raw.length > CIMD_MAX_URL_LENGTH) throw terminal('bad_url', 'client_id URL is too long')
  if (raw.includes('#')) throw terminal('bad_url', 'client_id URL must not contain a fragment')
  if (/\s/.test(raw)) throw terminal('bad_url', 'client_id URL must not contain spaces')
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)/.exec(raw)
  if (!m) throw terminal('bad_url', 'client_id must be an https URL')
  const [, scheme, authority, rawPath] = m
  if (authority.includes('@')) throw terminal('bad_url', 'client_id URL must not contain a user name or password')
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    throw terminal('bad_url', 'client_id is not a valid URL')
  }
  const host = u.hostname.toLowerCase()
  const testHttp = cfg.testLoopback && scheme.toLowerCase() === 'http' && LOOPBACK_LITERALS.has(host)
  if (scheme !== 'https' && !testHttp) throw terminal('bad_url', 'client_id must use https')
  if (!host) throw terminal('bad_url', 'client_id URL has no host')
  if (!rawPath || rawPath === '/') throw terminal('bad_url', 'client_id URL needs a path (for example /client.json)')
  for (const seg of rawPath.split('/')) {
    const s = seg.toLowerCase().replace(/%2e/g, '.')
    if (s === '.' || s === '..') throw terminal('bad_url', 'client_id URL must not contain "." or ".." segments')
  }
  if (ownOrigin && u.origin === new URL(ownOrigin).origin) {
    throw terminal('own_origin', "client_id must not be on this server's own address")
  }
  if (cfg.allowedHosts.length > 0 && !cfg.allowedHosts.some((p) => hostMatches(host, p))) {
    throw terminal('host_not_allowed', `Apps from ${host} are not allowed on this server`)
  }
  return u
}

// ---------------------------------------------------------------------------
// Document (draft §4, §5, §6)
// ---------------------------------------------------------------------------

export interface CimdClient {
  /** The client_id URL, exactly as sent. */
  clientId: string
  /** Host of the client_id URL: what the consent screen shows next to the (unverified) name. */
  host: string
  /** client_name trimmed to 100 characters (the host when the document has none). */
  name: string
  /** redirect_uris this server can use (https or loopback http); others in the document are ignored. */
  redirectUris: string[]
}

/**
 * Validates a parsed document against the client_id it was fetched for. Throws a terminal
 * CimdError naming the first problem.
 */
export function validateCimdDocument(clientId: string, doc: unknown): CimdClient {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw terminal('not_json', 'The client metadata is not a JSON object')
  const d = doc as Record<string, unknown>
  if (d.client_id !== clientId) {
    throw terminal('client_id_mismatch', 'The client metadata names a different client_id than its URL')
  }
  if ('client_secret' in d || 'client_secret_expires_at' in d) {
    throw terminal('invalid_metadata', 'The client metadata must not contain a client secret')
  }
  if ('jwks' in d && 'jwks_uri' in d) throw terminal('invalid_metadata', 'The client metadata has both jwks and jwks_uri')

  // token endpoint authentication (§5): absent = none; only public clients (none + PKCE) here
  const single = d.token_endpoint_auth_method
  const multi = d.token_endpoint_auth_methods_supported
  if (single !== undefined && typeof single !== 'string') throw terminal('invalid_metadata', 'token_endpoint_auth_method must be a string')
  if (multi !== undefined && (!Array.isArray(multi) || !multi.every((x) => typeof x === 'string'))) {
    throw terminal('invalid_metadata', 'token_endpoint_auth_methods_supported must be a list of strings')
  }
  const methods: string[] = multi !== undefined ? (multi as string[]) : single !== undefined ? [single] : ['none']
  if (multi !== undefined && single !== undefined && !(multi as string[]).includes(single)) {
    throw terminal('invalid_metadata', 'token_endpoint_auth_method is not in token_endpoint_auth_methods_supported')
  }
  if ([...methods, ...(typeof single === 'string' ? [single] : [])].some((x) => SHARED_SECRET_METHODS.has(x))) {
    throw terminal('invalid_metadata', 'The client metadata names a shared-secret authentication method')
  }
  if (!methods.includes('none')) {
    throw terminal('unsupported_auth', 'Only public clients (token_endpoint_auth_method "none" with PKCE) are supported')
  }

  // grant_types / response_types (§6): the intersection with ours must not be empty
  // (refresh_token is not required in grant_types: the MCP specification's own example lists only
  // authorization_code, and DCR clients get refresh tokens the same way, docs/adr/2281-*)
  for (const [key, need] of [['grant_types', 'authorization_code'], ['response_types', 'code']] as const) {
    const v = d[key]
    if (v === undefined) continue
    if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) throw terminal('invalid_metadata', `${key} must be a list of strings`)
    if (!v.includes(need)) throw terminal('invalid_metadata', `${key} must include "${need}"`)
  }

  const uris = d.redirect_uris
  if (!Array.isArray(uris) || uris.length === 0) throw terminal('invalid_metadata', 'The client metadata has no redirect_uris')
  if (uris.length > MAX_REDIRECT_URIS) throw terminal('invalid_metadata', 'The client metadata has too many redirect_uris')
  const usable = uris.filter((x): x is string => typeof x === 'string' && x.length <= 2000 && isAllowedRedirectUri(x))
  if (usable.length === 0) {
    throw terminal('invalid_metadata', 'None of the redirect_uris is an https or http://localhost (127.0.0.1) URL')
  }

  const host = new URL(clientId).hostname.toLowerCase()
  const rawName = typeof d.client_name === 'string' ? d.client_name.trim() : ''
  const name = (sanitizeClientName(rawName) ? rawName : host).slice(0, MAX_CLIENT_NAME)
  return { clientId, host, name, redirectUris: [...new Set(usable)] }
}

/** Media types accepted for the document: application/json or application/<x>+json (§4). */
export function isJsonMediaType(mediaType: string): boolean {
  return mediaType === 'application/json' || /^application\/[a-z0-9!#$&^_.-]+\+json$/.test(mediaType)
}

/**
 * How long a fetched document stays fresh, from its Cache-Control and Age headers (Expires is
 * ignored, §6.2): max-age minus Age, clamped to [60 s, 24 h]; no-store / no-cache count as 0 (→ 60 s,
 * the floor doubles as the fetch rate limit); no directive → 5 min.
 */
export function cimdCacheLifetimeMs(headers: Record<string, string | string[] | undefined>): number {
  const raw = headers['cache-control']
  const cc = (Array.isArray(raw) ? raw.join(',') : (raw ?? '')).toLowerCase()
  const clamp = (ms: number) => Math.min(CIMD_MAX_TTL_MS, Math.max(CIMD_MIN_TTL_MS, ms))
  if (/(^|[\s,])(no-store|no-cache)([\s,=]|$)/.test(cc)) return CIMD_MIN_TTL_MS
  const m = /(^|[\s,])max-age\s*=\s*"?(\d+)"?/.exec(cc)
  if (!m) return CIMD_DEFAULT_TTL_MS
  const ageRaw = headers['age']
  const age = Number(Array.isArray(ageRaw) ? ageRaw[0] : ageRaw)
  const seconds = Number(m[2]) - (Number.isFinite(age) && age > 0 ? age : 0)
  return clamp(seconds * 1000)
}

// ---------------------------------------------------------------------------
// Cache, rate limit, fetch
// ---------------------------------------------------------------------------

interface Entry {
  client: CimdClient
  freshUntil: number
  staleUntil: number
}

const cache = new Map<string, Entry>() // insertion order = recency (LRU)
const inflight = new Map<string, Promise<CimdClient>>()
const lastFailure = new Map<string, number>()
let budget: { windowStart: number; used: number } = { windowStart: 0, used: 0 }
let now: () => number = () => Date.now()

function remember(url: string, e: Entry): void {
  cache.delete(url)
  cache.set(url, e)
  while (cache.size > CIMD_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
  if (lastFailure.size > CIMD_CACHE_ENTRIES) lastFailure.clear()
}

function takeBudget(): boolean {
  const t = now()
  if (t - budget.windowStart >= 60_000) budget = { windowStart: t, used: 0 }
  if (budget.used >= CIMD_FETCHES_PER_MINUTE) return false
  budget.used++
  return true
}

const TRANSIENT_FETCH: ReadonlySet<SafeFetchErrorCode> = new Set(['timeout', 'network', 'dns_failed'])

async function fetchDocument(clientId: string, cfg: CimdConfig): Promise<{ client: CimdClient; ttl: number }> {
  let res
  try {
    res = await safeFetch(clientId, {
      headers: { accept: 'application/json' },
      maxRedirects: 0,
      timeoutMs: CIMD_TIMEOUT_MS,
      connectTimeoutMs: 3_000,
      maxBytes: CIMD_MAX_BYTES,
      ...(cfg.testLoopback ? { unsafeAllowLoopbackForTests: true } : {}),
    })
  } catch (e) {
    if (e instanceof SafeFetchError) {
      if (TRANSIENT_FETCH.has(e.code)) throw new CimdError('transient', 'unavailable', `The client metadata could not be fetched (${e.code})`)
      if (e.code === 'too_large') throw terminal('too_large', `The client metadata is larger than ${CIMD_MAX_BYTES} bytes`)
      throw terminal('blocked', `The client metadata URL is not allowed (${e.code})`)
    }
    throw new CimdError('transient', 'unavailable', 'The client metadata could not be fetched')
  }
  if (res.status >= 300 && res.status < 400) throw terminal('redirect', 'The client metadata URL redirects; redirects are not followed')
  if (res.status === 429 || res.status >= 500) {
    throw new CimdError('transient', 'unavailable', `The client metadata server answered ${res.status}`)
  }
  if (res.status !== 200) throw terminal('status', `The client metadata server answered ${res.status}`)
  if (!isJsonMediaType(res.contentType)) {
    throw terminal('content_type', `The client metadata is not JSON (content type ${res.contentType || 'none'})`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(res.body.toString('utf8'))
  } catch {
    throw terminal('not_json', 'The client metadata is not valid JSON')
  }
  return { client: validateCimdDocument(clientId, parsed), ttl: cimdCacheLifetimeMs(res.headers) }
}

/**
 * The client described by `clientId`'s document: from the cache while fresh, else fetched (one fetch
 * per URL at a time). A transient failure falls back to the last valid document for up to 7 days
 * (§6.1); a terminal one drops it (§6.2: invalid documents are never cached). `ownOrigin` is this
 * server's public origin (client_ids on it are refused).
 */
export async function resolveCimdClient(clientId: string, ownOrigin: string | null): Promise<CimdClient> {
  const cfg = cimdConfig()
  if (!cfg.enabled) throw terminal('disabled', 'Client ID Metadata Documents are not enabled on this server')
  checkClientIdUrl(clientId, ownOrigin, cfg)
  const t = now()
  const hit = cache.get(clientId)
  if (hit && hit.freshUntil > t) {
    remember(clientId, hit)
    return hit.client
  }
  const pending = inflight.get(clientId)
  if (pending) return pending
  const usableStale = () => (hit && hit.staleUntil > now() ? hit.client : null)
  const failedAt = lastFailure.get(clientId)
  if ((failedAt !== undefined && t - failedAt < CIMD_RETRY_GAP_MS) || !takeBudget()) {
    const stale = usableStale()
    if (stale) return stale
    throw new CimdError('transient', 'rate_limited', 'The client metadata was fetched too often; try again in a minute')
  }
  const p = (async () => {
    try {
      const { client, ttl } = await fetchDocument(clientId, cfg)
      const at = now()
      remember(clientId, { client, freshUntil: at + ttl, staleUntil: at + Math.max(ttl, CIMD_STALE_MS) })
      lastFailure.delete(clientId)
      return client
    } catch (e) {
      lastFailure.set(clientId, now())
      if (e instanceof CimdError && e.kind === 'transient') {
        const stale = usableStale()
        if (stale) return stale
      } else {
        cache.delete(clientId)
      }
      throw e
    } finally {
      inflight.delete(clientId)
    }
  })()
  inflight.set(clientId, p)
  return p
}

/** Whether a stored client id may still be used without fetching (code exchange): feature on, URL still acceptable. */
export function cimdClientUsable(clientId: string, ownOrigin: string | null): boolean {
  const cfg = cimdConfig()
  if (!cfg.enabled) return false
  try {
    checkClientIdUrl(clientId, ownOrigin, cfg)
    return true
  } catch {
    return false
  }
}

/** TEST ONLY: forget everything; optionally replace the clock. */
export function _resetCimd(clock?: () => number): void {
  cache.clear()
  inflight.clear()
  lastFailure.clear()
  budget = { windowStart: 0, used: 0 }
  now = clock ?? (() => Date.now())
}
