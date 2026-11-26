// Awareness `user` cleaned in place before Hocuspocus applies it (0.25.4, sec26 E-1, collabAwareness.ts
// cleanAwarenessUser): a colour that is not #rgb/#rrggbb becomes the neutral one (or goes, when that does not fit),
// a name that is not a string goes, a `user` that is not an object goes, and every length in the frame stays.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { admitAwarenessFrame, AWARENESS_FALLBACK_COLOR, awarenessCleaned, newSocketAwareness } from './collabAwareness'

function varUint(out: number[], n: number): void {
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80)
    n = Math.floor(n / 128)
  }
  out.push(n)
}
function readVarUint(b: Uint8Array, pos: number): [number, number] {
  let n = 0
  let mult = 1
  for (;;) {
    const x = b[pos++]
    n += (x & 0x7f) * mult
    if (x < 0x80) return [n, pos]
    mult *= 128
  }
}
function frame(entries: [number, number, string][]): Uint8Array {
  const enc = new TextEncoder()
  const inner: number[] = []
  varUint(inner, entries.length)
  for (const [id, clock, state] of entries) {
    varUint(inner, id)
    varUint(inner, clock)
    const b = enc.encode(state)
    varUint(inner, b.length)
    inner.push(...b)
  }
  const out = [1, 0x70, 1] // name "p", Awareness
  varUint(out, inner.length)
  out.push(...inner)
  return Uint8Array.from(out)
}
/** The states as y-protocols reads them (JSON.parse of each state string). */
function states(f: Uint8Array): { id: number; state: unknown; raw: string }[] {
  let pos = 3
  ;[, pos] = readVarUint(f, pos)
  let n: number
  ;[n, pos] = readVarUint(f, pos)
  const out: { id: number; state: unknown; raw: string }[] = []
  for (let i = 0; i < n; i++) {
    let id: number
    let len: number
    ;[id, pos] = readVarUint(f, pos)
    ;[, pos] = readVarUint(f, pos)
    ;[len, pos] = readVarUint(f, pos)
    const raw = new TextDecoder().decode(f.subarray(pos, pos + len))
    out.push({ id, state: JSON.parse(raw), raw })
    pos += len
  }
  return out
}
const admit = (f: Uint8Array) => admitAwarenessFrame(f, {}, newSocketAwareness(), undefined)
const userOf = (f: Uint8Array, i = 0) => (states(f)[i].state as { user?: Record<string, unknown> }).user

describe('awareness user cleaned before it is applied (sec26 E-1)', () => {
  it('a CSS colour becomes the neutral colour; the frame keeps its length and parses', () => {
    const css = '#000; position: fixed; inset: 0; background-image: url(https://evil.example/t.gif)'
    const f = frame([[11, 1, JSON.stringify({ user: { name: 'a', color: css, id: 'u1' }, cursor: null })]])
    const len = f.length
    assert.equal(admit(f), null)
    assert.equal(f.length, len)
    assert.deepEqual(userOf(f), { name: 'a', color: AWARENESS_FALLBACK_COLOR, id: 'u1' })
    assert.deepEqual((states(f)[0].state as { cursor: unknown }).cursor, null, 'other fields stay')
  })

  it('#rgb and #rrggbb pass untouched, byte for byte', () => {
    for (const color of ['#abc', '#A0b1C2', '#e03e3e']) {
      const st = JSON.stringify({ user: { name: 'n', color } })
      const f = frame([[12, 1, st]])
      const copy = Uint8Array.from(f)
      assert.equal(admit(f), null)
      assert.deepEqual(f, copy, color)
    }
  })

  it('a state without a user, null, and the removal of a state are untouched', () => {
    for (const st of ['{}', '{"cursor":null}', '{"user":null}', 'null']) {
      const f = frame([[13, 1, st]])
      const copy = Uint8Array.from(f)
      assert.equal(admit(f), null)
      assert.deepEqual(f, copy, st)
    }
  })

  it('a number or null colour has no room for the fallback: the colour goes', () => {
    for (const c of ['5', 'null', 'true']) {
      const f = frame([[14, 1, `{"user":{"name":"n","color":${c}}}`]])
      assert.equal(admit(f), null)
      assert.deepEqual(userOf(f), { name: 'n' }, c)
    }
  })

  it('other bad colours: an object, rgb(), a named colour, 4 or 8 hex digits, a trailing newline', () => {
    for (const color of [{ a: 1 }, 'rgb(1,2,3)', 'red', '#abcd', '#aabbccdd', '#aabbcc\n']) {
      const f = frame([[15, 1, JSON.stringify({ user: { name: 'n', color }, pad: 'xxxxxxxxxxxx' })]])
      assert.equal(admit(f), null)
      const c = userOf(f)!.color
      // the neutral colour when it fits in the bytes the bad one took, otherwise none
      assert.ok(c === AWARENESS_FALLBACK_COLOR || (c === undefined && JSON.stringify(color).length < 9), `${JSON.stringify(color)} -> ${c}`)
    }
  })

  it('a name that is not a string goes; a user that is not an object goes', () => {
    const f1 = frame([[16, 1, JSON.stringify({ user: { name: { x: 1 }, color: '#aabbcc' } })]])
    assert.equal(admit(f1), null)
    assert.deepEqual(userOf(f1), { color: '#aabbcc' })
    const f2 = frame([[17, 1, JSON.stringify({ user: 'a string', cursor: null })]])
    assert.equal(admit(f2), null)
    assert.deepEqual(states(f2)[0].state, { cursor: null })
  })

  it('a key written with escapes is the same key to JSON.parse', () => {
    const f = frame([[18, 1, '{"\\u0075ser":{"name":"n","\\u0063olor":"#000;position:fixed"}}']])
    assert.equal(admit(f), null)
    assert.equal(userOf(f)!.color, AWARENESS_FALLBACK_COLOR)
  })

  it('when the cleaned state is longer than the sent one, the whole message is dropped (no entry applied)', () => {
    // 1e21 is written back as 1e+21: one byte longer each
    const st = `{"pad":[${Array(40).fill('1e21').join(',')}],"user":{"color":5}}`
    const f = frame([
      [19, 1, '{"user":{"name":"ok","color":"#aabbcc"}}'],
      [20, 1, st],
    ])
    const dropped = awarenessCleaned.dropped
    assert.equal(admit(f), null)
    assert.equal(awarenessCleaned.dropped, dropped + 1)
    assert.equal(states(f).length, 0, 'the entry count is zero: y-protocols reads no entry')
  })

  it('an echo (an older or equal clock) is not parsed or changed', () => {
    const st = JSON.stringify({ user: { name: 'n', color: 'red' } })
    const f = frame([[21, 3, st]])
    const copy = Uint8Array.from(f)
    const aw = { clientID: 1, states: new Map<number, unknown>([[21, {}]]), meta: new Map([[21, { clock: 3, lastUpdated: Date.now() }]]) }
    assert.equal(admitAwarenessFrame(f, {}, newSocketAwareness(), aw), null)
    assert.deepEqual(f, copy)
  })
})
