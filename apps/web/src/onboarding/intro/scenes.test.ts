// @ts-nocheck
// The intro motion is a pure function of t (docs/adr/2382-*, 2385-*): same t → same SVG, no clock or
// random source, Inkling's color tokens only, 20–30 s in 4 scenes of 5–8 s, captions in the full frame,
// every word on screen long enough to read, no "open source" in the intro's copy.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import en from '../../i18n/en/onboarding.ts'
import ko from '../../i18n/ko/onboarding.ts'
import {
  INTRO_DURATION,
  INTRO_WORDS,
  SCENE_COUNT,
  SCENE_LENGTH,
  STILL_TIMES,
  captionOpacity,
  dropAt,
  renderIntroFrame,
  sceneAt,
  wrapLines,
} from './scenes.ts'

const copyFrom = (d) => ({
  scenes: [1, 2, 3, 4].map((n) => ({ title: d[`intro.s${n}.title`], body: d[`intro.s${n}.body`], alt: d[`intro.s${n}.alt`] })),
  w: Object.fromEntries(INTRO_WORDS.map((k) => [k, d[`intro.${k}`]])),
})

test('length: 20–30 s, four scenes of 5–8 s', () => {
  assert.ok(INTRO_DURATION >= 20 && INTRO_DURATION <= 30)
  assert.equal(SCENE_COUNT, 4)
  assert.ok(SCENE_LENGTH >= 5 && SCENE_LENGTH <= 8)
  assert.deepEqual([0, 6.4, 6.5, 13.1, 25.9, 99].map((t) => sceneAt(t).index), [0, 0, 1, 2, 3, 3])
  STILL_TIMES.forEach((t, i) => assert.equal(sceneAt(t).index, i, `still ${i} is inside its scene`))
})

test('every word of the pictures has a string in both languages', () => {
  for (const d of [en, ko]) for (const k of INTRO_WORDS) assert.equal(typeof d[`intro.${k}`], 'string', `intro.${k}`)
})

test('pure: the same t gives the same markup, different t different markup', () => {
  const c = copyFrom(en)
  for (const t of [0, 0.5, 3.33, 7.9, 9.1, 13.6, 15, 18.4, 20, 22, 25.7, INTRO_DURATION]) {
    assert.equal(renderIntroFrame(t, c, { frame: 'full' }), renderIntroFrame(t, c, { frame: 'full' }))
    for (const aspect of [0.7, 2]) assert.equal(renderIntroFrame(t, c, { frame: 'art', aspect }), renderIntroFrame(t, c, { frame: 'art', aspect }))
  }
  assert.notEqual(renderIntroFrame(2, c), renderIntroFrame(2.5, c))
  assert.deepEqual(dropAt(10), dropAt(10))
  // {frame:'art'} alone still works (the promo render calls it that way)
  assert.match(renderIntroFrame(3, c, { frame: 'art' }), /^<svg /)
})

test('the camera frames for the box: a phone frame is narrower and closer than a wide one', () => {
  const c = copyFrom(ko)
  const vb = (svg) => svg.match(/<svg x="0" y="0" width="(\d+)" height="(\d+)" viewBox="([-\d. ]+)"/)
  const wide = vb(renderIntroFrame(2, c, { frame: 'art', aspect: 2 }))
  const phone = vb(renderIntroFrame(2, c, { frame: 'art', aspect: 0.7 }))
  const ww = Number(wide[3].split(' ')[2])
  const pw = Number(phone[3].split(' ')[2])
  assert.ok(pw < ww, `phone shows ${pw} units across, wide ${ww}`)
  assert.ok(pw <= 700)
  assert.notEqual(renderIntroFrame(2, c, { frame: 'art', aspect: 0.7 }), renderIntroFrame(2, c, { frame: 'art', aspect: 2 }))
})

test('the last frame is the logo; t past the end is the same frame', () => {
  const c = copyFrom(en)
  const last = renderIntroFrame(INTRO_DURATION, c)
  assert.match(last, />Inkling</)
  assert.equal(renderIntroFrame(INTRO_DURATION + 5, c), last)
})

