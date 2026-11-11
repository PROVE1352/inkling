// @ts-nocheck — Node test file (node:test types are not part of the web tsconfig); not bundled.
// Run: cd apps/server && npx tsx --test ../web/src/lib/pdfPreview.test.ts
// The PDF preview's pure parts (docs/adr/2480-*, 2481-*, 2482-*): which blocks get a preview, the auto-load
// limit, the page window, zoom steps, the links that survive and the collapsed memory.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { fileIdOf, pdfByName } from './pdfFile'
import {
  AUTO_LOAD_MAX_BYTES,
  COLLAPSED_KEY,
  MAX_ZOOM,
  MIN_ZOOM,
  autoLoads,
  clampZoom,
  fitWidthZoom,
  formatSize,
  isCollapsed,
  isPdfMime,
  layoutSlots,
  outputScale,
  parsePageNumber,
  percent,
  renderWindow,
  safeLinkUrl,
  setCollapsed,
  stepZoom,
  visiblePages,
} from './pdfPreview'

const ORIGIN = 'https://notes.example.com'
const ID = '0f8fad5b-d9cb-469f-a165-70867728950e'

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial))
  return {
    data,
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => void data.set(k, String(v)),
  }
}

describe('which file blocks get a preview', () => {
  it('takes uploaded files of this server only', () => {
    assert.equal(fileIdOf(`/files/${ID}`, ORIGIN), ID)
    assert.equal(fileIdOf(`${ORIGIN}/files/${ID.toUpperCase()}`, ORIGIN), ID)
    assert.equal(fileIdOf(`https://evil.example.org/files/${ID}`, ORIGIN), null)
    assert.equal(fileIdOf(`/files/${ID}/meta`, ORIGIN), null)
    assert.equal(fileIdOf(`/files/${ID}?x=1`, ORIGIN), null)
    assert.equal(fileIdOf('/files/not-an-id', ORIGIN), null)
    assert.equal(fileIdOf('https://example.org/paper.pdf', ORIGIN), null)
    assert.equal(fileIdOf('javascript:alert(1)', ORIGIN), null)
    assert.equal(fileIdOf('', ORIGIN), null)
    assert.equal(fileIdOf(undefined, ORIGIN), null)
  })

  it('reads the extension, and leaves names without one to the server mime', () => {
    assert.equal(pdfByName('paper.pdf'), 'pdf')
    assert.equal(pdfByName('Paper.PDF'), 'pdf')
    assert.equal(pdfByName('논문 최종.pdf'), 'pdf')
    assert.equal(pdfByName('notes.txt'), 'other')
    assert.equal(pdfByName('archive.pdf.zip'), 'other')
    assert.equal(pdfByName('README'), 'unknown')
    assert.equal(pdfByName('.pdf'), 'unknown')
    assert.equal(pdfByName('dir/'), 'unknown')
    assert.equal(pdfByName(''), 'unknown')
    assert.equal(pdfByName(undefined), 'unknown')
    assert.equal(isPdfMime('application/pdf'), true)
    assert.equal(isPdfMime('Application/PDF; charset=binary'), true)
    assert.equal(isPdfMime('text/plain'), false)
    assert.equal(isPdfMime(null), false)
  })
})

describe('auto-load limit', () => {
  it('loads up to the limit without a press, and an unknown size waits', () => {
    assert.equal(AUTO_LOAD_MAX_BYTES, 10 * 1024 * 1024)
    assert.equal(autoLoads(0), true)
    assert.equal(autoLoads(AUTO_LOAD_MAX_BYTES), true)
    assert.equal(autoLoads(AUTO_LOAD_MAX_BYTES + 1), false)
    assert.equal(autoLoads(25 * 1024 * 1024), false)
    assert.equal(autoLoads(null), false)
    assert.equal(autoLoads(undefined), false)
    assert.equal(autoLoads(Number.NaN), false)
    assert.equal(autoLoads(-1), false)
    assert.equal(autoLoads(5, 4), false)
    assert.equal(autoLoads(1024, AUTO_LOAD_MAX_BYTES, true), false)
  })

  it('formats the size on the button', () => {
    assert.equal(formatSize(26_319_872), '25.1 MB')
    assert.equal(formatSize(860_000), '840 KB')
    assert.equal(formatSize(512), '512 B')
    assert.equal(formatSize(-1), '')
  })
})

describe('links inside a PDF', () => {
  it('keeps http and https only', () => {
    assert.equal(safeLinkUrl('https://example.com/paper'), 'https://example.com/paper')
    assert.equal(safeLinkUrl('http://example.com/a b'), 'http://example.com/a%20b')
    assert.equal(safeLinkUrl('javascript:alert(1)'), null)
    assert.equal(safeLinkUrl('JavaScript:alert(1)'), null)
    assert.equal(safeLinkUrl(' javascript:alert(1)'), null)
    assert.equal(safeLinkUrl('data:text/html,<script>alert(1)</script>'), null)
    assert.equal(safeLinkUrl('file:///etc/passwd'), null)
    assert.equal(safeLinkUrl('mailto:a@example.com'), null)
    assert.equal(safeLinkUrl('calc.exe'), null)
    assert.equal(safeLinkUrl('/files/x'), null)
    assert.equal(safeLinkUrl(undefined), null)
    assert.equal(safeLinkUrl({ toString: () => 'https://x' }), null)
    assert.equal(safeLinkUrl('https://' + 'a'.repeat(5000)), null)
  })
})

