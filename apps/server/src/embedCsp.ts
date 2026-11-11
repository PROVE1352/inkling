/**
 * Content-Security-Policy for the SPA shell (every text/html response without its own CSP:
 * index.html from @fastify/static, the SPA fallback, the /s/:token share shell).
 *
 * Full policy since docs/adr/0814-*: scripts only from our origin (the shell has no inline
 * script: theme-init.js is a file), no plugins/objects, no <base> hijack, no framing by other
 * sites. `style-src 'unsafe-inline'` because BlockNote/Mantine/React set inline styles;
 * `img-src https:` / `media-src https:` for external images and media in documents. `frame-src`
 * is the embed allowlist (docs/adr/0501-*). Responses that already carry a CSP (public share
 * JSON, file downloads, plugin frames and scripts) keep their own policy untouched.
 *
 * Other features that need to frame something must add the origin to EMBED_FRAME_ORIGINS
 * (packages/shared/src/embeds.ts) or to EMBED_EXTRA_FRAME_SRC.
 * See docs/adr/0501-embed-providers-and-frame-src.md.
 */
import { isFeatureDisabled } from './limits'
import type { FastifyInstance } from 'fastify'
import { EMBED_FRAME_ORIGINS } from '@inkling/shared'

/** Space/comma separated extra origins, e.g. "https://embed.example.com". https only. */
function extraOrigins(): string[] {
  return (process.env.EMBED_EXTRA_FRAME_SRC || '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => /^https:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/.test(s))
}

export const FRAME_SRC_POLICY = `frame-src 'self' ${[...EMBED_FRAME_ORIGINS, ...extraOrigins()].join(' ')}`

export const SPA_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'self'",
  FRAME_SRC_POLICY,
  "img-src 'self' data: blob: https:",
  "media-src 'self' blob: https:",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self' ws: wss:",
  "font-src 'self' data:",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
].join('; ')

/** SPA_CSP with no outside frame origin: embeds turned off (DISABLED_FEATURES embeds, docs/adr/2507-*). */
export const SPA_CSP_NO_EMBEDS = SPA_CSP.replace(FRAME_SRC_POLICY, "frame-src 'self'")

export function registerEmbedCsp(app: FastifyInstance): void {
  app.addHook('onSend', async (_req, reply, payload) => {
    if (reply.hasHeader('content-security-policy')) return payload
    const ct = String(reply.getHeader('content-type') ?? '')
    if (!ct.startsWith('text/html')) return payload
    reply.header('Content-Security-Policy', isFeatureDisabled('embeds') ? SPA_CSP_NO_EMBEDS : SPA_CSP)
    return payload
  })
}
