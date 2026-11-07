import { createHash, randomBytes, webcrypto } from 'node:crypto'
import { env, type OidcEnv } from './env'

/**
 * OpenID Connect relying party (docs/adr/1160-*): discovery, Authorization Code + PKCE (S256),
 * token exchange and id_token verification, with Node built-ins only (fetch, WebCrypto).
 *
 * What is checked on every id_token:
 *   - JWS compact form, header `alg` equal to the one configured algorithm (OIDC_ID_TOKEN_ALG,
 *     default RS256; `none` and HMAC algorithms are never accepted), `crit` absent
 *   - signature with a key from the provider's JWKS (by `kid`; an unknown kid refetches the JWKS
 *     at most once a minute, for key rotation)
 *   - `iss` equal to OIDC_ISSUER, `aud` containing the client id, `azp` equal to the client id when
 *     present or when `aud` has several values, `exp` in the future and `iat` not in the future
 *     (60 s of clock skew), `nonce` equal to the one stored for this sign-in, `sub` present
 *
 * Nothing here logs or returns the client secret, the authorization code or any token.
 */

const subtle = webcrypto.subtle
type JsonWebKey = webcrypto.JsonWebKey

export const CLOCK_SKEW_S = 60
const DISCOVERY_TTL_MS = 60 * 60_000
const JWKS_TTL_MS = 60 * 60_000
const JWKS_MIN_REFETCH_MS = 60_000
const FETCH_TIMEOUT_MS = 10_000
const MAX_RESPONSE_BYTES = 512 * 1024

/**
 * A sign-in failure with a fixed code for the web (`/login?oidc_error=CODE`). `detail` is for the
 * server log only and never contains token material.
 */
export class OidcError extends Error {
  constructor(
    public readonly code: OidcErrorCode,
    public readonly detail: string = code,
  ) {
    super(detail)
  }
}

export type OidcErrorCode =
  | 'OIDC_DISABLED'
  | 'OIDC_STATE_INVALID'
  | 'OIDC_CANCELLED'
  | 'OIDC_PROVIDER_ERROR'
  | 'OIDC_UNAVAILABLE'
  | 'OIDC_TOKEN_INVALID'
  | 'OIDC_NO_EMAIL'
  | 'OIDC_EMAIL_UNVERIFIED'
  | 'OIDC_DOMAIN_NOT_ALLOWED'
  | 'OIDC_NO_ACCOUNT'
  | 'OIDC_EMAIL_TAKEN'
  | 'OIDC_MFA_REQUIRED'
  | 'OIDC_ALREADY_LINKED'
  | 'OIDC_LINK_CONFLICT'
  | 'OIDC_LINK_SESSION'
  | 'EMAIL_NOT_VERIFIED'

export function oidcEnabled(cfg: OidcEnv = env.oidc): boolean {
  return !!(cfg.issuer && cfg.clientId && cfg.clientSecret)
}

const ALGS = new Set(['RS256', 'PS256', 'ES256'])

function isLoopbackUrl(u: URL): boolean {
  const h = u.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127\.\d+\.\d+\.\d+$/.test(h)
}

/** https only; plain http is accepted for loopback addresses (local test providers). */
function assertSecureUrl(raw: unknown, what: string): URL {
  let u: URL
  try {
    u = new URL(String(raw))
  } catch {
    throw new OidcError('OIDC_UNAVAILABLE', `${what} is not a URL`)
  }
  if (u.protocol === 'https:' || (u.protocol === 'http:' && isLoopbackUrl(u))) return u
  throw new OidcError('OIDC_UNAVAILABLE', `${what} must use https`)
}

/**
 * Boot check. Returns warnings to log; throws on a configuration that must not run: a half-filled
 * set (one of issuer / client id / secret missing), no PUBLIC_URL or APP_URL (the redirect URI must
 * not come from the Host header, docs/adr/0806-*), an unknown algorithm, or a non-https issuer.
 * Discovery is not fetched here: a provider outage must not keep Inkling from starting.
 */
