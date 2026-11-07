// Row template defaults and body helpers (docs/adr/1181-*): no database needed.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import * as Y from 'yjs'
import type { CollectionField } from '@inkling/shared'
import { bodyHasContent, mergeBody, resolveTemplateProps, sanitizeTemplateProps } from './rowTemplates'
import { blocksToStateBuffer } from './md/convert'

const FIELDS: CollectionField[] = [
  { id: 's', name: 'Status', type: 'select', options: [{ id: 'o1', name: 'A', color: 'gray' }] },
  { id: 'm', name: 'Tags', type: 'multiSelect', options: [{ id: 't1', name: 'x', color: 'red' }, { id: 't2', name: 'y', color: 'blue' }] },
  { id: 'd', name: 'Due', type: 'date' },
  { id: 'p', name: 'Owner', type: 'person' },
  { id: 'n', name: 'Points', type: 'number' },
  { id: 'c', name: 'Done', type: 'checkbox' },
  { id: 't', name: 'Notes', type: 'text' },
  { id: 'r', name: 'Link', type: 'relation', relation: { targetPageId: '00000000-0000-4000-8000-000000000001' } },
]
const UID = '11111111-1111-4111-8111-111111111111'

describe('sanitizeTemplateProps', () => {
  it('keeps valid defaults and the relative forms, drops the rest', () => {
    const out = sanitizeTemplateProps(FIELDS, {
      s: 'o1',
      m: ['t2', 'nope', 't2'],
      d: 'Today+7',
      p: 'me',
      n: 3,
      c: false,
      t: '{{author}}',
      r: [UID],
      unknown: 'x',
    })
    assert.deepEqual(out, { s: 'o1', m: ['t2'], d: 'today+7', p: 'me', n: 3, c: false, t: '{{author}}' })
  })
  it('rejects malformed values', () => {
    assert.deepEqual(
      sanitizeTemplateProps(FIELDS, { s: 'zzz', d: 'tomorrow', p: 'someone', n: Number.NaN, c: 'yes', t: 5 }),
      {},
    )
    assert.deepEqual(sanitizeTemplateProps(FIELDS, { d: '2026-02-30' }), { d: '2026-02-30' }, 'shape only; the resolver checks the calendar')
  })
})

describe('resolveTemplateProps', () => {
  const opts = { today: '2026-12-28', userId: UID, render: (s: string) => s.replace('{{author}}', 'Ada') }
  it('resolves relative dates across a year, me and text variables', () => {
    assert.deepEqual(resolveTemplateProps(FIELDS, { d: 'today+7', p: 'me', t: 'by {{author}}' }, opts), {
      d: '2027-01-04',
      p: UID,
      t: 'by Ada',
    })
    assert.deepEqual(resolveTemplateProps(FIELDS, { d: 'today-28' }, opts), { d: '2026-11-30' })
    assert.deepEqual(resolveTemplateProps(FIELDS, { d: 'today' }, opts), { d: '2026-12-28' })
  })
  it('drops an impossible fixed date', () => {
    assert.deepEqual(resolveTemplateProps(FIELDS, { d: '2026-02-30' }, opts), {})
  })
})

describe('template bodies', () => {
  it('bodyHasContent: empty paragraph vs text', () => {
    assert.equal(bodyHasContent(null), false)
    assert.equal(bodyHasContent(blocksToStateBuffer([{ type: 'paragraph', content: [] }] as never)), false)
    assert.equal(bodyHasContent(blocksToStateBuffer([{ type: 'paragraph', content: [{ type: 'text', text: 'hi', styles: {} }] }] as never)), true)
    assert.equal(bodyHasContent(blocksToStateBuffer([{ type: 'heading', props: { level: 2 }, content: [] }] as never)), true)
  })
  it('mergeBody keeps concurrent edits and rejects garbage', () => {
    const base = new Y.Doc()
    base.getXmlFragment('document').insert(0, [new Y.XmlElement('blockGroup')])
    const stored = mergeBody(null, Y.encodeStateAsUpdate(base))
    const a = new Y.Doc()
    const b = new Y.Doc()
    Y.applyUpdate(a, stored)
    Y.applyUpdate(b, stored)
    const sa = Y.encodeStateVector(a)
    const sb = Y.encodeStateVector(b)
    ;(a.getXmlFragment('document').get(0) as Y.XmlElement).insert(0, [new Y.XmlElement('fromA')])
    ;(b.getXmlFragment('document').get(0) as Y.XmlElement).insert(0, [new Y.XmlElement('fromB')])
    const merged = mergeBody(mergeBody(stored, Y.encodeStateAsUpdate(a, sa)), Y.encodeStateAsUpdate(b, sb))
    const c = new Y.Doc()
    Y.applyUpdate(c, merged)
    const xml = c.getXmlFragment('document').toString()
    assert.match(xml, /froma/i)
    assert.match(xml, /fromb/i)
    assert.throws(() => mergeBody(stored, new Uint8Array([1, 2, 3, 250])), /damaged/)
  })
})
