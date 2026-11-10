import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Slack request signatures, version 0 (docs/adr/1804-*):
 *
 *   X-Slack-Signature: v0=<hex HMAC-SHA256(signing secret, "v0:" + X-Slack-Request-Timestamp + ":" + raw body)>
 *
 * The timestamp must be within SLACK_TOLERANCE_S of the server clock (either direction), and the
 * comparison is constant-time. Replays inside the window are refused by the nonce table
 * (slack/requests.ts), keyed by `replayKey`.
 */

export const SLACK_TOLERANCE_S = 5 * 60

export function slackSignature(secret: string, timestamp: string, rawBody: string): string {
  return `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${rawBody}`, 'utf8').digest('hex')}`
}

export type SignatureVerdict = { ok: true } | { ok: false; reason: 'missing' | 'stale' | 'mismatch' }

export function verifySlackSignature(
  secret: string,
  timestamp: string | undefined,
  signature: string | undefined,
  rawBody: string,
  nowS = Math.floor(Date.now() / 1000),
): SignatureVerdict {
  if (!timestamp || !signature || !/^\d{1,12}$/.test(timestamp) || !/^v0=[0-9a-f]{64}$/.test(signature)) return { ok: false, reason: 'missing' }
  if (Math.abs(nowS - Number(timestamp)) > SLACK_TOLERANCE_S) return { ok: false, reason: 'stale' }
  const want = Buffer.from(slackSignature(secret, timestamp, rawBody), 'utf8')
  const got = Buffer.from(signature, 'utf8')
  if (got.length !== want.length || !timingSafeEqual(got, want)) return { ok: false, reason: 'mismatch' }
  return { ok: true }
}

/** Nonce of one signed request: the same timestamp + signature twice is a replay. */
export function replayKey(timestamp: string, signature: string): string {
  return `sig:${createHash('sha256').update(`${timestamp}:${signature}`, 'utf8').digest('hex')}`
}

function headerValue(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v
}

export function signatureHeaders(headers: Record<string, string | string[] | undefined>): { timestamp?: string; signature?: string } {
  return { timestamp: headerValue(headers['x-slack-request-timestamp']), signature: headerValue(headers['x-slack-signature']) }
}