export function assertOidcConfig(cfg: OidcEnv = env.oidc): string[] {
  const set = [cfg.issuer, cfg.clientId, cfg.clientSecret].filter(Boolean).length
  if (set === 0) return []
  if (set !== 3) {
    throw new Error('OIDC sign-in needs all of OIDC_ISSUER, OIDC_CLIENT_ID and OIDC_CLIENT_SECRET (or none of them).')
  }
  if (!env.publicUrl && !env.appUrl) {
    throw new Error('OIDC sign-in needs PUBLIC_URL: the redirect URI must not be built from the request Host header.')
  }
  if (!ALGS.has(cfg.alg)) {
    throw new Error(`OIDC_ID_TOKEN_ALG must be one of ${[...ALGS].join(', ')}.`)
  }
  try {
    assertSecureUrl(cfg.issuer, 'OIDC_ISSUER')
  } catch {
    throw new Error('OIDC_ISSUER must be an https URL (http only for localhost).')
  }
  const warnings: string[] = []
  if (cfg.autoCreate && cfg.allowedDomains.length === 0) {
    warnings.push(
      'OIDC_AUTO_CREATE=1 without OIDC_ALLOWED_DOMAINS: every account the provider issues can create an Inkling account (docs/adr/1161-*).',
    )
  }
  if (cfg.trustEmail && cfg.linkExisting) {
    warnings.push('OIDC_TRUST_EMAIL does not apply to OIDC_LINK_EXISTING: linking still needs email_verified=true.')
  }
  return warnings
}

/** The callback URL registered at the provider: PUBLIC_URL (else APP_URL) + /api/auth/oidc/callback. */
export function redirectUri(): string {
  const origin = env.publicUrl ?? env.appUrl
  if (!origin) throw new OidcError('OIDC_DISABLED', 'PUBLIC_URL is not set')
  return `${origin}/api/auth/oidc/callback`
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

async function fetchJson(url: string, init: RequestInit = {}, what = 'request'): Promise<{ status: number; body: unknown }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  let res: Response
  try {
    res = await fetch(url, { ...init, redirect: 'error', signal: controller.signal })
  } catch {
    clearTimeout(timer)
    throw new OidcError('OIDC_UNAVAILABLE', `${what}: network error or timeout`)
  }
  try {
    const text = await res.text()
    if (text.length > MAX_RESPONSE_BYTES) throw new OidcError('OIDC_UNAVAILABLE', `${what}: response too large`)
    let body: unknown = null
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      throw new OidcError('OIDC_UNAVAILABLE', `${what}: HTTP ${res.status}, not JSON`)
    }
    return { status: res.status, body }
  } catch (err) {
    if (err instanceof OidcError) throw err
    throw new OidcError('OIDC_UNAVAILABLE', `${what}: network error or timeout`)
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// Discovery and JWKS (cached)
// ---------------------------------------------------------------------------

export interface ProviderMetadata {
  issuer: string
  authorizationEndpoint: string
  tokenEndpoint: string
  jwksUri: string
  tokenAuthMethods: string[] | null
}

let discoveryCache: { key: string; at: number; meta: ProviderMetadata } | null = null
let jwksCache: { uri: string; at: number; keys: JsonWebKey[] } | null = null

/** Test hook: forget cached discovery and keys. */
export function _resetOidcCaches(): void {
  discoveryCache = null
  jwksCache = null
}

export async function discover(cfg: OidcEnv = env.oidc): Promise<ProviderMetadata> {
  if (!cfg.issuer) throw new OidcError('OIDC_DISABLED')
  const now = Date.now()
  if (discoveryCache && discoveryCache.key === cfg.issuer && now - discoveryCache.at < DISCOVERY_TTL_MS) {
    return discoveryCache.meta
  }
  const url = `${cfg.issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`
  const { status, body } = await fetchJson(url, { headers: { Accept: 'application/json' } }, 'discovery')
  if (status !== 200 || !body || typeof body !== 'object') {
    throw new OidcError('OIDC_UNAVAILABLE', `discovery: HTTP ${status}`)
  }
  const d = body as Record<string, unknown>
  // OpenID Connect Discovery 1.0 §4.3: the issuer in the document must equal the configured one exactly.
  if (d.issuer !== cfg.issuer) {
    throw new OidcError('OIDC_UNAVAILABLE', `discovery: issuer ${JSON.stringify(d.issuer)} does not equal OIDC_ISSUER`)
  }
  const meta: ProviderMetadata = {
    issuer: cfg.issuer,
    authorizationEndpoint: assertSecureUrl(d.authorization_endpoint, 'authorization_endpoint').toString(),
    tokenEndpoint: assertSecureUrl(d.token_endpoint, 'token_endpoint').toString(),
    jwksUri: assertSecureUrl(d.jwks_uri, 'jwks_uri').toString(),
    tokenAuthMethods: Array.isArray(d.token_endpoint_auth_methods_supported)
      ? d.token_endpoint_auth_methods_supported.filter((m): m is string => typeof m === 'string')
      : null,
  }
  discoveryCache = { key: cfg.issuer, at: now, meta }
  return meta
}

async function loadJwks(uri: string): Promise<JsonWebKey[]> {
  const { status, body } = await fetchJson(uri, { headers: { Accept: 'application/json' } }, 'jwks')
  const keys = (body as { keys?: unknown } | null)?.keys
  if (status !== 200 || !Array.isArray(keys)) throw new OidcError('OIDC_UNAVAILABLE', `jwks: HTTP ${status}`)
  const list = keys.filter((k): k is JsonWebKey => !!k && typeof k === 'object')
  jwksCache = { uri, at: Date.now(), keys: list }
  return list
}

const KTY: Record<OidcEnv['alg'], string> = { RS256: 'RSA', PS256: 'RSA', ES256: 'EC' }

function pickKey(keys: JsonWebKey[], kid: string | undefined, alg: OidcEnv['alg']): JsonWebKey | null {
  const usable = keys.filter((k) => {
    const j = k as JsonWebKey & { kid?: string; use?: string }
    if (j.kty !== KTY[alg]) return false
    if (j.use !== undefined && j.use !== 'sig') return false
    if (j.alg !== undefined && j.alg !== alg) return false
    if (alg === 'ES256' && j.crv !== 'P-256') return false
    return true
  })
  if (kid !== undefined) return usable.find((k) => (k as { kid?: string }).kid === kid) ?? null
  // No kid in the header: only unambiguous when the set has exactly one usable key.
  return usable.length === 1 ? usable[0] : null
}

async function keyFor(jwksUri: string, kid: string | undefined, alg: OidcEnv['alg']): Promise<JsonWebKey | null> {
  const now = Date.now()
  const fresh = jwksCache && jwksCache.uri === jwksUri && now - jwksCache.at < JWKS_TTL_MS
  let keys = fresh ? jwksCache!.keys : await loadJwks(jwksUri)
  let key = pickKey(keys, kid, alg)
  // Unknown kid: the provider may have rotated its keys. Refetch, but not more than once a minute,
  // so a stream of forged tokens with random kids cannot turn Inkling into a JWKS hammer.
  if (!key && fresh && now - jwksCache!.at >= JWKS_MIN_REFETCH_MS) {
    keys = await loadJwks(jwksUri)
    key = pickKey(keys, kid, alg)
  }
  return key
}

// ---------------------------------------------------------------------------
// Authorization request
// ---------------------------------------------------------------------------

export const b64url = (b: Buffer | Uint8Array) => Buffer.from(b).toString('base64url')
export const sha256hex = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(32))
  const challenge = b64url(createHash('sha256').update(verifier, 'ascii').digest())
  return { verifier, challenge }
}

