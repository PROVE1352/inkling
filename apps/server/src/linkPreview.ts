/**
 * Link preview: fetch the head of an external HTML page through safeFetch and extract
 * Open Graph / Twitter / <title> / description / favicon metadata.
 *
 * - Parsing is a single forward scan with a hand-written attribute tokenizer (no regex over
 *   the document → no ReDoS), bounded by the safeFetch byte cap and stopping at </head>.
 * - Results are kept in an in-memory LRU (entry cap + TTL, shorter TTL for failures) and
 *   concurrent requests for the same URL share one fetch.
 * - Images are returned as https URLs only; the client hotlinks them with
 *   referrerpolicy=no-referrer (no image proxy). See docs/adr/0502-link-preview-cache-and-thumbnails.md.
 */
import type { LinkPreviewDTO } from '@inkling/shared'
import { safeFetch, SafeFetchError } from './safeFetch'

const MAX_HTML_BYTES = 256 * 1024
const FETCH_TIMEOUT_MS = 6000
const CACHE_MAX = 1000
const CACHE_TTL_MS = 6 * 60 * 60 * 1000
const NEG_CACHE_TTL_MS = 10 * 60 * 1000
const MAX_URL_LEN = 2048

// ---------------------------------------------------------------------------
// HTML head scanner
// ---------------------------------------------------------------------------

interface Tag {
  name: string
  attrs: Map<string, string>
  /** Index just past the closing '>' of the start tag. */
  end: number
}

const isSpace = (c: number) => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d

/**
 * Parse the start tag beginning at html[i] === '<'. Returns null for non-element markup.
 * Linear in the tag length; attribute count is capped.
 */
const MAX_TAG_LEN = 8192

function parseTag(html: string, i: number): Tag | null {
  let j = i + 1
  // Bound the work per tag so pathological markup stays linear overall.
  const n = Math.min(html.length, i + MAX_TAG_LEN)
  const nameStart = j
  while (j < n && /[A-Za-z0-9!/-]/.test(html[j])) j++
  const name = html.slice(nameStart, j).toLowerCase()
  if (!name) return null
  const attrs = new Map<string, string>()
  let guard = 0
  while (j < n && guard++ < 64) {
    while (j < n && isSpace(html.charCodeAt(j))) j++
    if (j >= n) break
    const ch = html[j]
    if (ch === '>') return { name, attrs, end: j + 1 }
    if (ch === '/') {
      j++
      continue
    }
    const aStart = j
    while (j < n && !isSpace(html.charCodeAt(j)) && html[j] !== '=' && html[j] !== '>' && html[j] !== '/') j++
    const aName = html.slice(aStart, j).toLowerCase()
    while (j < n && isSpace(html.charCodeAt(j))) j++
    let value = ''
    if (html[j] === '=') {
      j++
      while (j < n && isSpace(html.charCodeAt(j))) j++
      const q = html[j]
      if (q === '"' || q === "'") {
        const close = html.indexOf(q, j + 1)
        if (close < 0 || close >= n) return null
        value = html.slice(j + 1, close)
        j = close + 1
      } else {
        const vStart = j
        while (j < n && !isSpace(html.charCodeAt(j)) && html[j] !== '>') j++
        value = html.slice(vStart, j)
      }
    }
    if (aName && !attrs.has(aName)) attrs.set(aName, value)
  }
  // Skip to the end of an over-long tag.
  const gt = html.indexOf('>', j)
  return gt < 0 || gt >= n ? null : { name, attrs, end: gt + 1 }
}

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" }

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z]{2,8});/g, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return m
      return String.fromCodePoint(code)
    }
    return NAMED[e.toLowerCase()] ?? m
  })
}

function clean(s: string | undefined | null, max: number): string | null {
  if (!s) return null
  // eslint-disable-next-line no-control-regex
  const t = decodeEntities(s).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (!t) return null
  return t.length > max ? t.slice(0, max - 1) + '…' : t
}

function absHttps(raw: string | undefined | null, base: string): string | null {
  if (!raw) return null
  try {
    const u = new URL(decodeEntities(raw.trim()), base)
    if (u.protocol !== 'https:' || u.username || u.password) return null
    return u.href.length <= MAX_URL_LEN ? u.href : null
  } catch {
    return null
  }
}

export interface HeadMeta {
  title: string | null
  description: string | null
  siteName: string | null
  image: string | null
  favicon: string | null
}

