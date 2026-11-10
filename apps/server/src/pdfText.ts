import { Worker } from 'node:worker_threads'

/**
 * PDF text for read_file (docs/adr/2047-*, 2048-*). A PDF is untrusted input: it is parsed by unpdf
 * (pdf.js, pure JS) in a worker thread that is terminated at the time limit, with a heap cap, one
 * page at a time, and only the text layer is read — no rendering, no fonts from the system, no XFA,
 * no network (the data is passed in; no URLs are given to pdf.js). pdf.js never runs the document's
 * JavaScript (that is a viewer feature this build does not have).
 *
 * Limits (PDF_LIMITS): file size, pages per call, characters per answer, wall time per call, worker
 * heap, and how many PDFs are parsed at once in this process. Whatever is cut is said in the answer
 * ("pages 1–20 of 64"), so the agent can ask for the next range.
 */

export const PDF_LIMITS = {
  /** Larger PDFs are not parsed (metadata only). Below the 25 MB upload cap. */
  maxBytes: 20 * 1024 * 1024,
  /** Pages read in one call (pages="a-b" picks which). */
  maxPages: 50,
  /** Default range when none is asked for: the first 20 pages. */
  defaultPages: 20,
  /** Wall time of one call; the worker is terminated after it (pages read so far are returned). */
  timeoutMs: 10_000,
  /** Old-generation heap of the worker. */
  heapMb: 256,
  /** PDFs parsed at once by this process; more wait for a slot (up to timeoutMs). */
  concurrent: 2,
} as const

export interface PdfPageText {
  page: number
  text: string
}

export type PdfResult =
  | { ok: true; numPages: number; pages: PdfPageText[]; stopped: 'done' | 'chars' | 'time' }
  | { ok: false; reason: 'encrypted' | 'invalid' | 'time' | 'failed'; message: string }

// The worker body: CommonJS (eval workers are scripts), imports unpdf by absolute URL so it resolves
// the same under tsx (tests) and in the built image (dist/index.js next to node_modules).
const WORKER = `
const { parentPort, workerData } = require('node:worker_threads')
;(async () => {
  const { getDocumentProxy } = await import(workerData.lib)
  const doc = await getDocumentProxy(new Uint8Array(workerData.bytes), {
    useSystemFonts: false,
    disableFontFace: true,
    enableXfa: false,
    isOffscreenCanvasSupported: false,
    verbosity: 0,
  })
  parentPort.postMessage({ kind: 'meta', numPages: doc.numPages })
  const last = Math.min(doc.numPages, workerData.last)
  let chars = 0
  for (let i = workerData.first; i <= last; i++) {
    const page = await doc.getPage(i)
    const tc = await page.getTextContent()
    let text = ''
    for (const it of tc.items) {
      if (typeof it.str !== 'string') continue
      text += it.str
      text += it.hasEOL ? '\\n' : ' '
    }
    page.cleanup()
    text = text.replace(/[ \\t]+\\n/g, '\\n').replace(/[ \\t]{2,}/g, ' ').trim()
    chars += text.length
    parentPort.postMessage({ kind: 'page', page: i, text })
    if (chars >= workerData.maxChars) { parentPort.postMessage({ kind: 'end', stopped: 'chars' }); return }
  }
  parentPort.postMessage({ kind: 'end', stopped: 'done' })
})().catch((e) => parentPort.postMessage({ kind: 'error', name: String((e && e.name) || ''), message: String((e && e.message) || e) }))
`

let unpdfUrl: string | null = null
function libUrl(): string {
  unpdfUrl ??= import.meta.resolve('unpdf')
  return unpdfUrl
}

let active = 0
const waiting: (() => void)[] = []

async function slot(deadline: number): Promise<boolean> {
  while (active >= PDF_LIMITS.concurrent) {
    const left = deadline - Date.now()
    if (left <= 0) return false
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        const i = waiting.indexOf(resolve)
        if (i >= 0) waiting.splice(i, 1)
        resolve()
      }, left)
      waiting.push(() => {
        clearTimeout(t)
        resolve()
      })
    })
  }
  active++
  return true
}

function freeSlot(): void {
  active--
  waiting.shift()?.()
}

/**
 * Text of pages `first`..`last` (1-based, inclusive, clamped to the document), stopping once
 * `maxChars` characters were read or the time limit passed.
 */
export async function extractPdfText(bytes: Buffer, opts: { first: number; last: number; maxChars: number; timeoutMs?: number }): Promise<PdfResult> {
  const timeoutMs = opts.timeoutMs ?? PDF_LIMITS.timeoutMs
  const deadline = Date.now() + timeoutMs
  if (!(await slot(deadline))) return { ok: false, reason: 'time', message: 'other PDFs are being read right now' }
  try {
    return await new Promise<PdfResult>((resolve) => {
      let numPages = 0
      const pages: PdfPageText[] = []
      let settled = false
      const worker = new Worker(WORKER, {
        eval: true,
        workerData: { lib: libUrl(), bytes, first: opts.first, last: opts.last, maxChars: opts.maxChars },
        resourceLimits: { maxOldGenerationSizeMb: PDF_LIMITS.heapMb },
        stdout: true,
        stderr: true,
      })
      // Nothing should print (verbosity 0); drain the streams so a chatty document cannot stall the worker.
      worker.stdout.resume()
      worker.stderr.resume()
      const finish = (r: PdfResult) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        void worker.terminate()
        resolve(r)
      }
      const timer = setTimeout(() => {
        finish(numPages ? { ok: true, numPages, pages, stopped: 'time' } : { ok: false, reason: 'time', message: 'the PDF took too long to open' })
      }, Math.max(1, deadline - Date.now()))
      worker.on('message', (m: { kind: string; numPages?: number; page?: number; text?: string; stopped?: 'done' | 'chars'; name?: string; message?: string }) => {
        if (m.kind === 'meta') numPages = m.numPages ?? 0
        else if (m.kind === 'page') pages.push({ page: m.page!, text: m.text ?? '' })
        else if (m.kind === 'end') finish({ ok: true, numPages, pages, stopped: m.stopped ?? 'done' })
        else if (m.kind === 'error') {
          const reason = m.name === 'PasswordException' ? 'encrypted' : m.name === 'InvalidPDFException' ? 'invalid' : 'failed'
          finish({ ok: false, reason, message: m.message ?? '' })
        }
      })
      worker.on('error', (err) => finish({ ok: false, reason: 'failed', message: String(err) }))
      worker.on('exit', () => finish(numPages ? { ok: true, numPages, pages, stopped: 'time' } : { ok: false, reason: 'failed', message: 'the PDF reader stopped' }))
    })
  } finally {
    freeSlot()
  }
}

/** "3", "2-5", "4-" (to the end of the allowed span) → [first, last]; null when malformed. */
export function parsePageRange(s: string | undefined): [number, number] | null {
  if (s === undefined || s.trim() === '') return [1, PDF_LIMITS.defaultPages]
  const m = /^\s*(\d{1,6})\s*(?:(-)\s*(\d{1,6})?)?\s*$/.exec(s)
  if (!m) return null
  const first = Number(m[1])
  const last = m[2] ? (m[3] ? Number(m[3]) : first + PDF_LIMITS.maxPages - 1) : first
  if (first < 1 || last < first) return null
  return [first, Math.min(last, first + PDF_LIMITS.maxPages - 1)]
}