export function authorizationUrl(
  meta: ProviderMetadata,
  p: { state: string; nonce: string; challenge: string; prompt?: 'login' },
  cfg: OidcEnv = env.oidc,
): string {
  const u = new URL(meta.authorizationEndpoint)
  u.searchParams.set('response_type', 'code')
  u.searchParams.set('client_id', cfg.clientId ?? '')
  u.searchParams.set('redirect_uri', redirectUri())
  u.searchParams.set('scope', cfg.scopes.split(/\s+/).includes('openid') ? cfg.scopes : `openid ${cfg.scopes}`)
  u.searchParams.set('state', p.state)
  u.searchParams.set('nonce', p.nonce)
  u.searchParams.set('code_challenge', p.challenge)
  u.searchParams.set('code_challenge_method', 'S256')
  if (cfg.acrValues.length) u.searchParams.set('acr_values', cfg.acrValues.join(' '))
  if (p.prompt) u.searchParams.set('prompt', p.prompt)
  return u.toString()
}

// ---------------------------------------------------------------------------
// Token exchange
// ---------------------------------------------------------------------------

/** Code → id_token. Access and refresh tokens in the response are dropped unread. */
export async function exchangeCode(code: string, verifier: string, cfg: OidcEnv = env.oidc): Promise<string> {
  const meta = await discover(cfg)
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(),
    code_verifier: verifier,
  })
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json',
  }
  // client_secret_basic unless the provider lists only client_secret_post (RFC 6749 §2.3.1).
  const methods = meta.tokenAuthMethods
  const usePost = !!methods && !methods.includes('client_secret_basic') && methods.includes('client_secret_post')
  if (usePost) {
    form.set('client_id', cfg.clientId ?? '')
    form.set('client_secret', cfg.clientSecret ?? '')
  } else {
    const id = encodeURIComponent(cfg.clientId ?? '')
    const secret = encodeURIComponent(cfg.clientSecret ?? '')
    headers.Authorization = `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`
    form.set('client_id', cfg.clientId ?? '')
  }
  const { status, body } = await fetchJson(meta.tokenEndpoint, { method: 'POST', headers, body: form.toString() }, 'token')
  const b = (body ?? {}) as { id_token?: unknown; error?: unknown }
  if (status !== 200) {
    // Only the standard error code is logged, never error_description (it may echo input).
    const e = typeof b.error === 'string' ? b.error.slice(0, 40) : `HTTP ${status}`
    throw new OidcError(status >= 500 ? 'OIDC_UNAVAILABLE' : 'OIDC_PROVIDER_ERROR', `token: ${e}`)
  }
  if (typeof b.id_token !== 'string' || !b.id_token) throw new OidcError('OIDC_TOKEN_INVALID', 'token: no id_token')
  return b.id_token
}

