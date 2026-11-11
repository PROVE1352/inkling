// The struct scan of collab updates (0.22.1 N1(a), docs/adr/2540-*): it must count what Yjs's own decoder
// reads, for every kind of content, without decoding; and anything it cannot read must come back as an
// upper bound.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import * as Y from 'yjs'
import { liveStructCount, structGrowthBound, syncUpdateBounds, updateShape } from './collabUpdateShape'

/** What Yjs reads from the update: structs (subdocuments weighted like the scan) and delete ranges. */
function decoded(update: Uint8Array): { structs: number; deleteRanges: number } {
  const d = Y.decodeUpdate(update)
  let ranges = 0
  for (const r of d.ds.clients.values()) ranges += r.length
  let structs = 0
  for (const s of d.structs) structs += s instanceof Y.Item && s.content instanceof Y.ContentDoc ? 16 : 1
  return { structs, deleteRanges: ranges }
}

describe('collab update shape', () => {
  it('counts the structs and delete ranges of every content kind like Yjs does', () => {
    const doc = new Y.Doc()
    const steps: Uint8Array[] = []
    doc.on('update', (u: Uint8Array) => steps.push(u))
    const text = doc.getText('t')
    text.insert(0, 'hello world, 안녕하세요 🙂')
    text.format(0, 5, { bold: true })
    text.insertEmbed(3, { image: 'x.png' })
    text.delete(2, 4)
    const map = doc.getMap('m')
    map.set('n', 1)
    map.set('neg', -123456789)
    map.set('f', 1.5)
    map.set('big', 2n ** 60n)
    map.set('s', 'str')
    map.set('o', { a: [1, 'b', null, true, false, { c: new Uint8Array([1, 2, 3]) }], u: undefined })
    map.set('bin', new Uint8Array([9, 8, 7]))
    map.set('sub', new Y.Map())
    map.set('doc', new Y.Doc())
    const frag = doc.getXmlFragment('document')
    const el = new Y.XmlElement('paragraph')
    el.setAttribute('textAlignment', 'left')
    el.insert(0, [new Y.XmlText('para')])
    frag.insert(0, [el, new Y.XmlHook('hook')] as never)
    const arr = doc.getArray('a')
    arr.insert(0, [1, 2, 3, 'x', { y: 1 }])
    arr.delete(1, 2)
    map.delete('n')
    steps.push(Y.encodeStateAsUpdate(doc))
    for (const u of steps) {
      const shape = updateShape(u)
      assert.equal(shape.parsed, true)
      assert.deepEqual({ structs: shape.structs, deleteRanges: shape.deleteRanges }, decoded(u))
    }
  })

  it('a map of tiny entries: one struct per entry, nothing placed', () => {
    const doc = new Y.Doc()
    doc.transact(() => {
      for (let i = 0; i < 5000; i++) doc.getMap('m').set(i.toString(36), 0)
    })
    const shape = updateShape(Y.encodeStateAsUpdate(doc))
    assert.equal(shape.structs, 5000)
    assert.equal(structGrowthBound(shape), 5000)
  })

  it('the bound covers what applying really adds, typing at random places included', () => {
    const a = new Y.Doc()
    a.getText('t').insert(0, 'x'.repeat(2000))
    const server = new Y.Doc()
    Y.applyUpdate(server, Y.encodeStateAsUpdate(a))
    let seed = 1
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647
    for (let round = 0; round < 20; round++) {
      const sv = Y.encodeStateVector(a)
      a.transact(() => {
        for (let i = 0; i < 50; i++) {
          const t = a.getText('t')
          if (rnd() < 0.3) t.delete(Math.floor(rnd() * (t.length - 1)), 1)
          else t.insert(Math.floor(rnd() * t.length), 'y')
        }
      })
      const u = Y.encodeStateAsUpdate(a, sv)
      const before = liveStructCount(server as never)
      Y.applyUpdate(server, u)
      assert.ok(liveStructCount(server as never) - before <= structGrowthBound(updateShape(u)))
    }
  })

  it('anything unreadable comes back as its byte length, never less', () => {
    const u = Y.encodeStateAsUpdate((() => { const d = new Y.Doc(); d.getText('t').insert(0, 'abc'); return d })())
    for (let cut = 1; cut < u.length; cut++) {
      const shape = updateShape(u.subarray(0, cut))
      if (!shape.parsed) assert.equal(shape.structs, cut)
    }
    const junk = updateShape(new Uint8Array([1, 3, 7, 0, 0xff, 0xff, 0xff]))
    assert.equal(junk.parsed, false)
    assert.equal(junk.structs, 7)
    // nested any values deeper than the scan follows
    const deep = new Uint8Array([1, 1, 1, 0, 8, 1, 1, 1, 0x6d, 1, ...Array(100).fill(117).flatMap((x) => [x, 1]), 126, 0])
    assert.equal(updateShape(deep).parsed, false)
  })

  it('finds the update inside Sync update and step 2 frames only', () => {
    const name = new TextEncoder().encode('page')
    const frame = (type: number, sync: number, payload: number[]) => new Uint8Array([name.length, ...name, type, sync, payload.length, ...payload])
    assert.deepEqual(syncUpdateBounds(frame(0, 2, [0, 0])), { start: 8, end: 10 })
    assert.deepEqual(syncUpdateBounds(frame(4, 1, [0, 0])), { start: 8, end: 10 })
    assert.equal(syncUpdateBounds(frame(0, 0, [0])), null) // step 1
    assert.equal(syncUpdateBounds(frame(1, 2, [0, 0])), null) // awareness
    assert.equal(syncUpdateBounds(new Uint8Array([9, 1])), null)
  })
})
