import { createHash } from 'node:crypto'
import { env } from '../env'
import { SafeFetchError, validateUrl } from '../safeFetch'
import type { SafeFetchOptions } from '../safeFetch'

/**
 * Web push configuration and the endpoint policy (docs/adr/2220-*, 2221-*).
 *
 * Environment:
 *  - WEB_PUSH=off             server-wide off switch: nothing is queued, queued deliveries are dropped,
 *                             /api/push/* answers "not available".
 *  - VAPID_PUBLIC_KEY /       the server's VAPID key pair (base64url, the form `web-push generate-vapid-keys`
 *    VAPID_PRIVATE_KEY        prints). Unset: made on first use and kept in the database (push_vapid_keys).
 *  - VAPID_SUBJECT            `mailto:` or `https:` contact sent to push services. Default: PUBLIC_URL when it
 *                             is https, else a placeholder mailto (Apple may refuse it: set it there).
 *  - WEB_PUSH_ALLOWED_HOSTS   more push service hosts (comma-separated, exact or `*.suffix`).
 *  - PUSH_TEST_ALLOW_LOOPBACK=1  tests only (ignored with NODE_ENV=production): loopback http endpoints.
 *
 * An endpoint is a URL a browser handed to the page, so the server only ever POSTs to it after the
 * checks of safeFetch (https, port 443, no credentials, every DNS answer public, no redirects) AND a
 * host allowlist of the push services browsers use.
 */

function listEnv(v: string | undefined): string[] {
  return (v ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => /^(\*\.)?[a-z0-9.-]+$/.test(s))
}

const off = (v: string | undefined) => ['off', '0', 'false', 'no'].includes((v ?? '').trim().toLowerCase())

export const pushEnv = {
  enabled: !off(process.env.WEB_PUSH),
  vapidPublicKey: process.env.VAPID_PUBLIC_KEY?.trim() || null,
  vapidPrivateKey: process.env.VAPID_PRIVATE_KEY?.trim() || null,
  vapidSubject: process.env.VAPID_SUBJECT?.trim() || null,
}

/**
 * Push services of the browsers people use (docs/adr/2221-*):
 *  - Chrome, Edge on Android, Opera, Samsung Internet: Firebase Cloud Messaging
 *  - Firefox: Mozilla autopush
 *  - Safari (macOS 13+, iOS/iPadOS 16.4+ home-screen apps): Apple web push
 *  - Edge on Windows: Windows Push Notification Services
 */
export const KNOWN_PUSH_HOSTS: readonly string[] = [
  'fcm.googleapis.com',
  'android.googleapis.com',
  'updates.push.services.mozilla.com',
  '*.push.services.mozilla.com',
  'web.push.apple.com',
  '*.push.apple.com',
  '*.notify.windows.com',
]

/** Mutable for tests (they inject hosts and the loopback switch); read from the environment otherwise. */
export const pushPolicy = {
  extraHosts: listEnv(process.env.WEB_PUSH_ALLOWED_HOSTS),
  allowLoopbackForTests: process.env.PUSH_TEST_ALLOW_LOOPBACK === '1' && process.env.NODE_ENV !== 'production',
}

export function allowedPushHosts(): string[] {
  return [...KNOWN_PUSH_HOSTS, ...pushPolicy.extraHosts]
}

/** safeFetch options shared by the registration check and the delivery. */
export function endpointFetchPolicy(): SafeFetchOptions {
  return {
    allowedHosts: allowedPushHosts(),
    allowedPorts: [443],
    maxRedirects: 0,
    ...(pushPolicy.allowLoopbackForTests ? { unsafeAllowLoopbackForTests: true } : {}),
  }
}

export const MAX_ENDPOINT_LENGTH = 1024

export class PushEndpointError extends Error {
  constructor(public readonly code: 'invalid' | 'host_not_allowed') {
    super(code === 'invalid' ? 'invalid push endpoint' : 'push service is not allowed')
    this.name = 'PushEndpointError'
  }
}

/**
 * The synchronous endpoint checks (registration and again before each send): a URL safeFetch would
 * accept, of an allowed push service. DNS is checked by safeFetch at send time.
 */
export function validateEndpoint(raw: string): URL {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_ENDPOINT_LENGTH) throw new PushEndpointError('invalid')
  try {
    return validateUrl(raw, endpointFetchPolicy())
  } catch (e) {
    if (e instanceof SafeFetchError && e.code === 'host_not_allowed') throw new PushEndpointError('host_not_allowed')
    throw new PushEndpointError('invalid')
  }
}

export function endpointHash(endpoint: string): string {
  return createHash('sha256').update(endpoint, 'utf8').digest('hex')
}

/** `sub` claim: VAPID_SUBJECT, else PUBLIC_URL when it is https, else a placeholder contact. */
export function vapidSubject(): string {
  if (pushEnv.vapidSubject && /^(mailto:|https:\/\/)/i.test(pushEnv.vapidSubject)) return pushEnv.vapidSubject
  const pub = env.publicUrl ?? env.appUrl
  if (pub && /^https:\/\//i.test(pub)) return pub
  return 'mailto:webpush@inkling.invalid'
}

/** Origin of an endpoint: the JWT audience (RFC 8292 §2). */
export function audienceOf(endpoint: URL): string {
  return endpoint.origin
}
