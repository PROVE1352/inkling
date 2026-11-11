// Allowlist HTML sanitizer for public share pages (docs/adr/0852-public-share-html-sanitizer.md).
//
// The server renders blocks → HTML with BlockNote (`blocksToFullHTML`) and already neutralises
// internal links and rewrites asset URLs. This is the second, client-side layer before
// `dangerouslySetInnerHTML`: anything the renderer (or a future block type, or a bug) lets through
// that is not on these lists is removed. No dependency: the browser's inert DOMParser does the
// parsing (scripts never run, images never load in a DOMParser document).
//
// Rules
// - Elements: HTML formatting/structure tags and a tiny SVG subset (svg, path — BlockNote's
//   toggle/file icons). Dangerous containers (script, style, iframe, object, template, math,
//   foreign SVG, forms, …) are removed with their content; other unknown elements are unwrapped
//   (their text survives).
// - Attributes: per-element allowlist + `class`, `data-*`, `aria-*`; every `on*` handler and
//   anything not listed is dropped.
// - URLs (`href`, `src`): http(s) anywhere; `mailto:` for links only; same-origin paths only under
//   the public-share prefixes. Everything else (javascript:, data:, blob:, vbscript:, //host,
//   `/\host`, …) is dropped after URL parsing, exactly as the browser would resolve it.
// - `style`: kept declaration by declaration for a few layout properties with plain values
//   (no `url(`, `expression(`, `javascript:`, escapes, quotes or comments).

type ParseFn = (html: string) => Document

export type SanitizeOptions = {
  /** Origin used to resolve relative URLs (defaults to location.origin). */
  origin?: string
  /** HTML parser — defaults to the browser's DOMParser (tests pass jsdom's). */
  parse?: ParseFn
}

const SVG_NS = 'http://www.w3.org/2000/svg'
const HTML_NS = 'http://www.w3.org/1999/xhtml'

/** Removed together with everything inside them. */
const DROP_WITH_CONTENT = new Set([
  'script', 'style', 'template', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet',
  'noscript', 'noembed', 'noframes', 'xmp', 'plaintext', 'math', 'form', 'textarea', 'select',
  'option', 'title', 'meta', 'link', 'base', 'head', 'portal', 'fencedframe', 'canvas', 'dialog',
])

const GLOBAL_ATTRS = new Set(['class', 'title', 'dir', 'lang', 'role'])

/** HTML element → extra allowed attributes (besides GLOBAL_ATTRS, data-*, aria-*). */
const HTML_ALLOWED: Record<string, readonly string[]> = {
  a: ['href', 'target', 'rel'],
  abbr: [], b: [], blockquote: [], br: [], caption: [], cite: [], code: [], del: [], details: ['open'],
  div: ['style'], em: [], figcaption: [], figure: ['style'], h1: [], h2: [], h3: [], h4: [], h5: [],
  h6: [], hr: [], i: [], ins: [], kbd: [], li: ['value'], mark: [], ol: ['start', 'type', 'reversed'],
  p: ['style'], pre: [], q: [], s: [], samp: [], small: [], span: ['style'], strong: [], sub: [],
  summary: [], sup: [], u: [], ul: [], var: [], wbr: [],
  table: ['style'], thead: [], tbody: [], tfoot: [], tr: [], colgroup: ['span'], col: ['span', 'style', 'width'],
  td: ['colspan', 'rowspan', 'colwidth', 'style'], th: ['colspan', 'rowspan', 'colwidth', 'scope', 'style'],
  img: ['src', 'alt', 'width', 'height', 'draggable', 'loading'],
  video: ['src', 'controls', 'width', 'height', 'draggable', 'preload', 'playsinline', 'muted', 'loop'],
  audio: ['src', 'controls', 'draggable', 'preload', 'loop', 'muted'],
  source: ['src', 'type'],
  // BlockNote check list / toggle markup (inert: checkbox forced disabled, button forced type=button)
  input: ['type', 'checked', 'disabled'],
  button: ['type'],
}

const SVG_ALLOWED: Record<string, readonly string[]> = {
  svg: ['xmlns', 'viewbox', 'width', 'height', 'fill', 'stroke', 'stroke-width', 'aria-hidden'],
  path: ['d', 'fill', 'stroke', 'stroke-width', 'fill-rule', 'clip-rule'],
}

/** Same-origin path prefixes allowed in href/src (public share assets and folder-share pages). */
const SAME_ORIGIN_PREFIXES = ['/api/public/', '/files/', '/s/']