describe('zoom', () => {
  it('steps through fixed levels from any value and stays in range', () => {
    assert.equal(stepZoom(1, 1), 1.1)
    assert.equal(stepZoom(1, -1), 0.9)
    assert.equal(stepZoom(0.826, 1), 0.9)
    assert.equal(stepZoom(0.826, -1), 0.8)
    assert.equal(stepZoom(MAX_ZOOM, 1), MAX_ZOOM)
    assert.equal(stepZoom(MIN_ZOOM, -1), MIN_ZOOM)
    assert.equal(clampZoom(100), MAX_ZOOM)
    assert.equal(clampZoom(0), 1)
    assert.equal(clampZoom(Number.NaN), 1)
    assert.equal(percent(0.826), '83%')
  })

  it('fits the width', () => {
    assert.equal(fitWidthZoom(816, 674), 674 / 816)
    assert.equal(fitWidthZoom(816, 0), 1)
    assert.equal(fitWidthZoom(0, 600), 1)
    assert.equal(fitWidthZoom(100, 10_000), MAX_ZOOM)
  })
})

describe('which pages are drawn', () => {
  const slots = layoutSlots(Array(100).fill(1000), 12, 12)

  it('lays the pages out with gaps', () => {
    assert.deepEqual(slots.tops.slice(0, 3), [12, 1024, 2036])
    assert.equal(slots.total, 12 + 100 * 1000 + 99 * 12 + 12)
    assert.equal(layoutSlots([], 12, 12).total, 0)
  })

  it('finds the pages in view and the one showing most', () => {
    assert.deepEqual(visiblePages(slots, 0, 600), { first: 0, last: 0, current: 0 })
    // the boundary between pages 1 and 2 in the middle of the view
    const v = visiblePages(slots, 800, 600)
    assert.deepEqual([v.first, v.last], [0, 1])
    assert.equal(v.current, 1)
    // far down a 100-page file
    const far = visiblePages(slots, slots.tops[73] - 100, 600)
    assert.deepEqual([far.first, far.last, far.current], [72, 73, 73])
    assert.deepEqual(visiblePages(layoutSlots([], 12, 12), 0, 600), { first: -1, last: -1, current: -1 })
  })

  it('draws the view and one page each side, keeps one more, releases the rest', () => {
    assert.deepEqual(renderWindow(10, 11, 100), { draw: [9, 12], keep: [8, 13] })
    assert.deepEqual(renderWindow(0, 0, 100), { draw: [0, 1], keep: [0, 2] })
    assert.deepEqual(renderWindow(99, 99, 100), { draw: [98, 99], keep: [97, 99] })
    assert.deepEqual(renderWindow(-1, -1, 0), { draw: [0, -1], keep: [0, -1] })
    // a 500-page file never holds more than (view + 2) + 2 canvases
    const w = renderWindow(250, 251, 500)
    assert.equal(w.keep[1] - w.keep[0] + 1, 6)
  })

  it('reads a typed page number', () => {
    assert.equal(parsePageNumber(' 12 ', 40), 12)
    assert.equal(parsePageNumber('0', 40), null)
    assert.equal(parsePageNumber('41', 40), null)
    assert.equal(parsePageNumber('3a', 40), null)
    assert.equal(parsePageNumber('-2', 40), null)
    assert.equal(parsePageNumber('', 40), null)
  })

  it('caps the canvas resolution', () => {
    assert.equal(outputScale(800, 1000, 2), 2)
    assert.equal(outputScale(800, 1000, 0.5), 1)
    // a huge page at 3x would need 3264 x 4224 x 9 pixels: capped near 16.7 M
    const s = outputScale(3264, 4224, 3)
    assert.ok(s < 3 && 3264 * s * 4224 * s <= 16_777_216 + 1)
    assert.equal(outputScale(0, 0, 2), 2)
  })
})

describe('collapsed memory', () => {
  it('remembers per file and survives broken or blocked storage', () => {
    const st = memoryStorage()
    assert.equal(isCollapsed(st, 'a'), false)
    setCollapsed(st, 'a', true)
    setCollapsed(st, 'b', true)
    assert.equal(isCollapsed(st, 'a'), true)
    setCollapsed(st, 'a', false)
    assert.equal(isCollapsed(st, 'a'), false)
    assert.equal(isCollapsed(st, 'b'), true)
    assert.deepEqual(JSON.parse(st.data.get(COLLAPSED_KEY)), ['b'])

    assert.equal(isCollapsed(memoryStorage({ [COLLAPSED_KEY]: '{not json' }), 'a'), false)
    assert.equal(isCollapsed(memoryStorage({ [COLLAPSED_KEY]: '{"a":1}' }), 'a'), false)
    const throwing = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } }
    assert.equal(isCollapsed(throwing, 'a'), false)
    assert.doesNotThrow(() => setCollapsed(throwing, 'a', true))
    assert.equal(isCollapsed(null, 'a'), false)
  })

  it('keeps the newest 300', () => {
    const st = memoryStorage()
    for (let i = 0; i < 310; i++) setCollapsed(st, `f${i}`, true)
    const list = JSON.parse(st.data.get(COLLAPSED_KEY))
    assert.equal(list.length, 300)
    assert.equal(list[0], 'f10')
    assert.equal(isCollapsed(st, 'f309'), true)
  })
})
