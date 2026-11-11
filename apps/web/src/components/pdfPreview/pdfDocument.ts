// pdf.js behind the PDF preview (docs/adr/2480-*). This module is the lazy pdf.js chunk: only a PDF
// preview that starts loading imports it, so pages without a PDF never fetch pdf.js or its worker.
//
// - The worker, cMaps, standard fonts, wasm decoders and ICC profiles are same-origin files of the build
//   (vite.config.ts `inkling-pdfjs-assets`, under assets/lazy/pdfjs-<version>/): no CDN.
// - One worker for every PDF in the tab. Documents are shared by address and kept for a while after the
//   last preview lets go, because a block's node view is rebuilt on every change of its props.
// - Nothing in a PDF runs: the core API has no scripting (that is the viewer's sandbox, not shipped),
//   XFA stays off, no annotation layer (no forms, no attachments, no actions); links are read from the
//   annotations and filtered in lib/pdfPreview.ts.
import {
  getDocument,
  GlobalWorkerOptions,
  InvalidPDFException,
  PasswordException,
  PDFWorker,
  ResponseException,
  TextLayer,
  version,
  type PDFDocumentLoadingTask,
  type PDFDocumentProxy,
} from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

export { TextLayer, version }
export type { PDFDocumentProxy }
export type { PDFPageProxy, RenderTask } from 'pdfjs-dist'

/** Where the build puts pdf.js's data files (keep in sync with vite.config.ts). */
const DATA = `${import.meta.env.BASE_URL}assets/lazy/pdfjs-${version}/`

GlobalWorkerOptions.workerSrc = workerUrl

let worker: PDFWorker | null = null
function sharedWorker(): PDFWorker {
  if (!worker || worker.destroyed) worker = new PDFWorker()
  return worker
}

/** Did the worker really start (and not pdf.js's main-thread fallback)? For the browser check. */
export function workerIsReal(): boolean {
  try {
    return !!worker && !worker.destroyed && worker.port instanceof Worker
  } catch {
    return false
  }
}

export type LoadError = 'password' | 'invalid' | 'missing' | 'network' | 'other'

export function errorKind(e: unknown): LoadError {
  if (e instanceof PasswordException) return 'password'
  if (e instanceof InvalidPDFException) return 'invalid'
  if (e instanceof ResponseException) return e.status === 404 || e.status === 403 ? 'missing' : 'network'
  const name = (e as { name?: string } | null)?.name
  if (name === 'PasswordException') return 'password'
  if (name === 'InvalidPDFException') return 'invalid'
  if (name === 'ResponseException') return 'network'
  if (e instanceof TypeError) return 'network'
  return 'other'
}

type Progress = (loaded: number, total: number) => void
type Entry = {
  task: PDFDocumentLoadingTask
  promise: Promise<PDFDocumentProxy>
  refs: number
  listeners: Set<Progress>
  last: { loaded: number; total: number }
  timer?: ReturnType<typeof setTimeout>
}
const docs = new Map<string, Entry>()
/** How long a document no preview uses stays loaded (a node view rebuilt after a prop change finds it). */
const KEEP_MS = 30_000

/**
 * Opens (or shares) the document at `url`. `onProgress` gets the bytes received; `total` is 0 while the
 * server has not said (the /files route sends no Content-Length). Every acquire needs one release().
 */
export function acquire(url: string, onProgress?: Progress): Promise<PDFDocumentProxy> {
  let e = docs.get(url)
  if (!e) {
    const task = getDocument({
      url,
      worker: sharedWorker(),
      // same-origin request, so the session cookie goes along; nothing cross-site is ever loaded
      withCredentials: false,
      // pdf.js asks for byte ranges only when the response says Accept-Ranges: bytes (it does not
      // today); otherwise it streams the whole file once
      disableAutoFetch: false,
      rangeChunkSize: 262_144,
      cMapUrl: `${DATA}cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `${DATA}standard_fonts/`,
      wasmUrl: `${DATA}wasm/`,
      iccUrl: `${DATA}iccs/`,
      enableXfa: false,
      // pages are drawn on this thread (the renderer worker is another file and another CSP question)
      disableWorkerRendering: true,
      stopAtErrors: false,
      verbosity: 0,
    })
    const created: Entry = {
      task,
      promise: task.promise,
      refs: 0,
      listeners: new Set(),
      last: { loaded: 0, total: 0 },
    }
    task.onProgress = ({ loaded, total }: { loaded: number; total: number }) => {
      created.last = { loaded, total: total || 0 }
      created.listeners.forEach((l) => l(loaded, total || 0))
    }
    // a failed load is not kept: the next acquire tries again
    task.promise.catch(() => {
      if (docs.get(url) === created) docs.delete(url)
      void task.destroy().catch(() => {})
    })
    docs.set(url, created)
    e = created
  }
  if (e.timer) {
    clearTimeout(e.timer)
    e.timer = undefined
  }
  e.refs++
  if (onProgress) {
    e.listeners.add(onProgress)
    onProgress(e.last.loaded, e.last.total)
  }
  return e.promise
}

export function release(url: string, onProgress?: Progress): void {
  const e = docs.get(url)
  if (!e) return
  if (onProgress) e.listeners.delete(onProgress)
  e.refs = Math.max(0, e.refs - 1)
  if (e.refs > 0 || e.timer) return
  e.timer = setTimeout(() => {
    if (docs.get(url) !== e || e.refs > 0) return
    docs.delete(url)
    void e.task.destroy().catch(() => {})
    if (docs.size === 0 && worker) {
      worker.destroy()
      worker = null
    }
  }, KEEP_MS)
}
