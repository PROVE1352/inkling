// "Export as PDF": print one element with print-only CSS (docs/adr/0307).
// Uses the browser's own print-to-PDF — no PDF library, nothing added to the bundle.
import '../print.css'
import { mermaidIdle } from './mermaid'

/** Longest wait for diagrams still rendering before the print dialog opens (docs/adr/2106-*). */
const DIAGRAM_WAIT_MS = 4_000

/** Print `el` alone: hide everything off its ancestor chain, then window.print(). */
export function printElement(el: HTMLElement | null, title?: string): void {
  if (!el) return
  const html = document.documentElement
  const marked: HTMLElement[] = []
  el.setAttribute('data-print-root', '')
  for (let cur = el.parentElement; cur && cur !== document.body; cur = cur.parentElement) {
    cur.setAttribute('data-print-ancestor', '')
    marked.push(cur)
  }
  const prevTitle = document.title
  // the PDF file name defaults to the document title
  if (title) document.title = title
  html.classList.add('nd-printing')

  let done = false
  const cleanup = () => {
    if (done) return
    done = true
    html.classList.remove('nd-printing')
    el.removeAttribute('data-print-root')
    for (const m of marked) m.removeAttribute('data-print-ancestor')
    document.title = prevTitle
    window.removeEventListener('afterprint', cleanup)
  }
  window.addEventListener('afterprint', cleanup)
  // Mermaid diagrams render asynchronously: wait (bounded) for any still in the queue, then let React
  // render windowed lists in full (beforeprint → flushSync) before the snapshot
  const diagrams = Promise.race([mermaidIdle(), new Promise<void>((r) => window.setTimeout(r, DIAGRAM_WAIT_MS))])
  void diagrams.then(() => requestAnimationFrame(() => {
    window.print()
    // Fallback for browsers that never fire afterprint (or whose print() does not block):
    // restore on the user's next interaction with the page.
    const onBack = () => {
      window.removeEventListener('pointermove', onBack)
      window.removeEventListener('keydown', onBack)
      window.setTimeout(cleanup, 300)
    }
    window.setTimeout(() => {
      window.addEventListener('pointermove', onBack, { once: true })
      window.addEventListener('keydown', onBack, { once: true })
    }, 500)
  }))
}
