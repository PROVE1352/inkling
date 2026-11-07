// ?next= open-redirect guard (docs/adr/0851-*): only same-origin paths survive.
//
// A prefix check ('/' but not '//') is not enough: WHATWG URL parsing treats '\' like '/' and strips
// tab/CR/LF, so '/\evil.com' or '/\t/evil.com' resolve to https://evil.com. We parse exactly the
// way the browser will navigate and keep only pathname + search + hash of a same-origin result.
export function safeNext(
  next: string | null | undefined,
  origin: string = typeof location !== 'undefined' ? location.origin : 'http://localhost',
): string {
  if (!next || !next.startsWith('/')) return '/'
  let url: URL
  try {
    url = new URL(next, origin)
  } catch {
    return '/'
  }
  if (url.origin !== origin) return '/'
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return '/'
  const out = url.pathname + url.search + url.hash
  // Defensive: the normalised path itself must not start a protocol-relative URL.
  return out.startsWith('//') ? '/' : out
}