// ---------------------------------------------------------------------------
// id_token verification
// ---------------------------------------------------------------------------

export interface IdTokenClaims {
  iss: string
  sub: string
  aud: string | string[]
  exp: number
  iat: number
  nonce?: string
  azp?: string
  email?: string
  email_verified?: boolean | string
  name?: string
  preferred_username?: string
  amr?: string[]
  acr?: string
  [k: string]: unknown
}

function parseJsonPart(part: string, what: string): Record<string, unknown> {
  try {
    const v = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
  } catch {
    // fall through
  }
  throw new OidcError('OIDC_TOKEN_INVALID', `malformed ${what}`)
}

const importParams: Record<OidcEnv['alg'], webcrypto.RsaHashedImportParams | webcrypto.EcKeyImportParams> = {
  RS256: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
  PS256: { name: 'RSA-PSS', hash: 'SHA-256' },
  ES256: { name: 'ECDSA', namedCurve: 'P-256' },
}
const verifyParams: Record<OidcEnv['alg'], webcrypto.AlgorithmIdentifier | webcrypto.RsaPssParams | webcrypto.EcdsaParams> = {
  RS256: { name: 'RSASSA-PKCS1-v1_5' },
  PS256: { name: 'RSA-PSS', saltLength: 32 },
  ES256: { name: 'ECDSA', hash: 'SHA-256' },
}

/** Only the public members of a JWK, so `use`/`key_ops`/`alg` noise cannot make importKey refuse it. */
function publicJwk(k: JsonWebKey): JsonWebKey {
  return k.kty === 'EC' ? { kty: 'EC', crv: k.crv, x: k.x, y: k.y } : { kty: 'RSA', n: k.n, e: k.e }
}