test('no clock, random source, CSS animation or SMIL in the scene code', () => {
  const src = readFileSync(new URL('./scenes.ts', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
  assert.doesNotMatch(src, /Math\.random|Date\.now|performance\.now|new Date|requestAnimationFrame|document\.|window\./)
  for (const t of [3, 6.8, 12, 14, 21]) {
    const svg = renderIntroFrame(t, copyFrom(en), { frame: 'full' })
    assert.doesNotMatch(svg, /<animate|@keyframes|animation:|transition:|<canvas|<image|<foreignObject/)
  }
})

test('colors are Inkling tokens (option colours included), the font is the UI font', () => {
  const c = copyFrom(ko)
  const allowed = /^(app|side|line|ink|sub|accent|accent-soft|gray-400|orange-500|green-500|pink-500|blue-500)$/
  for (let t = 0; t <= INTRO_DURATION; t += 0.35) {
    for (const opts of [{ frame: 'full' }, { frame: 'art', aspect: 0.7 }]) {
      const svg = renderIntroFrame(t, c, opts)
      assert.doesNotMatch(svg, /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|oklch\(/i, `t=${t}`)
      for (const m of svg.matchAll(/var\(--color-([a-z0-9-]+)\)/g)) assert.match(m[1], allowed, `t=${t}: --color-${m[1]}`)
      for (const m of svg.matchAll(/font-family:([^;"]+)/g)) {
        assert.ok(/var\(--font-sans\)|ui-monospace/.test(m[1]), m[1])
      }
    }
  }
})

test('the full frame carries the scene’s caption; the art frame does not', () => {
  const c = copyFrom(ko)
  const mid = 6.5 + 3
  assert.ok(captionOpacity(mid) === 1)
  assert.match(renderIntroFrame(mid, c, { frame: 'full' }), new RegExp(c.scenes[1].title))
  assert.doesNotMatch(renderIntroFrame(mid, c, { frame: 'art' }), new RegExp(c.scenes[1].title))
  assert.match(renderIntroFrame(mid, c, { frame: 'full' }), /viewBox="0 0 1920 1080"/)
  // text is escaped
  const evil = { ...c, w: { ...c.w, pageA: '<script>x</script>' } }
  assert.doesNotMatch(renderIntroFrame(2, evil), /<script>/)
})

test('captions wrap to two lines on the 1920 frame in both languages', () => {
  for (const d of [en, ko]) {
    for (let n = 1; n <= 4; n++) {
      const lines = wrapLines(d[`intro.s${n}.body`], 1600 / 34)
      assert.ok(lines.length <= 2, `${d['intro.label']} s${n}: ${lines.length} lines`)
    }
  }
})

test('every word in the pictures stays on screen for at least 0.8 s once it is complete', () => {
  for (const d of [en, ko]) {
    const c = copyFrom(d)
    const step = 0.05
    const frames = []
    for (let i = 0; i * step <= INTRO_DURATION + 1e-9; i++) {
      const svg = renderIntroFrame(i * step, c, { frame: 'art', aspect: 2 })
      frames.push(new Set([...svg.matchAll(/<text [^>]*>([^<]*)<\/text>/g)].map((m) => m[1]).filter(Boolean)))
    }
    const all = new Set(frames.flatMap((f) => [...f]))
    // a string that is the start of a longer one is a word being typed
    const complete = [...all].filter((s) => ![...all].some((o) => o !== s && o.startsWith(s)))
    for (const s of complete) {
      let best = 0
      let run = 0
      for (const f of frames) {
        run = f.has(s) ? run + 1 : 0
        best = Math.max(best, run)
      }
      assert.ok(best * step >= 0.8 - 1e-9, `${d['intro.label']}: "${s}" is on screen for ${(best * step).toFixed(2)} s`)
    }
  }
})

test('the intro does not call Inkling open source', () => {
  for (const d of [en, ko]) {
    for (const [k, v] of Object.entries(d)) {
      if (!k.startsWith('intro.') && !k.startsWith('getStarted.')) continue
      assert.doesNotMatch(v, /open[ -]?source|오픈\s?소스/i, k)
    }
  }
})