/** Extract preview metadata from (the beginning of) an HTML document. */
export function extractHeadMeta(html: string, baseUrl: string): HeadMeta {
  const meta = new Map<string, string>()
  let title: string | null = null
  let icon: string | null = null
  let iconRank = 0
  // ASCII-only lower-casing keeps indices aligned with `html` (String#toLowerCase may not).
  const lower = html.replace(/[A-Z]+/g, (m) => m.toLowerCase())
  const lastGt = html.lastIndexOf('>')
  let i = 0
  let tags = 0
  while (i < html.length && tags++ < 4000) {
    const lt = html.indexOf('<', i)
    if (lt < 0 || lt > lastGt) break
    // Skip comments wholesale.
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4)
      if (end < 0) break
      i = end + 3
      continue
    }
    const tag = parseTag(html, lt)
    if (!tag) {
      i = lt + 1
      continue
    }
    i = tag.end
    if (tag.name === '/head' || tag.name === 'body') break
    if (tag.name === 'script' || tag.name === 'style' || tag.name === 'noscript') {
      const close = lower.indexOf(`</${tag.name}`, i)
      if (close < 0) break
      i = close
      continue
    }
    if (tag.name === 'title' && title === null) {
      const close = lower.indexOf('</title', i)
      title = html.slice(i, close < 0 ? Math.min(html.length, i + 1000) : close)
      if (close >= 0) i = close
      continue
    }
    if (tag.name === 'meta') {
      const key = (tag.attrs.get('property') ?? tag.attrs.get('name') ?? '').toLowerCase().trim()
      const content = tag.attrs.get('content')
      if (key && content !== undefined && !meta.has(key)) meta.set(key, content)
      continue
    }
    if (tag.name === 'link') {
      const rel = (tag.attrs.get('rel') ?? '').toLowerCase()
      const href = tag.attrs.get('href')
      if (!href) continue
      // Prefer a plain "icon" over apple-touch-icon / mask-icon.
      const rank = /(^|\s)(shortcut\s+)?icon(\s|$)/.test(rel) ? 3 : rel.includes('apple-touch-icon') ? 2 : rel.includes('icon') ? 1 : 0
      if (rank > iconRank) {
        icon = href
        iconRank = rank
      }
    }
  }
  const pick = (...keys: string[]) => {
    for (const k of keys) {
      const v = meta.get(k)
      if (v && v.trim()) return v
    }
    return null
  }
  let favicon = absHttps(icon, baseUrl)
  if (!favicon) {
    try {
      const b = new URL(baseUrl)
      if (b.protocol === 'https:') favicon = `${b.origin}/favicon.ico`
    } catch {
      // ignore
    }
  }
  return {
    title: clean(pick('og:title', 'twitter:title') ?? title, 300),
    description: clean(pick('og:description', 'twitter:description', 'description'), 500),
    siteName: clean(pick('og:site_name', 'application-name'), 100),
    image: absHttps(pick('og:image:secure_url', 'og:image', 'og:image:url', 'twitter:image', 'twitter:image:src'), baseUrl),
    favicon,
  }
}

/** Decode bytes using the HTTP charset, then <meta charset>, then UTF-8. */
export function decodeHtml(body: Buffer, contentTypeHeader: string | string[] | undefined): string {
  const header = Array.isArray(contentTypeHeader) ? contentTypeHeader[0] : contentTypeHeader
  let charset = /charset\s*=\s*["']?([A-Za-z0-9_.:-]{1,40})/i.exec(header ?? '')?.[1]
  if (!charset) {
    const sniff = body.subarray(0, 2048).toString('latin1')
    charset = /<meta[^>]{0,200}?charset\s*=\s*["']?([A-Za-z0-9_.:-]{1,40})/i.exec(sniff)?.[1]
  }
  try {
    return new TextDecoder(charset || 'utf-8').decode(body)
  } catch {
    return new TextDecoder('utf-8').decode(body)
  }
}

// ---------------------------------------------------------------------------
// Cache + fetch
// ---------------------------------------------------------------------------

type CacheEntry = { at: number; value: LinkPreviewDTO | null }
const cache = new Map<string, CacheEntry>()
const inflight = new Map<string, Promise<LinkPreviewDTO | null>>()

function cacheGet(key: string): CacheEntry | undefined {
  const e = cache.get(key)
  if (!e) return undefined
  const ttl = e.value ? CACHE_TTL_MS : NEG_CACHE_TTL_MS
  if (Date.now() - e.at > ttl) {
    cache.delete(key)
    return undefined
  }
  // LRU: move to the most-recent end.
  cache.delete(key)
  cache.set(key, e)
  return e
}

function cacheSet(key: string, value: LinkPreviewDTO | null): void {
  cache.delete(key)
  cache.set(key, { at: Date.now(), value })
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}

/** Normalise a user-supplied URL into a cache key; throws SafeFetchError('invalid_url'). */
export function normalizePreviewUrl(raw: string): string {
  if (raw.length > MAX_URL_LEN) throw new SafeFetchError('invalid_url', 'URL too long')
  let u: URL
  try {
    u = new URL(raw.trim())
  } catch {
    throw new SafeFetchError('invalid_url', 'Invalid URL')
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new SafeFetchError('scheme_not_allowed', 'Unsupported scheme')
  u.hash = ''
  return u.href
}

async function fetchPreview(url: string): Promise<LinkPreviewDTO | null> {
  try {
    const res = await safeFetch(url, {
      allowHttp: true,
      maxBytes: MAX_HTML_BYTES,
      truncate: true,
      timeoutMs: FETCH_TIMEOUT_MS,
      connectTimeoutMs: 3000,
      headers: { accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1' },
    })
    if (res.status < 200 || res.status >= 300) return null
    const isHtml = res.contentType === 'text/html' || res.contentType === 'application/xhtml+xml'
    if (!isHtml) {
      // Not a page (PDF, image, …): a bare card with the final URL is still useful.
      return { url: res.url, title: null, description: null, siteName: null, image: null, favicon: null }
    }
    const meta = extractHeadMeta(decodeHtml(res.body, res.headers['content-type']), res.url)
    return { url: res.url, ...meta }
  } catch (e) {
    if (e instanceof SafeFetchError) return null
    throw e
  }
}

/** Cached, de-duplicated preview lookup. Returns null when no preview is available. */
export async function getLinkPreview(rawUrl: string): Promise<LinkPreviewDTO | null> {
  const key = normalizePreviewUrl(rawUrl)
  const hit = cacheGet(key)
  if (hit) return hit.value
  const pending = inflight.get(key)
  if (pending) return pending
  const p = fetchPreview(key)
    .then((v) => {
      cacheSet(key, v)
      return v
    })
    .finally(() => inflight.delete(key))
  inflight.set(key, p)
  return p
}

/** Test hook. */
export function _clearLinkPreviewCache(): void {
  cache.clear()
}
