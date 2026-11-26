// A compressed PDF that inflates to hundreds of MB (0.25.4, sec26 D-2). The worker's heap cap does not count
// ArrayBuffers (Node: resourceLimits do not apply to external data), and pdf.js grows one Uint8Array per stream
// by doubling, so a 0.5 MB file took the whole process to 1.6 GB of RSS (measured), a 4 MB one to 2 GB before
// the 10 s limit. Each case runs extractPdfText in a child process (this runner's memory is not at stake) and
// reads the child's peak RSS: once after a small ordinary PDF, once after the bomb.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { constants, deflateRawSync, deflateSync } from 'node:zlib'
import { describe, it } from 'node:test'
import { extractPdfText } from './pdfText'

/** One page whose content stream inflates to `mb` MB of zeros (white space to pdf.js's lexer). */
function bombPdf(mb: number): Buffer {
  // 16 MB of zeros as non-final deflate blocks ending on a byte boundary (a full flush), repeated, then an empty
  // final block: one valid deflate stream, about 1/1000 of its decoded size
  const chunk = deflateRawSync(Buffer.alloc(16 * 1024 * 1024), { level: 9, finishFlush: constants.Z_FULL_FLUSH })
  return flatePdf(Buffer.concat([Buffer.from([0x78, 0x9c]), ...Array<Buffer>(Math.ceil(mb / 16)).fill(chunk), Buffer.from([0x03, 0x00, 0, 0, 0, 1])]))
}

/** One page with a Helvetica font and the given already-deflated content stream. */
function flatePdf(body: Buffer): Buffer {
  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n')]
  const offs: number[] = []
  let len = parts[0].length
  const add = (b: Buffer) => {
    offs.push(len)
    parts.push(b)
    len += b.length
  }
  add(Buffer.from('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n'))
  add(Buffer.from('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n'))
  add(Buffer.from('3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n'))
  add(Buffer.concat([Buffer.from(`4 0 obj\n<< /Length ${body.length} /Filter /FlateDecode >>\nstream\n`), body, Buffer.from('\nendstream\nendobj\n')]))
  add(Buffer.from('5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n'))
  const xref = len
  parts.push(
    Buffer.from(
      `xref\n0 6\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}` +
        `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`,
    ),
  )
  return Buffer.concat(parts)
}

/** The child: reads an ordinary PDF, notes its peak RSS, reads the bomb (from a file), prints both peaks. */
function runChild(mb: number): { before: number; after: number; small: boolean; bomb: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'inkling-pdf-bomb-'))
  const file = path.join(dir, 'bomb.pdf')
  writeFileSync(file, bombPdf(mb))
  const lib = pathToFileURL(path.join(import.meta.dirname, 'pdfText.ts')).href
  // a CommonJS eval (pdfText's worker is an eval script too, and inherits --input-type)
  const code = `(async () => {
    const { readFileSync } = await import('node:fs')
    const { extractPdfText } = await import(${JSON.stringify(lib)})
    const small = Buffer.from('%PDF-1.4\\n1 0 obj\\n<< /Type /Catalog /Pages 2 0 R >>\\nendobj\\n2 0 obj\\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\\nendobj\\n3 0 obj\\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>\\nendobj\\ntrailer\\n<< /Root 1 0 R >>\\n%%EOF\\n', 'latin1')
    const a = await extractPdfText(small, { first: 1, last: 1, maxChars: 100 })
    const before = process.resourceUsage().maxRSS
    const b = await extractPdfText(readFileSync(${JSON.stringify(file)}), { first: 1, last: 1, maxChars: 100 })
    const after = process.resourceUsage().maxRSS
    process.stdout.write(JSON.stringify({ before, after, small: a.ok, bomb: JSON.stringify(b).slice(0, 300) }))
    process.exit(0)
  })()`
  try {
    // the child gets this runner's loader (tsx) so it can import the .ts source; not its --test flags
    const out = execFileSync(process.execPath, [...process.execArgv.filter((a) => !a.startsWith('--test')), '-e', code], {
      encoding: 'utf8',
      timeout: 60_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const r = JSON.parse(out) as { before: number; after: number; small: boolean; bomb: string }
    // maxRSS is in kilobytes
    return { ...r, before: r.before / 1024, after: r.after / 1024 }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('PDF text: a compression bomb stays within the worker memory budget (sec26 D-2)', () => {
  it('a 0.5 MB PDF inflating to 512 MB raises the process peak RSS by less than 256 MB', () => {
    const r = runChild(512)
    const grew = r.after - r.before
    assert.equal(r.small, true, 'the child reads an ordinary PDF')
    console.log(`[D-2] peak RSS ${r.before.toFixed(0)} MB → ${r.after.toFixed(0)} MB (+${grew.toFixed(0)} MB); bomb: ${r.bomb}`)
    assert.ok(grew < 256, `the bomb added ${grew.toFixed(0)} MB of RSS`)
  })

  it('ordinary compressed pages still read, also one with 24 MB of white space before its text', async () => {
    const text = (t: string, pad = 0) => flatePdf(deflateSync(Buffer.concat([Buffer.alloc(pad, 0x20), Buffer.from(`BT /F1 12 Tf 72 720 Td (${t}) Tj ET`)])))
    const a = await extractPdfText(text('Hello compressed'), { first: 1, last: 1, maxChars: 1000 })
    assert.ok(a.ok, JSON.stringify(a))
    assert.deepEqual(a.pages, [{ page: 1, text: 'Hello compressed' }])
    const b = await extractPdfText(text('After the padding', 24 * 1024 * 1024), { first: 1, last: 1, maxChars: 1000 })
    assert.ok(b.ok, JSON.stringify(b))
    assert.deepEqual(b.pages, [{ page: 1, text: 'After the padding' }])
  })
})