const STYLE_PROPS = new Set([
  'width', 'height', 'min-width', 'max-width', 'position', 'left', 'right', 'top', 'bottom',
  'display', 'text-align', 'vertical-align', '--default-cell-min-width',
  // a column's width in a group of columns (docs/adr/2420-*): a plain number
  'flex-grow',
])
/** Plain CSS values only: words, numbers, units, %, #hex, commas, parentheses for calc()/fit-content. */
const STYLE_VALUE_RE = /^[-\w\s.,%#()]+$/
const STYLE_BAD_RE = /url\s*\(|expression\s*\(|image-set|javascript:|@import|\\|\/\*/i

function defaultParse(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html')
}

function defaultOrigin(): string {
  return typeof location !== 'undefined' ? location.origin : 'http://localhost'
}

/**
 * Returns the URL to keep, or null to drop it.
 * `kind` 'link' also allows mailto:; 'media' (img/video/audio/source src) does not.
 */
export function safeUrl(raw: string, kind: 'link' | 'media', origin: string = defaultOrigin()): string | null {
  const value = raw.trim()
  if (!value) return null
  let url: URL
  try {
    url = new URL(value, origin)
  } catch {
    return null
  }
  if (url.protocol === 'mailto:') return kind === 'link' ? value : null
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (url.origin === origin) {
    // Relative / same-origin: only the public-share prefixes, returned as a normalised path so a
    // backslash or tab trick cannot change its meaning on the way into the DOM.
    if (!SAME_ORIGIN_PREFIXES.some((p) => url.pathname.startsWith(p))) return null
    return url.pathname + url.search + url.hash
  }
  // Absolute external URL: must have been written as one (not a relative path that the parser
  // turned into another host, e.g. "/\evil.com").
  if (!/^https?:\/\//i.test(value)) return null
  return url.href
}

function sanitizeStyle(style: string): string | null {
  const kept: string[] = []
  for (const decl of style.split(';')) {
    const i = decl.indexOf(':')
    if (i < 0) continue
    const prop = decl.slice(0, i).trim().toLowerCase()
    const value = decl.slice(i + 1).trim()
    if (!STYLE_PROPS.has(prop) || !value) continue
    if (STYLE_BAD_RE.test(value) || !STYLE_VALUE_RE.test(value)) continue
    kept.push(`${prop}: ${value}`)
  }
  return kept.length ? kept.join('; ') + ';' : null
}

const ELEMENT_NODE = 1
const TEXT_NODE = 3

function cleanAttributes(el: Element, tag: string, allowed: readonly string[], origin: string) {
  for (const attr of Array.from(el.attributes)) {
    const name = attr.name.toLowerCase()
    const keep =
      GLOBAL_ATTRS.has(name) ||
      allowed.includes(name) ||
      (name.startsWith('data-') && /^data-[a-z0-9-]+$/.test(name)) ||
      (name.startsWith('aria-') && /^aria-[a-z]+$/.test(name))
    if (!keep || name.startsWith('on')) {
      el.removeAttribute(attr.name)
      continue
    }
    if (name === 'href' || name === 'src') {
      const safe = safeUrl(attr.value, name === 'href' ? 'link' : 'media', origin)
      if (safe === null) el.removeAttribute(attr.name)
      else if (safe !== attr.value) el.setAttribute(attr.name, safe)
    } else if (name === 'style') {
      const safe = sanitizeStyle(attr.value)
      if (safe === null) el.removeAttribute(attr.name)
      else el.setAttribute(attr.name, safe)
    } else if (name.startsWith('data-') && /javascript:|data:|vbscript:/i.test(attr.value) && name !== 'data-url') {
      // data-* values are inert, but keep scheme-looking payloads out anyway.
      el.removeAttribute(attr.name)
    } else if (name === 'data-url') {
      const safe = safeUrl(attr.value, 'media', origin)
      if (safe === null) el.removeAttribute(attr.name)
    }
  }
  if (tag === 'a') {
    if (el.getAttribute('target') && el.getAttribute('target') !== '_blank') el.removeAttribute('target')
    if (el.getAttribute('target') === '_blank') el.setAttribute('rel', 'noopener noreferrer nofollow')
  } else if (tag === 'input') {
    if ((el.getAttribute('type') ?? '').toLowerCase() !== 'checkbox') {
      el.remove()
      return
    }
    el.setAttribute('disabled', '')
  } else if (tag === 'button') {
    el.setAttribute('type', 'button')
  }
}

function walk(parent: Node, origin: string) {
  // Snapshot: children are removed/unwrapped while iterating.
  for (const node of Array.from(parent.childNodes)) {
    if (node.nodeType === TEXT_NODE) continue
    if (node.nodeType !== ELEMENT_NODE) {
      // comments, processing instructions, CDATA
      parent.removeChild(node)
      continue
    }
    const el = node as Element
    const tag = el.localName.toLowerCase()
    const ns = el.namespaceURI
    if (DROP_WITH_CONTENT.has(tag)) {
      el.remove()
      continue
    }
    let allowed: readonly string[] | undefined
    if (ns === SVG_NS) {
      allowed = SVG_ALLOWED[tag]
      // Any other SVG element (foreignObject, use, script, animate, a, …): drop entirely.
      if (!allowed) {
        el.remove()
        continue
      }
    } else if (ns === HTML_NS || ns === null) {
      allowed = Object.prototype.hasOwnProperty.call(HTML_ALLOWED, tag) ? HTML_ALLOWED[tag] : undefined
    } else {
      el.remove()
      continue
    }
    if (!allowed) {
      // Unknown but not dangerous: keep the (sanitised) children, drop the element.
      walk(el, origin)
      while (el.firstChild) parent.insertBefore(el.firstChild, el)
      el.remove()
      continue
    }
    cleanAttributes(el, tag, allowed, origin)
    if (!el.parentNode) continue // removed by cleanAttributes (e.g. non-checkbox input)
    // SVG may only contain the allowed SVG subset; HTML inside SVG is foreign content — drop.
    walk(el, origin)
  }
}

/** Sanitise an HTML fragment string; returns HTML safe to assign to innerHTML. */
export function sanitizeHtml(html: string, opts: SanitizeOptions = {}): string {
  const parse = opts.parse ?? defaultParse
  const origin = opts.origin ?? defaultOrigin()
  const doc = parse(`<!doctype html><html><head></head><body>${html}</body></html>`)
  const body = doc.body
  if (!body) return ''
  walk(body, origin)
  return body.innerHTML
}
