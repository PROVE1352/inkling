import assert from 'node:assert/strict'
import { test } from 'node:test'
import { inflateSync } from 'node:zlib'
import { crc32, encodePng } from './png'
import { HIGHLIGHTER_OPACITY, INK_MAX_TILES, INK_TILE_MAX_PX, renderInk } from './render'

/** Decode an 8-bit RGB PNG written by encodePng (filters None/Sub/Up) back to pixels. */
function decode(png: Buffer): { width: number; height: number; px: (x: number, y: number) => [number, number, number] } {
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  let off = 8
  let width = 0
  let height = 0
  const idat: Buffer[] = []
  while (off < png.length) {
    const len = png.readUInt32BE(off)
    const type = png.toString('latin1', off + 4, off + 8)
    const data = png.subarray(off + 8, off + 8 + len)
    assert.equal(png.readUInt32BE(off + 8 + len), crc32(png, off + 4, off + 8 + len), `crc of ${type}`)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      assert.equal(data[8], 8)
      assert.equal(data[9], 2)
    }
    if (type === 'IDAT') idat.push(data)
    off += 12 + len
  }
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * 3
  const out = new Uint8Array(stride * height)
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)]
    for (let i = 0; i < stride; i++) {
      const v = raw[y * (stride + 1) + 1 + i]
      const a = i >= 3 ? out[y * stride + i - 3] : 0
      const b = y > 0 ? out[(y - 1) * stride + i] : 0
      out[y * stride + i] = (f === 0 ? v : f === 1 ? v + a : v + b) & 0xff
    }
  }
  return {
    width,
    height,
    px: (x, y) => [out[y * stride + x * 3], out[y * stride + x * 3 + 1], out[y * stride + x * 3 + 2]],
  }
}

const line = (x0: number, x1: number, y: number, p = 1): number[] => {
  const pts: number[] = []
  for (let x = x0; x <= x1; x += 4) pts.push(x, y, p)
  return pts
}

test('crc32 matches the standard check value', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926)
})

test('encodePng round-trips pixels and is deterministic', () => {
  const rgb = new Uint8Array(5 * 4 * 3)
  for (let i = 0; i < rgb.length; i++) rgb[i] = (i * 37) & 0xff
  const a = encodePng(rgb, 5, 4)
  assert.deepEqual(encodePng(rgb, 5, 4), a)
  const d = decode(a)
  assert.equal(d.width, 5)
  assert.equal(d.height, 4)
  assert.deepEqual(d.px(2, 3), [rgb[(3 * 5 + 2) * 3], rgb[(3 * 5 + 2) * 3 + 1], rgb[(3 * 5 + 2) * 3 + 2]])
})

test('a pen stroke is drawn opaque in its colour, the rest stays white', () => {
  const r = renderInk([{ tool: 'pen', color: '#ff0000', size: 7, points: line(100, 300, 50.3) }])
  assert.equal(r.tiles.length, 1)
  assert.equal(r.drawn, 1)
  const d = decode(r.tiles[0].png)
  assert.equal(d.width, 896)
  assert.equal(d.height, r.tiles[0].pixelHeight)
  assert.deepEqual(d.px(200, 50), [255, 0, 0])
  assert.deepEqual(d.px(200, 10), [255, 255, 255])
  assert.deepEqual(d.px(600, 50), [255, 255, 255])
  // anti-aliased edge: some pixel at the stroke boundary is between the two colours
  const col = [46, 47, 48, 49, 50, 51, 52, 53, 54].map((y) => d.px(200, y)[1])
  assert.ok(col.some((g) => g > 0 && g < 255), `expected a partially covered pixel, got ${col}`)
})

test('a highlighter blends at 0.32 over white and over a pen stroke', () => {
  const r = renderInk([
    { tool: 'pen', color: '#000000', size: 10, points: line(100, 300, 60) },
    { tool: 'highlighter', color: '#0000ff', size: 40, points: line(200, 400, 60) },
  ])
  const d = decode(r.tiles[0].png)
  const white = Math.round(255 * (1 - HIGHLIGHTER_OPACITY))
  assert.deepEqual(d.px(350, 60), [white, white, 255])
  // over black: black * 0.68 + blue * 0.32
  assert.deepEqual(d.px(250, 60), [0, 0, Math.round(255 * HIGHLIGHTER_OPACITY)])
})

test('a tap (one point) is a dot; scale changes the image size', () => {
  const r = renderInk([{ color: '#00ff00', size: 20, points: [50, 50, 1] }], { scale: 0.5 })
  const d = decode(r.tiles[0].png)
  assert.equal(d.width, 448)
  assert.deepEqual(d.px(25, 25), [0, 255, 0])
})

test('tall pages are cut into tiles; the call stops after INK_MAX_TILES with nextTop', () => {
  const strokes = [
    { color: '#000000', size: 4, points: line(10, 50, 100) },
    { color: '#000000', size: 4, points: line(10, 50, INK_TILE_MAX_PX * 5) },
  ]
  const r = renderInk(strokes)
  assert.equal(r.tiles.length, INK_MAX_TILES)
  assert.equal(r.tiles[0].top, 0)
  assert.equal(r.tiles[1].top, INK_TILE_MAX_PX)
  assert.equal(r.nextTop, INK_TILE_MAX_PX * INK_MAX_TILES)
  assert.equal(r.drawn, 1)
  const rest = renderInk(strokes, { top: r.nextTop! })
  assert.equal(rest.nextTop, null)
  assert.equal(rest.drawn, 1)
  // a region renders only that range
  const region = renderInk(strokes, { top: 50, height: 100 })
  assert.equal(region.tiles.length, 1)
  assert.equal(region.tiles[0].pixelHeight, 100)
  assert.deepEqual(decode(region.tiles[0].png).px(30, 50), [0, 0, 0])
})

test('malformed stored strokes are skipped, not thrown', () => {
  const r = renderInk([
    { color: 'red', size: 3, points: [10, 10, 0.5, 20, 20, 0.5] },
    { color: '#000000', size: 3, points: 'nope' },
    { color: '#000000', size: Number.NaN, points: [Number.NaN, 1, 1] },
    {},
  ])
  assert.equal(r.drawn, 1)
})

test('the same strokes give the same bytes', () => {
  const s = [{ color: '#123456', size: 3, points: line(0, 896, 30, 0.4) }]
  assert.deepEqual(renderInk(s).tiles[0].png, renderInk(s).tiles[0].png)
})
