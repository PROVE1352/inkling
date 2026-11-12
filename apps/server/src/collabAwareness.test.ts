// The awareness caps without a server (0.22.1 fix 5, docs/adr/2552-*): echoes of ids already in the
// document are free, an id counts against the connection that brought it in, the document holds at most
// AWARENESS_MAX_DOC_IDS live ids, and old clock records without a state are swept.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  admitAwarenessFrame,
  AWARENESS_MAX_DOC_IDS,
  AWARENESS_META_KEEP_MS,
  newSocketAwareness,
  releaseAwareness,
  sweepAwarenessMeta,
  type AwarenessLike,
} from './collabAwareness'

function varUint(out: number[], n: number): void {
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80)
    n = Math.floor(n / 128)
  }
  out.push(n)
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
/** What y-protocols does with an admitted frame, enough for these tests. */
function apply(aw: AwarenessLike, entries: [number, number, string][], now = Date.now()): void {
  for (const [id, clock, state] of entries) {
    const cur = aw.meta.get(id)?.clock ?? 0
    if (cur < clock || (cur === clock && state === 'null' && aw.states.has(id))) {
      if (state === 'null') aw.states.delete(id)
      else aw.states.set(id, JSON.parse(state))
      aw.meta.set(id, { clock, lastUpdated: now })
    }
  }
}
const doc = (): AwarenessLike => ({ clientID: 1, states: new Map(), meta: new Map([[1, { clock: 0, lastUpdated: 0 }]]) })
const S = '{"user":{"name":"a"}}'

describe('awareness caps', () => {
  it('echoes of everyone else on the page are free; each connection counts only its own id', () => {
    const aw = doc()
    const conns = Array.from({ length: 12 }, () => ({}))
    const sock = newSocketAwareness()
    for (const [i, c] of conns.entries()) {
      const mine: [number, number, string][] = [[100 + i, 1, S]]
      assert.equal(admitAwarenessFrame(frame(mine), c, sock, aw), null)
      apply(aw, mine)
      // and it sends back everyone it learns about, as the provider does
      const echo = [...aw.states.keys()].map((id): [number, number, string] => [id, aw.meta.get(id)!.clock, S])
      assert.equal(admitAwarenessFrame(frame(echo), c, sock, aw), null)
    }
    // removals echoed back too
    const gone: [number, number, string][] = [[100, 2, 'null']]
    apply(aw, gone)
    for (const c of conns.slice(1)) assert.equal(admitAwarenessFrame(frame(gone), c, sock, aw), null)
  })

  it('a document holds at most AWARENESS_MAX_DOC_IDS live ids: the connection bringing in one more is refused', () => {
    const aw = doc()
    for (let i = 0; i < AWARENESS_MAX_DOC_IDS; i++) aw.states.set(10_000 + i, {})
    assert.equal(admitAwarenessFrame(frame([[1, 1, S]]), {}, newSocketAwareness(), aw), 'document')
    // an echo of one already there still passes
    aw.meta.set(10_000, { clock: 3, lastUpdated: 0 })
    assert.equal(admitAwarenessFrame(frame([[10_000, 3, S]]), {}, newSocketAwareness(), aw), null)
  })

  it('the socket tally counts the states its connections brought in, and leaves with them', () => {
    const aw = doc()
    const sock = newSocketAwareness()
    const c = {}
    const big = JSON.stringify({ b: 'x'.repeat(10_000) })
    assert.equal(admitAwarenessFrame(frame([[5, 1, big]]), c, sock, aw), null)
    assert.ok(sock.bytes >= 10_000)
    releaseAwareness(c, sock)
    assert.equal(sock.bytes, 0)
  })

  it('old clock records without a state are swept, recent ones and live ones stay', () => {
    const aw = doc()
    const now = 1_000_000
    aw.states.set(2, {})
    aw.meta.set(2, { clock: 1, lastUpdated: 0 })
    aw.meta.set(3, { clock: 2, lastUpdated: now - AWARENESS_META_KEEP_MS - 1 })
    aw.meta.set(4, { clock: 2, lastUpdated: now - 1000 })
    assert.equal(sweepAwarenessMeta(aw, now, true), 1)
    assert.deepEqual([...aw.meta.keys()].sort(), [1, 2, 4])
  })
})
