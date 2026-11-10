// "Export as PDF": print one element with print-only CSS (docs/adr/0307).
// Uses the browser's own print-to-PDF — no PDF library, nothing added to the bundle.
import '../print.css'
import { mermaidIdle } from './mermaid'

/** Longest wait for diagrams still rendering before the print dialog opens (docs/adr/2106-*). */
const DIAGRAM_WAIT_MS = 4_000

/**
 * Mark `el` as the element to print: it and its ancestors stay, everything else is hidden by
 * print.css, which applies under html.nd-printing only. Returns the function that undoes it.
 * The public page keeps its article marked while it is shown, so the browser's own Print command
 * (and a PDF printed without the button) gets the same result (docs/adr/2361-*).
 */
export function markPrintRoot(el: HTMLElement): () => void {
  const html = document.documentElement
  const marked: HTMLElement[] = []
  el.setAttribute('data-print-root', '')
  for (let cur = el.parentElement; cur && cur !== document.body; cur = cur.parentElement) {
    cur.setAttribute('data-print-ancestor', '')
    marked.push(cur)
  }
  html.classList.add('nd-printing')
  return () => {
    html.classList.remove('nd-printing')
    el.removeAttribute('data-print-root')
    for (const m of marked) m.removeAttribute('data-print-ancestor')
  }
}

/**
 * Open the print dialog once diagrams have drawn, with `title` as the document title (the PDF file
 * name defaults to it); `done` runs when printing is over.
 */
export function printWhenReady(title?: string, done?: () => void): void {
  const prevTitle = document.title
  if (title) document.title = title
  let finished = false
  const cleanup = () => {
    if (finished) return
    finished = true
    document.title = prevTitle
    window.removeEventListener('afterprint', cleanup)
    done?.()
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

/** Print `el` alone: hide everything off its ancestor chain, then window.print(). */
export function printElement(el: HTMLElement | null, title?: string): void {
  if (!el) return
  printWhenReady(title, markPrintRoot(el))
}
