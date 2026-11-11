import { isFeatureDisabled } from '../limits'
import { safeFetch, SafeFetchError } from '../safeFetch'

/**
 * Slack Web API calls (docs/adr/1800-*, 1802-*). Plain HTTPS POSTs through safeFetch: host pinned
 * to slack.com, no redirects, 8 s deadline, 256 KiB read. No Slack SDK (no new dependency).
 *
 * The bot token travels only in the Authorization header. Nothing here ever puts the token, the
 * request body or the raw response into an error message or a log line: callers get Slack's error
 * code (`invalid_auth`, `not_in_channel` …) or a transport code (`timeout`, `network`, `HTTP 503`).
 *
 * Tests point the client at a local fake with SLACK_TEST_API_URL=http://127.0.0.1:<port>/api, which
 * is honoured only together with WEBHOOK_TEST_ALLOW_LOOPBACK=1 outside production (the same switch
 * as the webhook test receiver); otherwise the base is always https://slack.com/api.
 */

const SLACK_API = 'https://slack.com/api'
const DEFAULT_TIMEOUT_MS = 8_000
const MAX_BYTES = 256 * 1024

export function slackTestMode(): boolean {
  return process.env.WEBHOOK_TEST_ALLOW_LOOPBACK === '1' && process.env.NODE_ENV !== 'production'
}

function apiBase(): { base: string; loopback: boolean } {
  const t = process.env.SLACK_TEST_API_URL
  if (t && slackTestMode()) {
    try {
      const u = new URL(t)
      if (u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === '[::1]')) return { base: u.href.replace(/\/$/, ''), loopback: true }
    } catch {
      // ignored: fall back to Slack
    }
  }
  return { base: SLACK_API, loopback: false }
}

export type SlackResult<T = Record<string, unknown>> =
  | { ok: true; data: T }
  | {
      ok: false
      /** Slack's error code, or a transport code; never a secret. */
      error: string
      retryable: boolean
      retryAfterMs?: number
    }

/** Slack error codes worth another try later. */
const RETRYABLE = new Set(['ratelimited', 'internal_error', 'fatal_error', 'service_unavailable', 'request_timeout', 'timeout'])

/**
 * Codes that will not get better by retrying: the token or the channel is wrong. Channel posts pause
 * (`blocked_reason`) until a save or a passing test (docs/adr/1802-*).
 */
export const BLOCKING_ERRORS = new Set([
  'invalid_auth',
  'not_authed',
  'token_revoked',
  'token_expired',
  'account_inactive',
  'channel_not_found',
  'not_in_channel',
  'is_archived',
  'missing_scope',
  'no_permission',
  'team_access_not_granted',
  'org_login_required',
  'ekm_access_denied',
  'secret_unreadable',
])

/** Only Slack-style codes (lower case words) are ever passed on, capped. */
function cleanCode(v: unknown): string {
  return typeof v === 'string' && /^[a-z0-9_.]{1,64}$/.test(v) ? v : 'unknown_error'
}

function encodeForm(params: Record<string, unknown>): string {
  const f = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue
    f.set(k, typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : JSON.stringify(v))
  }
  return f.toString()
}

/** One Web API method call (form-encoded; nested values as JSON strings, which every method accepts). */
export async function slackApi<T = Record<string, unknown>>(
  method: string,
  token: string,
  params: Record<string, unknown> = {},
  opts: { timeoutMs?: number } = {},
): Promise<SlackResult<T>> {
  if (!/^[a-z]+(\.[a-zA-Z]+)+$/.test(method)) return { ok: false, error: 'invalid_method', retryable: false }
  // Slack turned off (DISABLED_FEATURES, docs/adr/2507-*): no call leaves the server
  if (isFeatureDisabled('slack')) return { ok: false, error: 'feature_disabled', retryable: false }
  const { base, loopback } = apiBase()
  try {
    const res = await safeFetch(`${base}/${method}`, {
      method: 'POST',
      body: encodeForm(params),
      headers: {
        'content-type': 'application/x-www-form-urlencoded; charset=utf-8',
        authorization: `Bearer ${token}`,
        'user-agent': 'Inkling-Slack/1',
      },
      ...(loopback ? { unsafeAllowLoopbackForTests: true, allowHttp: true } : { allowedHosts: ['slack.com'], allowedPorts: [443] }),
      maxRedirects: 0,
      maxBytes: MAX_BYTES,
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    })
    if (res.status === 429) {
      const ra = Number(res.headers['retry-after'])
      return { ok: false, error: 'ratelimited', retryable: true, retryAfterMs: Number.isFinite(ra) ? Math.min(Math.max(ra, 1) * 1000, 15 * 60_000) : undefined }
    }
    if (res.status >= 500) return { ok: false, error: `HTTP ${res.status}`, retryable: true }
    if (res.status < 200 || res.status >= 300) return { ok: false, error: `HTTP ${res.status}`, retryable: false }
    let json: Record<string, unknown>
    try {
      json = JSON.parse(res.body.toString('utf8')) as Record<string, unknown>
    } catch {
      return { ok: false, error: 'bad_response', retryable: true }
    }
    if (json.ok === true) return { ok: true, data: json as T }
    const code = cleanCode(json.error)
    return { ok: false, error: code, retryable: RETRYABLE.has(code) }
  } catch (e) {
    const code = e instanceof SafeFetchError ? e.code : 'network'
    return { ok: false, error: code, retryable: code === 'timeout' || code === 'network' || code === 'dns_failed' }
  }
}

export interface AuthTest {
  team_id?: string
  team?: string
  user_id?: string
  bot_id?: string
}

export interface SlackUserInfo {
  user?: {
    id?: string
    deleted?: boolean
    is_bot?: boolean
    is_email_confirmed?: boolean
    profile?: { email?: string }
  }
}

export interface ConversationInfo {
  channel?: { id?: string; name?: string; is_private?: boolean }
}
