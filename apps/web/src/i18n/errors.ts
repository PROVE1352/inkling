import { getLocale, tMaybe } from './index'
import koServerA from './ko/server-messages-a'
import koServerB from './ko/server-messages-b'
import koServerC from './ko/server-messages-c'

// One file per server area so they can be filled independently (a: auth/pages/templates…,
// b: md/mcp/collab…, c: admin/public/files/plugins).
const byMessage: Record<string, Record<string, string>> = {
  ko: { ...koServerA, ...koServerB, ...koServerC },
}

/**
 * User-facing text for an API error (docs/adr/0902-error-codes-and-client-translation.md).
 * The server sends `{ code, message }` with an English message. English UI shows that message
 * (it is the most specific text) unless it is missing or just the code. Other locales use, in
 * order: a translation of the exact message, `errors.<CODE>`, then the English message.
 */
export function localizeApiError(code: string, serverMessage: string | undefined, details?: Record<string, unknown>): string {
  const msg = serverMessage && serverMessage !== code ? serverMessage : ''
  const locale = getLocale()
  if (locale === 'en') return msg || byCode(code, msg, details) || tMaybe('errors.INTERNAL')!
  const exact = msg ? byMessage[locale]?.[msg] : undefined
  if (exact) return exact
  return byCode(code, msg, details) || msg || tMaybe('errors.INTERNAL')!
}

/**
 * `errors.<CODE>`. A limit error (restricted mode, docs/adr/2500-*) that carries numeric `limit` and
 * `used` next to its code uses `errors.<CODE>_counts` when there is one, filled with those numbers.
 */
function byCode(code: string, msg: string, details?: Record<string, unknown>): string | undefined {
  const limit = details?.limit
  const used = details?.used
  if (typeof limit === 'number' && typeof used === 'number') {
    // storage and file size come in bytes, marked `unit: 'bytes'` (docs/adr/2505-*): their own `_mb` text, in MB
    const bytes = (code === 'LIMIT_STORAGE' || code === 'LIMIT_FILE') && details?.unit === 'bytes'
    const counted = bytes
      ? tMaybe(`errors.${code}_mb`, { message: msg, limit: formatMb(limit), used: formatMb(used) })
      : tMaybe(`errors.${code}_counts`, { message: msg, limit, used })
    if (counted) return counted
  }
  return tMaybe(`errors.${code}`, { message: msg })
}

/** Bytes as MB for limit messages: one decimal under 10 MB, whole above (e.g. "4.8 MB", "20 MB"). */
export function formatMb(bytes: number): string {
  const mb = bytes / (1024 * 1024)
  return `${mb < 10 ? Math.round(mb * 10) / 10 : Math.round(mb)} MB`
}
