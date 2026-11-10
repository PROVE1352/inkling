// PDF text in a worker thread (docs/adr/2047-*, 2048-*): page ranges, the character cap, the time
// limit, damaged and encrypted documents. Builds tiny PDFs in the test (no fixtures).
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { extractPdfText, parsePageRange, PDF_LIMITS } from './pdfText'

function makePdf(pages: (string | null)[], extraTrailer = '', extraObjs: string[] = []): Buffer {
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
  const kids: string[] = []
  for (const t of pages) {
    const stream = t === null ? '' : `BT /F1 12 Tf 72 720 Td (${t}) Tj ET`
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${objs.length + 2} 0 R >>`)
    kids.push(`${objs.length} 0 R`)
    objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`)
  }
  objs[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages.length} >>`
  objs.push(...extraObjs)
  let out = '%PDF-1.4\n'
  const offs: number[] = []
  objs.forEach((o, i) => {
    offs.push(out.length)
    out += `${i + 1} 0 obj\n${o}\nendobj\n`
  })
  const x = out.length
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R ${extraTrailer}>>\nstartxref\n${x}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

describe('PDF text', () => {
  it('page ranges', () => {
    assert.deepEqual(parsePageRange(undefined), [1, PDF_LIMITS.defaultPages])
    assert.deepEqual(parsePageRange('3'), [3, 3])
    assert.deepEqual(parsePageRange('2-5'), [2, 5])
    assert.deepEqual(parsePageRange('4-'), [4, 4 + PDF_LIMITS.maxPages - 1])
    assert.deepEqual(parsePageRange('1-500'), [1, PDF_LIMITS.maxPages])
    for (const bad of ['0', '5-2', 'a', '1,3']) assert.equal(parsePageRange(bad), null, bad)
  })

  it('reads the text layer of the asked pages, stops at the character cap', async () => {
    const pdf = makePdf(['Alpha one', 'Beta two', 'Gamma three'])
    const r = await extractPdfText(pdf, { first: 2, last: 3, maxChars: 10_000 })
    assert.ok(r.ok)
    assert.equal(r.numPages, 3)
    assert.deepEqual(r.pages, [
      { page: 2, text: 'Beta two' },
      { page: 3, text: 'Gamma three' },
    ])
    assert.equal(r.stopped, 'done')
    const c = await extractPdfText(pdf, { first: 1, last: 3, maxChars: 5 })
    assert.ok(c.ok)
    assert.equal(c.pages.length, 1)
    assert.equal(c.stopped, 'chars')
    const empty = await extractPdfText(makePdf([null]), { first: 1, last: 1, maxChars: 100 })
    assert.ok(empty.ok)
    assert.deepEqual(empty.pages, [{ page: 1, text: '' }])
  })

  it('damaged, encrypted, and the time limit', async () => {
    const bad = await extractPdfText(Buffer.from('%PDF-1.4\nnope'), { first: 1, last: 1, maxChars: 100 })
    assert.deepEqual(bad.ok ? null : bad.reason, 'invalid')
    const hex = 'A'.repeat(64)
    const enc = makePdf(['x'], `/Encrypt 6 0 R /ID [<${'00'.repeat(16)}> <${'00'.repeat(16)}>] `, [`<< /Filter /Standard /V 1 /R 2 /O <${hex}> /U <${hex}> /P -4 >>`])
    const e = await extractPdfText(enc, { first: 1, last: 1, maxChars: 100 })
    assert.deepEqual(e.ok ? null : e.reason, 'encrypted')
    // 1 ms: the worker cannot even load the parser; it is terminated and the answer says so
    const t = await extractPdfText(makePdf(['x']), { first: 1, last: 1, maxChars: 100, timeoutMs: 1 })
    assert.equal(t.ok ? 'ok' : t.reason, 'time')
  })
})
