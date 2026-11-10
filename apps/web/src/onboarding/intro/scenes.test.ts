// @ts-nocheck
// The intro motion is a pure function of t (docs/adr/2382-*): same t → same SVG, no clock or random
// source, Inkling's color tokens only, 20–30 s in 4 scenes of 5–8 s, captions in the full frame.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import en from '../../i18n/en/onboarding.ts'
import ko from '../../i18n/ko/onboarding.ts'
import {
  INTRO_DURATION,
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
  pageA: d['intro.pageA'],
  pageB: d['intro.pageB'],
  peer: d['intro.peer'],
  backlink: d['intro.backlink'],
  views: [d['intro.view.table'], d['intro.view.board'], d['intro.view.calendar']],
  statuses: [d['intro.status.todo'], d['intro.status.doing'], d['intro.status.done']],
  rows: [d['intro.row1'], d['intro.row2'], d['intro.row3'], d['intro.row4']],
  agent: d['intro.agent'],
  clients: d['intro.clients'],
  suggestion: d['intro.suggestion'],
  undo: d['intro.undo'],
  server: d['intro.server'],
  offline: d['intro.offline'],
  openSource: d['intro.openSource'],
  tagline: d['intro.tagline'],
})

test('length: 20–30 s, four scenes of 5–8 s', () => {
  assert.ok(INTRO_DURATION >= 20 && INTRO_DURATION <= 30)
  assert.equal(SCENE_COUNT, 4)
  assert.ok(SCENE_LENGTH >= 5 && SCENE_LENGTH <= 8)
  assert.deepEqual([0, 6.4, 6.5, 13.1, 25.9, 99].map((t) => sceneAt(t).index), [0, 0, 1, 2, 3, 3])
  STILL_TIMES.forEach((t, i) => assert.equal(sceneAt(t).index, i, `still ${i} is inside its scene`))
})

test('pure: the same t gives the same markup, different t different markup', () => {
  const c = copyFrom(en)
  for (const t of [0, 0.5, 3.33, 7.9, 9.1, 15, 18.4, 22, 25.7, INTRO_DURATION]) {
    assert.equal(renderIntroFrame(t, c, { frame: 'full' }), renderIntroFrame(t, c, { frame: 'full' }))
  }
  assert.notEqual(renderIntroFrame(2, c), renderIntroFrame(2.5, c))
  assert.deepEqual(dropAt(10), dropAt(10))
})

test('no clock, random source, CSS animation or SMIL in the scene code', () => {
  const src = readFileSync(new URL('./scenes.ts', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
  assert.doesNotMatch(src, /Math\.random|Date\.now|performance\.now|new Date|requestAnimationFrame|document\.|window\./)
  const svg = renderIntroFrame(12, copyFrom(en), { frame: 'full' })
  assert.doesNotMatch(svg, /<animate|@keyframes|animation:|transition:/)
})

test('colors are Inkling tokens, the font is the UI font', () => {
  const c = copyFrom(ko)
  for (let t = 0; t <= INTRO_DURATION; t += 0.7) {
    const svg = renderIntroFrame(t, c, { frame: 'full' })
    assert.doesNotMatch(svg, /#[0-9a-f]{3,6}\b|rgb\(/i, `t=${t}`)
    for (const m of svg.matchAll(/font-family:([^;"]+)/g)) {
      assert.ok(/var\(--font-sans\)|ui-monospace/.test(m[1]), m[1])
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
  const evil = { ...c, pageA: '<script>x</script>' }
  assert.doesNotMatch(renderIntroFrame(5, evil), /<script>/)
})

test('captions wrap to two lines on the 1920 frame in both languages', () => {
  for (const d of [en, ko]) {
    for (let n = 1; n <= 4; n++) {
      const lines = wrapLines(d[`intro.s${n}.body`], 1600 / 34)
      assert.ok(lines.length <= 2, `${d['intro.label']} s${n}: ${lines.length} lines`)
    }
  }
})
