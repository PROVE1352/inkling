/**
 * Server-side fetch of a page to clip (docs/adr/2261-*), through safeFetch (docs/adr/0500-*): public
 * addresses only (loopback, private, link-local, CGNAT … refused, every redirect hop re-checked, the
 * socket pinned to the checked address), http or https on ports 80/443, at most 3 redirects, a total
 * deadline, a byte cap (a longer page is cut, not refused) and HTML content types only (a PDF or an
 * image is never read).
 *
 * Test mode: CLIP_TEST_ALLOW_LOOPBACK=1 (ignored when NODE_ENV=production) additionally permits
 * 127.0.0.0/8 and ::1 on any port, so database tests can serve pages from a local HTTP server.
 * Private and link-local addresses stay refused even then.
 */
import { decodeHtml } from '../linkPreview'
import { safeFetch, SafeFetchError } from '../safeFetch'

/**
 * Bytes of HTML read (the rest of a longer page is dropped) and the deadline of the whole fetch,
 * redirects and body included. An object so tests can shorten them.
 */
export const clipFetchLimits = { maxBytes: 2 * 1024 * 1024, timeoutMs: 10_000 }

export type FetchArticleResult =
  | { ok: true; url: string; html: string; truncatedBytes: boolean }
  | { ok: false; reason: 'fetch_failed' | 'not_html' }

function testLoopback(): boolean {
  return process.env.CLIP_TEST_ALLOW_LOOPBACK === '1' && process.env.NODE_ENV !== 'production'
}

export async function fetchArticleHtml(
  url: string,
  opts: { timeoutMs?: number; maxBytes?: number; acceptLanguage?: string } = {},
): Promise<FetchArticleResult> {
  try {
    const res = await safeFetch(url, {
      allowHttp: true,
      maxBytes: opts.maxBytes ?? clipFetchLimits.maxBytes,
      truncate: true,
      timeoutMs: opts.timeoutMs ?? clipFetchLimits.timeoutMs,
      connectTimeoutMs: 3000,
      maxRedirects: 3,
      allowedContentTypes: ['text/html', 'application/xhtml+xml'],
      headers: {
        accept: 'text/html,application/xhtml+xml;q=0.9',
        ...(opts.acceptLanguage ? { 'accept-language': opts.acceptLanguage } : {}),
      },
      ...(testLoopback() ? { unsafeAllowLoopbackForTests: true } : {}),
    })
    if (res.status < 200 || res.status >= 300) return { ok: false, reason: 'fetch_failed' }
    // (A response without a Content-Type fails the content-type check above as not HTML.)
    return { ok: true, url: res.url, html: decodeHtml(res.body, res.headers['content-type']), truncatedBytes: res.truncated }
  } catch (e) {
    if (e instanceof SafeFetchError) return { ok: false, reason: e.code === 'content_type' ? 'not_html' : 'fetch_failed' }
    throw e
  }
}
