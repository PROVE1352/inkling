/**
 * Article extraction for the web clipper (docs/adr/2261-*).
 *
 * The HTML is parsed with the DOM the server already carries: @blocknote/server-util's JSDOM window
 * (md/editor.ts). A document made by DOMParser runs no scripts and loads no resources, so parsing a
 * fetched page contacts nothing. On that DOM:
 *
 *  1. junk is removed: scripts, styles, frames, forms, embedded media, navigation, hidden elements and
 *     blocks whose class/id says comments, share bars, related links, ads (the "unlikely candidate"
 *     rule of Firefox's reader mode);
 *  2. the article root is chosen: a semantic container (`[itemprop=articleBody]`, `article`, `main`,
 *     `[role=main]`) with enough text, else the element whose paragraphs score highest (paragraph
 *     length and commas, class/id hints, link density — a small version of Readability's scoring);
 *  3. the root is rebuilt from an allow-list: text, paragraphs, headings, lists, quotes, code, tables,
 *     figures, emphasis, links (http, https, mailto; relative ones made absolute) and https images.
 *     Every attribute but href/src/alt/colspan/rowspan is dropped, so `on*`, `style` and `javascript:`
 *     never reach the blocks;
 *  4. the text is cut at `maxChars` (the rest of the document is dropped, `truncated` says so).
 *
 * `null` means no article body was found (the clip is then saved as a link).
 */
import { getServerEditor } from '../md/editor'
import { extractHeadMeta } from '../linkPreview'

/** Most characters of article text kept (the rest is cut, `truncated`). */
export const CLIP_ARTICLE_MAX_CHARS = 100_000
/** Fewer characters than this is not an article (a login wall, a video page, an empty shell). */
export const CLIP_ARTICLE_MIN_CHARS = 140
/** Most images kept from one article. */
const MAX_IMAGES = 100
/** Most characters of HTML handed to the DOM parser (the fetch already caps bytes). */
const MAX_PARSE_CHARS = 3_000_000
/**
 * Deepest element nesting parsed. JSDOM's parser and every subtree walk get slow on pathological
 * nesting (3,000 nested <div>s: 9 s to parse alone), real pages stay far below; deeper is not an article.
 */
export const CLIP_MAX_NESTING = 400

/** Most start tags parsed: the HTML is cut before the next one (JSDOM builds a CSS declaration object per element: 40k elements took 0.5–1.8 s). */
export const CLIP_MAX_TAGS = 20_000

