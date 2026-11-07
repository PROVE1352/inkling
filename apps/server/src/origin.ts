import type { FastifyRequest } from 'fastify'
import { env, mailEnabled } from './env'

/**
 * External origin of the site (C-M1, docs/adr/0806-*).
 *
 * Mail links, the OAuth issuer/endpoints and og:url come from configuration only — PUBLIC_URL
 * (APP_URL as fallback; mail prefers APP_URL). The Host header is attacker-controlled: a password
 * reset mail whose link host came from the request let anyone who triggers the mail with a forged
 * Host collect the code. With mail enabled the server refuses to boot without one of them
 * (assertOriginConfigured). Only a dev setup without mail and without both variables falls back
 * to the request host, with a one-time warning.
 */
let warned = false

function requestOrigin(req: FastifyRequest | undefined, what: string): string {
  if (!req) return ''
  if (!warned) {
    warned = true
    console.warn(
      `[inkling] PUBLIC_URL/APP_URL is not set — using the request Host for ${what}. ` +
        'Set PUBLIC_URL in production.',
    )
  }
  return `${req.protocol}://${req.host}`
}

/** OAuth issuer / MCP resource / og:url origin: PUBLIC_URL, else APP_URL. */
export function configuredPublicOrigin(req?: FastifyRequest): string {
  if (env.publicUrl) return env.publicUrl
  if (env.appUrl) return env.appUrl
  return requestOrigin(req, 'OAuth metadata and share links')
}

/** Mail link origin: APP_URL, else PUBLIC_URL (env.appUrl already falls back). */
export function configuredMailOrigin(req?: FastifyRequest): string {
  if (env.appUrl) return env.appUrl
  if (env.publicUrl) return env.publicUrl
  return requestOrigin(req, 'mail links')
}

/** Boot check: mail without a configured origin would build links from the Host header. */
export function assertOriginConfigured(): void {
  if (mailEnabled && !env.publicUrl && !env.appUrl) {
    throw new Error(
      'SMTP mail is enabled but neither PUBLIC_URL nor APP_URL is set. Mail links must not be ' +
        'built from the request Host header — set PUBLIC_URL (e.g. https://notes.example.com).',
    )
  }
}