export async function verifyIdToken(
  idToken: string,
  expected: { nonce: string; now?: number },
  cfg: OidcEnv = env.oidc,
): Promise<IdTokenClaims> {
  const parts = idToken.split('.')
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]*$/.test(p))) {
    throw new OidcError('OIDC_TOKEN_INVALID', 'not a JWS compact token')
  }
  const header = parseJsonPart(parts[0], 'header')
  // The algorithm is fixed by configuration; the header only has to agree (no alg=none, no HS256
  // with the public key as the secret, no algorithm the operator did not choose).
  if (header.alg !== cfg.alg) throw new OidcError('OIDC_TOKEN_INVALID', `alg ${String(header.alg)} not accepted`)
  if (header.crit !== undefined) throw new OidcError('OIDC_TOKEN_INVALID', 'crit header not supported')
  const kid = typeof header.kid === 'string' ? header.kid : undefined

  const meta = await discover(cfg)
  const jwk = await keyFor(meta.jwksUri, kid, cfg.alg)
  if (!jwk) throw new OidcError('OIDC_TOKEN_INVALID', 'no matching signing key')
  let ok = false
  try {
    const key = await subtle.importKey('jwk', publicJwk(jwk), importParams[cfg.alg], false, ['verify'])
    ok = await subtle.verify(
      verifyParams[cfg.alg],
      key,
      Buffer.from(parts[2], 'base64url'),
      Buffer.from(`${parts[0]}.${parts[1]}`, 'ascii'),
    )
  } catch {
    ok = false
  }
  if (!ok) throw new OidcError('OIDC_TOKEN_INVALID', 'bad signature')

  const c = parseJsonPart(parts[1], 'payload') as Partial<IdTokenClaims>
  const now = Math.floor((expected.now ?? Date.now()) / 1000)
  if (c.iss !== cfg.issuer) throw new OidcError('OIDC_TOKEN_INVALID', 'iss mismatch')
  const aud = Array.isArray(c.aud) ? c.aud : typeof c.aud === 'string' ? [c.aud] : []
  if (!cfg.clientId || !aud.includes(cfg.clientId)) throw new OidcError('OIDC_TOKEN_INVALID', 'aud mismatch')
  if ((aud.length > 1 || c.azp !== undefined) && c.azp !== cfg.clientId) {
    throw new OidcError('OIDC_TOKEN_INVALID', 'azp mismatch')
  }
  if (typeof c.exp !== 'number' || c.exp + CLOCK_SKEW_S <= now) throw new OidcError('OIDC_TOKEN_INVALID', 'expired')
  if (typeof c.iat !== 'number' || c.iat - CLOCK_SKEW_S > now) throw new OidcError('OIDC_TOKEN_INVALID', 'iat in the future')
  // The nonce is not a secret against timing: matching it still needs a token the provider signed.
  if (typeof c.nonce !== 'string' || c.nonce !== expected.nonce) {
    throw new OidcError('OIDC_TOKEN_INVALID', 'nonce mismatch')
  }
  if (typeof c.sub !== 'string' || !c.sub || c.sub.length > 255) throw new OidcError('OIDC_TOKEN_INVALID', 'sub missing')
  return c as IdTokenClaims
}

// ---------------------------------------------------------------------------
// Claims → policy inputs
// ---------------------------------------------------------------------------

/** email_verified as a strict boolean (some providers send the string "true"). */
export function emailVerifiedClaim(c: IdTokenClaims): boolean {
  return c.email_verified === true || c.email_verified === 'true'
}

/** Lower-cased email from the id_token, or null when absent or not an address. */
export function emailClaim(c: IdTokenClaims): string | null {
  const e = typeof c.email === 'string' ? c.email.trim().toLowerCase() : ''
  return /^[^\s@]+@[^\s@]+$/.test(e) && e.length <= 254 ? e : null
}

/**
 * RFC 8176 values that are a second factor on their own or report one: an explicit `mfa`/`mca`,
 * or a possession/inherence method. `pwd`, `kba`, `pin` alone are not.
 */
const SECOND_FACTOR_AMR = new Set(['mfa', 'mca', 'otp', 'hwk', 'swk', 'sms', 'tel', 'sc', 'fpt', 'face', 'iris', 'retina', 'vbm'])

/**
 * Whether the id_token shows a second factor (docs/adr/1162-*): an `amr` entry from the set above,
 * or an `acr` the operator listed in OIDC_ACR_VALUES.
 */
export function showsSecondFactor(c: IdTokenClaims, cfg: OidcEnv = env.oidc): boolean {
  const amr = Array.isArray(c.amr) ? c.amr.filter((v): v is string => typeof v === 'string') : []
  if (amr.some((v) => SECOND_FACTOR_AMR.has(v.toLowerCase()))) return true
  return typeof c.acr === 'string' && cfg.acrValues.includes(c.acr)
}

export function displayNameClaim(c: IdTokenClaims, email: string | null): string {
  const pick = [c.name, c.preferred_username].find((v): v is string => typeof v === 'string' && v.trim() !== '')
  const name = (pick ?? email?.split('@')[0] ?? 'user').trim().replace(/[\u0000-\u001f\u007f]/g, '')
  return name.slice(0, 50) || 'user'
}

/** Same-origin path only (open-redirect guard, mirrors apps/web/src/lib/nav.ts safeNext). */
export function safeReturnTo(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.length > 2000) return '/'
  const base = 'http://inkling.invalid'
  let u: URL
  try {
    u = new URL(raw, base)
  } catch {
    return '/'
  }
  if (u.origin !== base) return '/'
  const out = u.pathname + u.search + u.hash
  if (out.startsWith('//') || out.startsWith('/api/')) return '/'
  return out
}