/** Elements whose end tag is often left out (they close themselves) or that never have one. */
const NO_DEPTH = new Set(['p', 'li', 'dt', 'dd', 'tr', 'td', 'th', 'option', 'optgroup', 'rb', 'rt', 'rp', 'tbody', 'thead', 'tfoot', 'colgroup',
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr', 'html', 'head', 'body'])
/** Elements whose content is never wanted and may hold "<" characters that are not tags. */
const RAW_TEXT = new Set(['script', 'style', 'noscript', 'template', 'xmp', 'textarea'])

/**
 * One linear pass over the markup before it is parsed: drops comments and the content of scripts,
 * styles and templates (fewer nodes to build, and their text never reaches the article), counts the
 * start tags (cut after CLIP_MAX_TAGS) and estimates the deepest nesting. The tag pattern stops at the
 * next "<" or ">", so markup without closing ">" cannot make it scan the rest of the page per tag.
 */
export function prepareHtml(html: string): { html: string; depth: number; cut: boolean } {
  // ASCII-only lower-casing keeps indices aligned with `html`
  const lower = html.replace(/[A-Z]+/g, (x) => x.toLowerCase())
  const re = /<!--|<(\/?)([a-zA-Z][a-zA-Z0-9-]{0,30})(?:\s[^<>]{0,8192})?(\/?)>/g
  let out = ''
  let last = 0
  let depth = 0
  let max = 0
  let tags = 0
  let cut = false
  for (let m = re.exec(lower); m; m = re.exec(lower)) {
    if (m[0] === '<!--') {
      const end = lower.indexOf('-->', m.index + 4)
      out += html.slice(last, m.index)
      last = end < 0 ? html.length : end + 3
      re.lastIndex = last
      continue
    }
    const tag = m[2]
    if (!m[1] && RAW_TEXT.has(tag)) {
      out += html.slice(last, m.index)
      const close = lower.indexOf(`</${tag}`, re.lastIndex)
      const gt = close < 0 ? -1 : lower.indexOf('>', close)
      last = gt < 0 ? html.length : gt + 1
      re.lastIndex = last
      continue
    }
    if (!m[1] && ++tags > CLIP_MAX_TAGS) {
      out += html.slice(last, m.index)
      last = html.length
      cut = true
      break
    }
    if (NO_DEPTH.has(tag) || m[3]) continue
    if (m[1]) depth = Math.max(0, depth - 1)
    else if (++depth > max) max = depth
  }
  out += html.slice(last)
  return { html: out, depth: max, cut }
}

// ---------------------------------------------------------------------------
// Minimal structural DOM types (the server compiles without the DOM lib)
// ---------------------------------------------------------------------------

interface DNode {
  nodeType: number
  parentNode: DNode | null
  childNodes: ArrayLike<DNode>
  nextSibling: DNode | null
  textContent: string | null
  removeChild(n: DNode): DNode
  insertBefore(n: DNode, ref: DNode | null): DNode
  appendChild(n: DNode): DNode
  cloneNode(deep: boolean): DNode
}
interface DText extends DNode {
  data: string
}
interface DElement extends DNode {
  localName: string
  attributes: ArrayLike<{ name: string; value: string }>
  children: ArrayLike<DElement>
  innerHTML: string
  firstElementChild: DElement | null
  nextElementSibling: DElement | null
  getAttribute(n: string): string | null
  setAttribute(n: string, v: string): void
  removeAttribute(n: string): void
  querySelector(sel: string): DElement | null
  querySelectorAll(sel: string): ArrayLike<DElement>
  remove(): void
}
interface DDocument {
  body: DElement | null
  querySelector(sel: string): DElement | null
  querySelectorAll(sel: string): ArrayLike<DElement>
  createElement(tag: string): DElement
}

const ELEMENT = 1
const TEXT = 3

function parseDocument(html: string): DDocument {
  const win = (getServerEditor() as unknown as { jsdom?: { window?: { DOMParser: new () => { parseFromString(s: string, t: string): DDocument } } } }).jsdom?.window
  if (!win) throw new Error('server DOM is unavailable')
  return new win.DOMParser().parseFromString(html, 'text/html')
}

const arr = <T>(list: ArrayLike<T>): T[] => Array.from(list)

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

/** A link target kept in a clip: absolute http(s) or mailto, else null (javascript:, data:, …). */
export function clipLinkHref(raw: string | null | undefined, base: string): string | null {
  if (!raw) return null
  // getAttribute values are already entity-decoded by the parser
  const t = raw.trim()
  if (!t || t.startsWith('#')) return null
  try {
    const u = new URL(t, base)
    if (u.protocol === 'mailto:') return u.href.length <= 2048 ? u.href : null
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    if (u.username || u.password) return null
    return u.href.length <= 2048 ? u.href : null
  } catch {
    return null
  }
}

/** An image source kept in a clip: absolute https only (the app's CSP allows `img-src https:`). */
export function clipImageSrc(raw: string | null | undefined, base: string): string | null {
  const href = clipLinkHref(raw, base)
  return href && href.startsWith('https://') ? href : null
}

// ---------------------------------------------------------------------------
// Junk removal
// ---------------------------------------------------------------------------

const DROP_TAGS = new Set([
  'script', 'style', 'noscript', 'template', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet',
  'form', 'input', 'button', 'select', 'textarea', 'option', 'optgroup', 'label', 'fieldset', 'legend',
  'svg', 'math', 'canvas', 'video', 'audio', 'source', 'track', 'picture-source', 'link', 'meta', 'base',
  'nav', 'footer', 'aside', 'dialog', 'map', 'area', 'portal', 'head', 'title', 'menu',
])

/** class/id words of things around an article (Firefox reader mode's "unlikely candidates"). */
const UNLIKELY =
  /-ad-|^ad-|ad-break|advert|agegate|banner|breadcrumb|combx|comment|community|cookie|disqus|extra|footer|gdpr|^header|legends|menu|newsletter|pager|pagination|popup|promo|recommend|related|remark|replies|rss|share|shoutbox|sidebar|skyscraper|social|sponsor|subscribe|supplemental|tool-?bar|yom-remote/i
const MAYBE = /and|article|body|column|content|main|shadow|post|entry|story/i
const POSITIVE = /article|body|content|entry|hentry|h-entry|main|page|post|text|blog|story/i
const NEGATIVE =
  /-ad-|hidden|^hid$| hid$| hid |^hid |banner|combx|comment|com-|contact|footer|gdpr|masthead|media|meta|outbrain|promo|related|scroll|share|shoutbox|sidebar|skyscraper|sponsor|shopping|tags|widget/i

function matchString(el: DElement): string {
  return `${el.getAttribute('class') ?? ''} ${el.getAttribute('id') ?? ''}`
}

function isHidden(el: DElement): boolean {
  if (el.getAttribute('hidden') !== null) return true
  if (el.getAttribute('aria-hidden') === 'true') return true
  const style = (el.getAttribute('style') ?? '').toLowerCase().replace(/\s+/g, '')
  return style.includes('display:none') || style.includes('visibility:hidden')
}

const JUNK_ROLES = new Set(['navigation', 'banner', 'contentinfo', 'complementary', 'dialog', 'alert'])

/**
 * Removes junk in one walk over the elements (firstElementChild / nextElementSibling: a generic
 * querySelectorAll('*') with attribute reads costs JSDOM far more on a large page). Junk subtrees are
 * collected and removed afterwards, without descending into them.
 */
function removeJunk(doc: DDocument): void {
  const body = doc.body
  if (!body) return
  for (const el of arr(doc.querySelectorAll('head'))) el.remove()
  const junk: DElement[] = []
  const stack: DElement[] = []
  for (let c = body.firstElementChild; c; c = c.nextElementSibling) stack.push(c)
  while (stack.length) {
    const el = stack.pop()!
    const tag = el.localName
    const role = el.getAttribute('role')
    let drop = DROP_TAGS.has(tag) || (role !== null && JUNK_ROLES.has(role)) || isHidden(el)
    // A page-wide header (site name, menus) outside the article.
    if (!drop && tag === 'header' && el.parentNode === body) drop = true
    if (!drop && tag !== 'article' && tag !== 'main' && tag !== 'a') {
      const m = matchString(el)
      if (m.trim() && UNLIKELY.test(m) && !MAYBE.test(m) && !el.querySelector('article,main,[itemprop~="articleBody"]')) drop = true
    }
    if (drop) {
      junk.push(el)
      continue
    }
    for (let c = el.firstElementChild; c; c = c.nextElementSibling) stack.push(c)
  }
  for (const el of junk) el.remove()
}

// ---------------------------------------------------------------------------
// Root selection
// ---------------------------------------------------------------------------

const textOf = (n: DNode): string => (n.textContent ?? '').replace(/\s+/g, ' ').trim()
const CJK = /[\u1100-\u11ff\u3040-\u30ff\u3130-\u318f\u3400-\u9fff\uac00-\ud7af]/g
/** Length for the "enough text" checks: CJK characters count double (they carry more per character). */
export const weightedLength = (s: string): number => s.length + (s.match(CJK)?.length ?? 0)

function linkDensity(el: DElement, len: number): number {
  if (len === 0) return 0
  let links = 0
  for (const a of arr(el.querySelectorAll('a'))) links += textOf(a).length
  return links / len
}

function classWeight(el: DElement): number {
  let w = 0
  for (const v of [el.getAttribute('class'), el.getAttribute('id')]) {
    if (!v) continue
    if (NEGATIVE.test(v)) w -= 25
    if (POSITIVE.test(v)) w += 25
  }
  return w
}

function tagBase(tag: string): number {
  if (tag === 'div' || tag === 'article' || tag === 'section' || tag === 'main') return 5
  if (tag === 'pre' || tag === 'td' || tag === 'blockquote') return 3
  if (tag === 'address' || tag === 'ol' || tag === 'ul' || tag === 'dl' || tag === 'dd' || tag === 'dt' || tag === 'li') return -3
  if (/^h[1-6]$/.test(tag) || tag === 'th') return -5
  return 0
}

const BLOCK_CHILD = new Set(['p', 'div', 'table', 'ul', 'ol', 'pre', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'section', 'article', 'figure'])

function pickRoot(doc: DDocument): DElement | null {
  const body = doc.body
  if (!body) return null
  // 1. A semantic container with enough text and not mostly links.
  let semantic: { el: DElement; len: number } | null = null
  for (const el of arr(body.querySelectorAll('[itemprop~="articleBody"],article,main,[role="main"]'))) {
    const t = textOf(el)
    const len = t.length
    if (weightedLength(t) < CLIP_ARTICLE_MIN_CHARS || linkDensity(el, len) > 0.5) continue
    // The most specific one wins over a page-wide <main> that holds it: prefer articleBody, then the
    // longest <article>; <main> only when nothing narrower qualified.
    const rank = (e: DElement) => (e.getAttribute('itemprop')?.includes('articleBody') ? 3 : e.localName === 'article' ? 2 : 1)
    if (!semantic || rank(el) > rank(semantic.el) || (rank(el) === rank(semantic.el) && len > semantic.len)) semantic = { el, len }
  }
  if (semantic) return semantic.el

  // 2. Paragraph scoring.
  const scores = new Map<DElement, number>()
  const add = (el: DNode | null, s: number) => {
    if (!el || (el as DElement).localName === undefined || el.nodeType !== ELEMENT) return
    const e = el as DElement
    if (!scores.has(e)) scores.set(e, tagBase(e.localName) + classWeight(e))
    scores.set(e, scores.get(e)! + s)
  }
  const paragraphs = arr(body.querySelectorAll('p,pre,td,blockquote,div'))
  for (const p of paragraphs) {
    // A <div> counts as a paragraph only when it holds no blocks itself (blogs write <div>text<br>text</div>).
    if (p.localName === 'div' && arr(p.children).some((c) => BLOCK_CHILD.has(c.localName))) continue
    const text = textOf(p)
    if (text.length < 25) continue
    const s = 1 + (text.match(/[,，、]/g)?.length ?? 0) + Math.min(Math.floor(text.length / 100), 3)
    const parent = p.parentNode
    add(parent, s)
    add(parent?.parentNode ?? null, s / 2)
    add(parent?.parentNode?.parentNode ?? null, s / 3)
  }
  let best: { el: DElement; score: number } | null = null
  for (const [el, raw] of scores) {
    const len = textOf(el).length
    const score = raw * (1 - linkDensity(el, len))
    if (!best || score > best.score) best = { el, score }
  }
  if (best && weightedLength(textOf(best.el)) >= CLIP_ARTICLE_MIN_CHARS) return best.el
  // 3. The whole body, when it reads like text.
  const all = textOf(body)
  return weightedLength(all) >= CLIP_ARTICLE_MIN_CHARS && linkDensity(body, all.length) < 0.5 ? body : null
}

// ---------------------------------------------------------------------------
// Rebuild from an allow-list
// ---------------------------------------------------------------------------

const KEEP_BLOCK = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'pre', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'figure', 'figcaption', 'hr', 'caption'])
const KEEP_INLINE = new Set(['a', 'br', 'code', 'strong', 'b', 'em', 'i', 'u', 's', 'del', 'strike', 'img', 'sub', 'sup'])
/** Unknown containers that become a paragraph when they hold only inline content. */
const BLOCKISH = new Set(['div', 'section', 'article', 'main', 'header', 'center', 'dd', 'dt', 'dl', 'address', 'details', 'summary', 'hgroup'])

