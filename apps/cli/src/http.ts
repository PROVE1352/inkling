/**
 * Server API call wrapper — uses the built-in fetch of Node 22+.
 * Attaches the credential (API token or session cookie), parses Set-Cookie, normalizes errors.
 */

const SESSION_COOKIE = 'inkling_sid'
/** Personal API tokens (Settings › Connections › API tokens) start with this. */
export const API_TOKEN_PREFIX = 'ink_pat_'

export class ApiError extends Error {
  status: number
  code?: string
  constructor(status: number, message: string, code?: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

/** Safely join server + path (normalizes trailing slashes on server). */
function joinUrl(server: string, pathname: string): string {
  const base = server.replace(/\/+$/, '')
  const rel = pathname.startsWith('/') ? pathname : `/${pathname}`
  return base + rel
}

export interface FetchOptions {
  method?: string
  // String (JSON) or FormData (multipart upload) — for FormData, fetch adds the boundary.
  body?: string | FormData
  headers?: Record<string, string>
  /**
   * The credential: an API token (`ink_pat_…`, sent as `Authorization: Bearer`) or the saved session
   * cookie string (`inkling_sid=…`, sent as `Cookie`).
   */
  auth?: string
}

/** Raw fetch — returns the Response as is. Network failures become a readable error. */
export async function apiFetch(
  server: string,
  pathname: string,
  opts: FetchOptions = {},
): Promise<Response> {
  const headers = new Headers(opts.headers)
  if (opts.auth?.startsWith(API_TOKEN_PREFIX)) headers.set('Authorization', `Bearer ${opts.auth}`)
  else if (opts.auth) headers.set('Cookie', opts.auth)
  try {
    return await fetch(joinUrl(server, pathname), {
      method: opts.method ?? 'GET',
      body: opts.body,
      headers,
      redirect: 'manual',
    })
  } catch (err) {
    throw new ApiError(0, `Cannot connect to the server (${server}): ${(err as Error).message}`)
  }
}

/** Parse a non-2xx response as { error: { code, message } } and turn it into an ApiError. */
async function toApiError(res: Response): Promise<ApiError> {
  let code: string | undefined
  let message = `Request failed (HTTP ${res.status})`
  try {
    const data = (await res.json()) as { error?: { code?: string; message?: string } }
    if (data?.error?.message) message = data.error.message
    if (data?.error?.code) code = data.error.code
  } catch {
    // Keep the default message if the body is not JSON
  }
  return new ApiError(res.status, message, code)
}

/** JSON response helper — ApiError on non-2xx. */
export async function apiJson<T>(
  server: string,
  pathname: string,
  opts: FetchOptions = {},
): Promise<T> {
  const res = await apiFetch(server, pathname, opts)
  if (!res.ok) throw await toApiError(res)
  return (await res.json()) as T
}

/** Extract the inkling_sid cookie string ("inkling_sid=...") from the response's Set-Cookie headers. */
export function extractSessionCookie(res: Response): string | null {
  // Node/undici: getSetCookie() returns each Set-Cookie as an array.
  const getSetCookie = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie
  const cookies = typeof getSetCookie === 'function' ? getSetCookie.call(res.headers) : []
  const list = cookies.length > 0 ? cookies : rawSetCookieFallback(res)
  for (const c of list) {
    const first = c.split(';')[0]?.trim() ?? ''
    if (first.startsWith(`${SESSION_COOKIE}=`)) return first
  }
  return null
}

/** Fallback for environments without getSetCookie: a single set-cookie header. */
function rawSetCookieFallback(res: Response): string[] {
  const raw = res.headers.get('set-cookie')
  return raw ? [raw] : []
}

export interface LoginResult {
  cookie: string
  user: { id: string; email: string; name: string }
}

/** POST /api/auth/login → parse Set-Cookie and return cookie + user. */
export async function login(
  server: string,
  email: string,
  password: string,
): Promise<LoginResult> {
  const res = await apiFetch(server, '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  if (!res.ok) throw await toApiError(res)
  const cookie = extractSessionCookie(res)
  if (!cookie) {
    throw new ApiError(res.status, 'No session cookie found in the login response')
  }
  const data = (await res.json()) as { user: LoginResult['user'] }
  return { cookie, user: data.user }
}

/**
 * Whether the server signs in with IDs instead of emails (LOGIN_ID_MODE=username, docs/adr/2512-*):
 * the login prompt then asks for an ID. false when the server cannot be asked.
 */
export async function signsInWithId(server: string): Promise<boolean> {
  try {
    const res = await apiFetch(server, '/api/auth/mode', { method: 'GET' })
    if (!res.ok) return false
    return ((await res.json()) as { loginId?: unknown }).loginId === 'username'
  } catch {
    return false
  }
}

/** "Name <email>", or "Name (id)" for a sign-in ID (it is not an address). */
export function whoLabel(user: { name: string; email: string }): string {
  return user.email.includes('@') ? `${user.name} <${user.email}>` : `${user.name} (${user.email})`
}
