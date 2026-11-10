// Mermaid diagrams on public pages (/s/…, docs/adr/2191-*): the server sends a ```mermaid block as
// BlockNote's code block HTML (`[data-content-type="codeBlock"][data-language="mermaid"] > pre > code`),
// which the page shows as code. After the client sanitizer, this draws each such block with the
// editor's renderer (lib/mermaid.ts: strict configuration, locked directive keys, the SVG cleaned
// and shown as an <img> data: URL, docs/adr/2105-*) and puts the image after the code block, hiding
// the whole block (BlockNote styles the block itself as a dark box with display: flex, so the image
// must not go inside it and hiding the <pre> alone is not enough). A diagram that fails keeps its
// code, as in the editor. Nothing is fetched for a page without a diagram.
import { isMermaidLanguage, renderMermaid, type MermaidResult, type MermaidTheme } from './mermaid'
import { t } from '../i18n'

type Render = (source: string, theme: MermaidTheme) => Promise<MermaidResult>

/** The code blocks of `root` whose language is a Mermaid one, with their source. */
export function mermaidCodeBlocks(root: ParentNode): { block: Element; pre: HTMLElement; source: string }[] {
  const out: { block: Element; pre: HTMLElement; source: string }[] = []
  for (const block of root.querySelectorAll('[data-content-type="codeBlock"][data-language]')) {
    if (!isMermaidLanguage(block.getAttribute('data-language'))) continue
    const pre = block.querySelector<HTMLElement>(':scope > pre')
    const source = (pre?.textContent ?? '').trim()
    if (pre && source) out.push({ block, pre, source })
  }
  return out
}

/**
 * Draw the Mermaid code blocks under `root`. Returns a cleanup that removes the images and shows the
 * code again (for a theme change or new HTML; React replaces the HTML itself as well).
 */
export function renderMermaidIn(root: HTMLElement, theme: MermaidTheme, render: Render = renderMermaid): () => void {
  const found = mermaidCodeBlocks(root)
  if (!found.length) return () => {}
  let live = true
  const added: { block: HTMLElement; display: string; figure: HTMLElement }[] = []
  for (const { block, source } of found) {
    void render(source, theme)
      .then((r) => {
        const el = block as HTMLElement
        if (!live || !r.ok || !el.isConnected) return
        const doc = el.ownerDocument
        const figure = doc.createElement('figure')
        figure.className = 'nd-mermaid-public my-2 overflow-x-auto text-center'
        const img = doc.createElement('img')
        img.className = 'mx-auto inline-block h-auto max-w-full'
        img.src = r.src // data:image/svg+xml from the cleaned SVG (lib/mermaidSvg.ts)
        img.width = r.width
        img.height = r.height
        img.alt = `${t('mermaid.alt')}: ${source.split('\n')[0].slice(0, 80)}`
        img.draggable = false
        figure.appendChild(img)
        el.after(figure)
        added.push({ block: el, display: el.style.display, figure })
        el.style.display = 'none'
      })
      .catch(() => {}) // the code stays
  }
  return () => {
    live = false
    for (const { block, display, figure } of added) {
      figure.remove()
      block.style.display = display
    }
  }
}