interface Ctx {
  base: string
  title: string | null
  maxChars: number
  /** Characters of text written so far (whitespace runs count once). */
  chars: number
  images: number
  /** Set when the text cap was reached: nothing more is written. */
  stopped: boolean
  /** The first heading was looked at (a heading repeating the page title is dropped). */
  sawHeading: boolean
}

function hasBlockChild(el: DElement): boolean {
  return arr(el.children).some((c) => KEEP_BLOCK.has(c.localName) || c.localName === 'img' || BLOCKISH.has(c.localName))
}

function imageSource(el: DElement, base: string): string | null {
  for (const attr of ['src', 'data-src', 'data-original', 'data-lazy-src', 'data-url']) {
    const v = el.getAttribute(attr)
    if (v && !v.trim().toLowerCase().startsWith('data:')) {
      const src = clipImageSrc(v, base)
      if (src) return src
    }
  }
  const srcset = el.getAttribute('srcset') ?? el.getAttribute('data-srcset')
  const first = srcset?.split(',')[0]?.trim().split(/\s+/)[0]
  return clipImageSrc(first, base)
}

/** A 1×1 (or 2×2) image is a tracking pixel. */
function isPixel(el: DElement): boolean {
  const n = (a: string) => {
    const v = el.getAttribute(a)
    return v !== null && /^\s*\d+/.test(v) ? parseInt(v, 10) : null
  }
  const w = n('width')
  const h = n('height')
  return (w !== null && w <= 2) || (h !== null && h <= 2)
}

