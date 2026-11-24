import { newSentinels, notationRestore, type PasteBlock } from './markdownNotation'

// Rendered KaTeX in pasted HTML (a chat answer or a web page copied as rich text) → math nodes.
//
// KaTeX writes each formula twice: MathML with the TeX source in
// `<annotation encoding="application/x-tex">`, and the visual `.katex-html` spans. BlockNote's HTML
// parser reads both as text ("xE = mc^2E = mc2"). Here each `.katex` element that carries a TeX
// annotation is replaced by a sentinel before BlockNote parses the HTML, and the sentinels become
// nodes afterwards (the same restore step as Markdown, lib/paste/markdownNotation.ts): a display
// formula (`.katex-display`, or MathML display="block") alone in its paragraph becomes a math block,
// any other formula inlineMath. A `.katex` without the annotation is left as it was.

const TEX = 'annotation[encoding="application/x-tex"]'

export interface HtmlPaste {
  /** The HTML with formulas replaced by sentinels, for BlockNote's parser. */
  html: string
  restore(blocks: PasteBlock[]): PasteBlock[]
}

/** null when the HTML holds no KaTeX formula with its TeX source (the paste then stays BlockNote's own). */
export function prepareKatexHtml(html: string, parse: (html: string) => Document): HtmlPaste | null {
  if (!html.includes('katex') || !html.includes('application/x-tex')) return null
  const doc = parse(html)
  const src = newSentinels(html)
  for (const el of Array.from(doc.querySelectorAll('.katex'))) {
    // nested .katex (KaTeX does not nest them; a page might) or already replaced with its parent
    if (!el.isConnected || el.parentElement?.closest('.katex')) continue
    const tex = el.querySelector(TEX)?.textContent?.trim()
    if (!tex) continue
    const wrapper = el.parentElement?.closest('.katex-display')
    const display = !!wrapper || el.querySelector('math')?.getAttribute('display') === 'block'
    const key = src.sentinel(display ? 'B' : 'I')
    ;(display ? src.blockSources : src.inlineSources).set(key, tex)
    src.literals.set(key, display ? `$$${tex}$$` : `$${tex}$`)
    ;(wrapper ?? el).replaceWith(doc.createTextNode(key))
  }
  if (!src.blockSources.size && !src.inlineSources.size) return null
  return { html: doc.body.innerHTML, restore: notationRestore(src, false) }
}
