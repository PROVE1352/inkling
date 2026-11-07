// Stored-state format detection and helpers (docs/adr/1101-*).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as Y from 'yjs'
import { mayHaveMentions } from './notify/mentionScan'
import {
  applyStoredState,
  docFromStoredState,
  STATE_V1,
  STATE_V2,
  stateVectorCovers,
  stateVectorOfStored,
  stateVectorsEqual,
  toV1,
  wholeStateFormat,
} from './yState'

/** A doc edited by `clients` different clients, with deletions (GC structs + delete set). */
function docWithClients(clients: number): Y.Doc {
  const doc = new Y.Doc()
  for (let i = 0; i < clients; i++) {
    const peer = new Y.Doc()
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc))
    const text = peer.getText('t')
    text.insert(text.length, `client ${i} wrote this line. `)
    if (i % 3 === 0 && text.length > 10) text.delete(0, 5)
    peer.getXmlFragment('document').insert(0, [new Y.XmlElement(i % 2 ? 'paragraph' : 'mention')])
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer))
  }
  return doc
}

test('whole-document states: V1 never starts with 0 unless empty, V2 always does', () => {
  for (const n of [1, 2, 5, 127, 128, 129, 300]) {
    const doc = docWithClients(n)
    const v1 = Y.encodeStateAsUpdate(doc)
    const v2 = Y.encodeStateAsUpdateV2(doc)
    assert.equal(wholeStateFormat(v1), STATE_V1, `${n} clients, V1`)
    assert.equal(wholeStateFormat(v2), STATE_V2, `${n} clients, V2`)
    // V2 has a fixed overhead of a few dozen bytes; it wins once there is content
    if (n >= 127) assert.ok(v2.length < v1.length, `${n} clients: V2 ${v2.length} < V1 ${v1.length}`)
    for (const s of [v1, v2]) {
      const back = docFromStoredState(s)
      assert.equal(back.getText('t').toString(), doc.getText('t').toString())
      assert.ok(stateVectorsEqual(stateVectorOfStored(s), Y.encodeStateVector(doc)))
    }
    assert.deepEqual(toV1(v2), Y.convertUpdateFormatV2ToV1(v2))
    assert.equal(toV1(v1), v1)
  }
  const empty = new Y.Doc()
  assert.equal(wholeStateFormat(Y.encodeStateAsUpdate(empty)), STATE_V1)
  assert.equal(wholeStateFormat(Y.encodeStateAsUpdateV2(empty)), STATE_V2)
  assert.equal(wholeStateFormat(new Uint8Array()), STATE_V1)
  // an empty stored state applies as nothing (old rows of never-edited pages)
  const d = new Y.Doc()
  applyStoredState(d, new Uint8Array())
  assert.equal(d.store.clients.size, 0)
})

test('the mention pre-check still sees chips in V2 bytes', () => {
  const doc = docWithClients(4)
  assert.equal(mayHaveMentions(Y.encodeStateAsUpdateV2(doc)), true)
  const plain = new Y.Doc()
  plain.getText('t').insert(0, 'no chips here')
  assert.equal(mayHaveMentions(Y.encodeStateAsUpdateV2(plain)), false)
})

test('state vector cover/equality ignore client order', () => {
  const a = new Map([[1, 5], [2, 3]])
  const b = new Map([[2, 3], [1, 5]])
  assert.ok(stateVectorsEqual(a, b))
  assert.ok(stateVectorCovers(new Map([[1, 6], [2, 3], [9, 1]]), a))
  assert.equal(stateVectorCovers(a, new Map([[1, 6]])), false)
  assert.equal(stateVectorCovers(a, new Map([[7, 1]])), false)
})
