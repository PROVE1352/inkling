// Second layer over Mermaid's own output (docs/adr/2105-*). Pure: takes a parser so it runs in Node
// tests (jsdom) as well as the browser (DOMParser).
//
// Mermaid renders with securityLevel 'strict' (labels through its DOMPurify, no click handlers, no
// HTML labels), and the result is shown as an <img> (a data: URL): an SVG loaded as an image runs no
// script, fires no handler and loads nothing from outside. This pass is the belt to those braces —
// the existing public-share sanitizer (lib/sanitizeHtml.ts) keeps only `svg`/`path` and drops
// `<style>`, which would leave a diagram empty — and it fixes the size so the image has one:
//
// - removed with their content: script, iframe/frame, object, embed, link, meta, base, audio, video,
//   foreignObject's active descendants (script, iframe, object, embed, form controls);
// - every on* attribute; href / xlink:href / src that is not a local `#ref` or a data:image (raster);
// - in <style> and style="": @import, and url(…) other than url(#…) or url(data:image/…);
// - the root gets width/height from its viewBox (Mermaid writes width="100%" + max-width style).

type ParseFn = (svg: string) => Document
type SerializeFn = (el: Element) => string

const browserParse: ParseFn = (svg) => new DOMParser().parseFromString(svg, 'image/svg+xml')
const browserSerialize: SerializeFn = (el) => new XMLSerializer().serializeToString(el)

const DROP = new Set([
  'script', 'iframe', 'frame', 'object', 'embed', 'link', 'meta', 'base', 'audio', 'video',
  'animate', 'set', 'animatemotion', 'animatetransform', 'handler', 'listener', 'form', 'input',
  'textarea', 'select', 'button',
])
const URL_ATTRS = new Set(['href', 'xlink:href', 'src', 'action', 'formaction'])
const SAFE_URL = /^(#|data:image\/(png|jpe?g|gif|webp);base64,)/i

/** CSS with @import and external url(…) removed; url(#id) and raster data: URLs stay. */
export function cleanCss(css: string): string {
  return css
    .replace(/@import[^;]*;?/gi, '')
    .replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (m, _q, u: string) => (SAFE_URL.test(u.trim()) ? m : 'none'))
    .replace(/expression\s*\(/gi, '(')
}

export interface CleanSvg {
  svg: string
  width: number
  height: number
}

export function cleanMermaidSvg(svg: string, parse: ParseFn = browserParse, serialize: SerializeFn = browserSerialize): CleanSvg | null {
  const doc = parse(svg)
  const root = doc.documentElement
  if (!root || root.localName !== 'svg' || doc.getElementsByTagName('parsererror').length) return null

  const all = Array.from(root.querySelectorAll('*'))
  for (const el of all) {
    if (!root.contains(el)) continue // inside an element removed above
    if (DROP.has(el.localName.toLowerCase())) {
      el.remove()
      continue
    }
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase()
      if (name.startsWith('on')) el.removeAttribute(attr.name)
      else if (URL_ATTRS.has(name) && !SAFE_URL.test(attr.value.trim())) el.removeAttribute(attr.name)
      else if (name === 'style') el.setAttribute('style', cleanCss(attr.value))
    }
    if (el.localName === 'style') el.textContent = cleanCss(el.textContent ?? '')
  }
  for (const attr of Array.from(root.attributes)) {
    if (attr.name.toLowerCase().startsWith('on')) root.removeAttribute(attr.name)
  }

  const vb = (root.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number)
  const width = vb.length === 4 && vb[2] > 0 ? Math.ceil(vb[2]) : Number.parseFloat(root.getAttribute('width') ?? '') || 0
  const height = vb.length === 4 && vb[3] > 0 ? Math.ceil(vb[3]) : Number.parseFloat(root.getAttribute('height') ?? '') || 0
  if (!width || !height) return null
  root.setAttribute('width', String(width))
  root.setAttribute('height', String(height))
  root.removeAttribute('style')
  if (!root.getAttribute('xmlns')) root.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  return { svg: serialize(root), width, height }
}

/** The image URL for a cleaned SVG (CSP img-src allows data:). */
export function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}
