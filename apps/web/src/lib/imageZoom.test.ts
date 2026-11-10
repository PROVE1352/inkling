// @ts-nocheck — Node test file (node:test types are not part of the web tsconfig); not bundled.
// Run: cd apps/server && npx tsx --test ../web/src/lib/imageZoom.test.ts
// The image viewer's zoom and pan arithmetic (docs/adr/2386-*).
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  MAX_SCALE,
  clampPan,
  fileNameFromUrl,
  fitScale,
  fitView,
  percent,
  stepZoom,
  toggleActual,
  wheelFactor,
  zoomAt,
} from './imageZoom'

const big = { w: 3910, h: 2060 }
const stage = { w: 1280, h: 700 }

describe('imageZoom', () => {
  it('fits a large image and never blows up a small one', () => {
    assert.equal(fitScale(big, stage), Math.min(1280 / 3910, 700 / 2060))
    assert.equal(fitScale({ w: 200, h: 100 }, stage), 1)
    assert.equal(fitScale({ w: 0, h: 0 }, stage), 1)
  })

  it('centres the fitted image', () => {
    const v = fitView(big, stage)
    const w = big.w * v.scale
    const h = big.h * v.scale
    assert.ok(Math.abs(v.x - (stage.w - w) / 2) < 1e-9)
    assert.ok(Math.abs(v.y - (stage.h - h) / 2) < 1e-9)
  })

  it('zooming keeps the point under the cursor in place', () => {
    const v0 = fitView(big, stage)
    const px = 700
    const py = 330
    const ix = (px - v0.x) / v0.scale
    const iy = (py - v0.y) / v0.scale
    const v1 = zoomAt(v0, v0.scale * 3, px, py, big, stage)
    assert.ok(Math.abs(v1.x + ix * v1.scale - px) < 1e-6)
    assert.ok(Math.abs(v1.y + iy * v1.scale - py) < 1e-6)
  })

  it('clamps the scale between the fit and the maximum', () => {
    const v0 = fitView(big, stage)
    assert.equal(zoomAt(v0, 0.01, 0, 0, big, stage).scale, v0.scale)
    assert.equal(zoomAt(v0, 100, 0, 0, big, stage).scale, MAX_SCALE)
    assert.equal(stepZoom(v0, -1, big, stage).scale, v0.scale)
    assert.ok(stepZoom(v0, 1, big, stage).scale > v0.scale)
  })

  it('panning cannot open an empty band at an edge', () => {
    const v = clampPan({ scale: 1, x: 500, y: 500 }, big, stage)
    assert.equal(v.x, 0)
    assert.equal(v.y, 0)
    const far = clampPan({ scale: 1, x: -99999, y: -99999 }, big, stage)
    assert.equal(far.x, stage.w - big.w)
    assert.equal(far.y, stage.h - big.h)
  })

  it('double-click goes fit -> 100% -> fit', () => {
    const v0 = fitView(big, stage)
    const v1 = toggleActual(v0, 640, 350, big, stage)
    assert.equal(v1.scale, 1)
    const v2 = toggleActual(v1, 640, 350, big, stage)
    assert.equal(v2.scale, v0.scale)
    // an image already shown at 100% stays fitted
    const small = { w: 300, h: 200 }
    assert.equal(toggleActual(fitView(small, stage), 10, 10, small, stage).scale, 1)
  })

  it('wheel: down zooms out, up zooms in, a pinch is more sensitive, lines count as 16 px', () => {
    assert.ok(wheelFactor(100, 0, false) < 1)
    assert.ok(wheelFactor(-100, 0, false) > 1)
    assert.ok(wheelFactor(-10, 0, true) > wheelFactor(-10, 0, false))
    assert.equal(wheelFactor(-3, 1, false), wheelFactor(-48, 0, false))
  })

  it('labels and names', () => {
    assert.equal(percent(0.3274), '33%')
    assert.equal(percent(1), '100%')
    assert.equal(fileNameFromUrl('/api/files/abc/screen%20shot.png?sig=1&exp=2'), 'screen shot.png')
    assert.equal(fileNameFromUrl('https://example.com/a/b/c.jpg#x'), 'c.jpg')
    assert.equal(fileNameFromUrl('data:image/png;base64,AAAA'), '')
    assert.equal(fileNameFromUrl('/bad/%E0%A4%A.png'), '%E0%A4%A.png')
  })
})
