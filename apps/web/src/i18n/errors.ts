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
export function localizeApiError(code: string, serverMessage: string | undefined): string {
  const msg = serverMessage && serverMessage !== code ? serverMessage : ''
  const locale = getLocale()
  if (locale === 'en') return msg || tMaybe(`errors.${code}`, { message: msg }) || tMaybe('errors.INTERNAL')!
  const exact = msg ? byMessage[locale]?.[msg] : undefined
  if (exact) return exact
  return tMaybe(`errors.${code}`, { message: msg }) || msg || tMaybe('errors.INTERNAL')!
}