const escText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const escAttr = (s: string) => escText(s).replace(/"/g, '&quot;')
/** Serialized markup has some text or an image (an empty paragraph or list item is dropped). */
const hasContent = (html: string) => /<img /.test(html) || /\S/.test(html.replace(/<[^>]*>/g, '').replace(/&nbsp;|\u00a0/g, ''))

/**
 * Writes `node`'s children as allow-listed HTML. Read-only on the DOM (JSDOM mutations cost a
 * fraction of a millisecond each, so moving thousands of nodes took seconds on a large page): the
 * output is built as a string from what the walk accepts, with every text and attribute escaped.
 */
function serializeChildren(node: DNode, ctx: Ctx, pre: boolean): string {
  let out = ''
  for (const child of arr(node.childNodes)) {
    if (ctx.stopped) break
    if (child.nodeType === TEXT) {
      const raw = (child as DText).data
      const len = pre ? raw.length : raw.replace(/\s+/g, ' ').length
      if (ctx.chars + len > ctx.maxChars) {
        const keep = Math.max(0, ctx.maxChars - ctx.chars)
        out += escText(Array.from(raw).slice(0, keep).join('')) + '…'
        ctx.chars = ctx.maxChars
        ctx.stopped = true
        break
      }
      ctx.chars += len
      out += escText(raw)
      continue
    }
    if (child.nodeType !== ELEMENT) continue // comments, processing instructions
    out += serializeElement(child as DElement, ctx, pre)
  }
  return out
}

function serializeElement(el: DElement, ctx: Ctx, pre: boolean): string {
  const tag = el.localName
  if (DROP_TAGS.has(tag)) return ''
  if (tag === 'img') {
    const src = imageSource(el, ctx.base)
    if (!src || isPixel(el) || ctx.images >= MAX_IMAGES) return ''
    ctx.images++
    const alt = (el.getAttribute('alt') ?? '').slice(0, 300)
    return `<img src="${escAttr(src)}"${alt ? ` alt="${escAttr(alt)}"` : ''}>`
  }
  if (tag === 'br') return '<br>'
  if (tag === 'hr') return '<hr>'
  if (/^h[1-6]$/.test(tag) && !ctx.sawHeading) {
    ctx.sawHeading = true
    // The page title is the page's own title: a first heading that repeats it is dropped.
    if (ctx.title && textOf(el).toLowerCase() === ctx.title.toLowerCase()) return ''
  }
  const inner = serializeChildren(el, ctx, pre || tag === 'pre')
  if (tag === 'a') {
    const href = clipLinkHref(el.getAttribute('href'), ctx.base)
    return href && hasContent(inner) ? `<a href="${escAttr(href)}">${inner}</a>` : inner
  }
  if (KEEP_BLOCK.has(tag) || KEEP_INLINE.has(tag)) {
    if (!hasContent(inner) && tag !== 'td' && tag !== 'th' && tag !== 'tr') return ''
    let attrs = ''
    if (tag === 'td' || tag === 'th') {
      for (const a of ['colspan', 'rowspan']) {
        const v = el.getAttribute(a)
        if (v && /^\d{1,3}$/.test(v.trim())) attrs += ` ${a}="${v.trim()}"`
      }
    }
    return `<${tag}${attrs}>${inner}</${tag}>`
  }
  if (BLOCKISH.has(tag)) {
    if (!hasContent(inner)) return ''
    return hasBlockChild(el) ? inner : `<p>${inner}</p>`
  }
  // span, font, time, mark, small, picture, … : the content only
  return inner
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface ExtractedArticle {
  /** og:title / twitter:title / <title>, entity-decoded (null when the page has none). */
  title: string | null
  siteName: string | null
  /** Clean HTML of the article body (allow-listed tags, absolute links, https images). */
  html: string
  /** Characters of text kept. */
  textLength: number
  truncated: boolean
}

export function extractArticle(rawHtml: string, pageUrl: string, opts: { maxChars?: number } = {}): ExtractedArticle | null {
  const html = rawHtml.length > MAX_PARSE_CHARS ? rawHtml.slice(0, MAX_PARSE_CHARS) : rawHtml
  const meta = extractHeadMeta(html, pageUrl)
  const prepared = prepareHtml(html)
  if (prepared.depth > CLIP_MAX_NESTING) return null
  const doc = parseDocument(prepared.html)
  // Relative links resolve against <base href> (itself resolved against the page URL), else the page URL.
  let base = pageUrl
  const baseHref = doc.querySelector('base[href]')?.getAttribute('href')
  if (baseHref) {
    const b = clipLinkHref(baseHref, pageUrl)
    if (b && !b.startsWith('mailto:')) base = b
  }
  removeJunk(doc)
  const root = pickRoot(doc)
  if (!root) return null
  const maxChars = opts.maxChars ?? CLIP_ARTICLE_MAX_CHARS
  const ctx: Ctx = { base, title: meta.title, maxChars, chars: 0, images: 0, stopped: false, sawHeading: false }
  const out = BLOCKISH.has(root.localName) || root.localName === 'body' ? serializeChildren(root, ctx, false) : serializeElement(root, ctx, false)
  // Too little text left to be an article.
  if (weightedLength(out.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()) < CLIP_ARTICLE_MIN_CHARS) return null
  const truncated = ctx.stopped || prepared.cut
  return {
    title: meta.title,
    siteName: meta.siteName,
    html: out,
    textLength: ctx.chars,
    truncated,
  }
}
