// pdf.js behind the PDF preview (docs/adr/2480-*, 2483-*). This module is the lazy pdf.js chunk: only a
// PDF preview that starts loading imports it, so pages without a PDF never fetch pdf.js or its worker.
//
// - pdf.js's legacy build (polyfilled; the modern build uses Promise.try, Map.getOrInsertComputed,
//   Math.sumPrecise and Uint8Array.toHex/fromBase64 without polyfills).
// - The worker, cMaps, standard fonts, wasm decoders and ICC profiles are same-origin files of the build
//   (vite.config.ts `inkling-pdfjs-assets`, under assets/lazy/pdfjs-<version>/): no CDN.
// - One worker for every PDF in the tab. Loaded documents are shared by address and kept 15 s after the
//   last preview lets go (a block's node view is rebuilt on every change of its props); a download whose
//   last preview went away is cancelled after 1.5 s. The worker goes when the
//   last document has been destroyed.
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
} from 'pdfjs-dist/legacy/build/pdf.mjs'
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'

export { TextLayer, version }
export type { PDFDocumentProxy }
export type { PDFPageProxy, RenderTask } from 'pdfjs-dist/legacy/build/pdf.mjs'

/** Where the build puts pdf.js's data files (keep in sync with vite.config.ts). */
const DATA = `${import.meta.env.BASE_URL}assets/lazy/pdfjs-${version}/`

/**
 * Images larger than this many pixels are left out of the page (pdf.js `maxImageSize`): 2^26 px is a
 * 600 dpi scan of an A4 page with room to spare, and 256 MiB once decoded.
 */
const MAX_IMAGE_PIXELS = 2 ** 26
/**
 * Decoded images over this many bytes (2^26 = 64 MiB, 16.7 M px) are scaled down in the worker before
 * they reach the page (pdf.js `canvasMaxAreaInBytes`; -1 would probe the browser's canvas limit instead).
 */
const MAX_IMAGE_AREA_BYTES = 2 ** 26

GlobalWorkerOptions.workerSrc = workerUrl

let worker: PDFWorker | null = null
function sharedWorker(): PDFWorker {
  if (!worker || worker.destroyed) worker = new PDFWorker()
  return worker
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
  loaded: boolean
  refs: number
  listeners: Set<Progress>
  last: { loaded: number; total: number }
  timer?: ReturnType<typeof setTimeout>
}
const docs = new Map<string, Entry>()
/** How long a loaded document no preview uses stays open. */
const KEEP_MS = 15_000
/** How long a download nobody waits for goes on (covers a node view rebuilt in the same moment). */
const ABORT_MS = 1_500

/** Destroys a loading task, then the worker if nothing else uses it. */
function drop(e: Entry): void {
  void e.task
    .destroy()
    .catch(() => {})
    .then(() => {
      if (docs.size === 0 && worker) {
        worker.destroy()
        worker = null
      }
    })
}

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
      rangeChunkSize: 262_144,
      cMapUrl: `${DATA}cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `${DATA}standard_fonts/`,
      wasmUrl: `${DATA}wasm/`,
      iccUrl: `${DATA}iccs/`,
      enableXfa: false,
      maxImageSize: MAX_IMAGE_PIXELS,
      canvasMaxAreaInBytes: MAX_IMAGE_AREA_BYTES,
      // pages are drawn on this thread (the renderer worker is another file and another CSP question)
      disableWorkerRendering: true,
      stopAtErrors: false,
      verbosity: 0,
    })
    const created: Entry = {
      task,
      promise: task.promise,
      loaded: false,
      refs: 0,
      listeners: new Set(),
      last: { loaded: 0, total: 0 },
    }
    task.onProgress = ({ loaded, total }: { loaded: number; total: number }) => {
      created.last = { loaded, total: total || 0 }
      created.listeners.forEach((l) => l(loaded, total || 0))
    }
    task.promise.then(
      () => {
        created.loaded = true
      },
      () => {
        // a failed load is not kept: the next acquire tries again
        if (docs.get(url) === created) docs.delete(url)
        drop(created)
      },
    )
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
  const close = () => {
    if (docs.get(url) !== e || e.refs > 0) return
    docs.delete(url)
    drop(e)
  }
  // still downloading: stop the transfer soon (a node view rebuilt in the same moment takes it over)
  e.timer = setTimeout(close, e.loaded ? KEEP_MS : ABORT_MS)
}

/** Open documents and whether the worker is up: read by the browser check (docs/adr/2483-*). */
;(globalThis as { __inklingPdfStats?: () => { docs: number; worker: boolean } }).__inklingPdfStats = () => ({
  docs: docs.size,
  worker: !!worker && !worker.destroyed,
})
