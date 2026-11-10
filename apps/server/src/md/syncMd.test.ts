// Run: cd apps/server && npx tsx --test src/md/syncMd.test.ts
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import * as Y from 'yjs'
import {
  contentHashOf,
  frontmatterToMeta,
  isLegacyRevision,
  metaHash,
  normalizeMarkdown,
  parseFrontmatter,
  renderFrontmatter,
  revisionFromDoc,
  revisionFromState,
  revisionSvPart,
} from './syncMd'

describe('frontmatter', () => {
  it('parses the supported YAML subset', () => {
    const fm = parseFrontmatter(
      [
        '---',
        'tags: [a, "b c", \'d\']',
        'aliases:',
        '  - One',
        '  - "Two: x"',
        'status: active # comment',
        'n: 3',
        'f: -1.5',
        'ok: true',
        'empty:',
        'due: 2026-11-07',
        '"quoted key": v',
        'url: https://example.com/a#b',
        'nested:',
        '  a: 1',
        'text: |',
        '  multi',
        '---',
        'Body',
      ].join('\n'),
    )
    assert.equal(fm.present, true)
    assert.deepEqual(fm.data.get('tags'), ['a', 'b c', 'd'])
    assert.deepEqual(fm.data.get('aliases'), ['One', 'Two: x'])
    assert.equal(fm.data.get('status'), 'active')
    assert.equal(fm.data.get('n'), 3)
    assert.equal(fm.data.get('f'), -1.5)
    assert.equal(fm.data.get('ok'), true)
    assert.equal(fm.data.get('empty'), null)
    assert.equal(fm.data.get('due'), '2026-11-07')
    assert.equal(fm.data.get('quoted key'), 'v')
    assert.equal(fm.data.get('url'), 'https://example.com/a#b')
    assert.deepEqual(fm.dropped.sort(), ['nested', 'text'])
    assert.equal(fm.body, 'Body')
  })

  it('treats a file without a closed block as plain body', () => {
    assert.equal(parseFrontmatter('---\nno end').present, false)
    assert.equal(parseFrontmatter('text\n---\na: 1\n---').present, false)
  })

  it('round-trips properties through render → parse → meta', () => {
    const props = [
      { id: 'p1', name: 'status', type: 'select', value: 'active' },
      { id: 'p2', name: 'priority', type: 'number', value: 3 },
      { id: 'p3', name: 'done', type: 'checkbox', value: false },
      { id: 'p4', name: 'due', type: 'date', value: '2026-11-01' },
      { id: 'p5', name: 'tags', type: 'tags', value: ['x', 'y'] },
      { id: 'p6', name: 'note', type: 'text', value: '123' },
      { id: 'p7', name: 'weird: name', type: 'text', value: 'true' },
      { id: 'fullWidth', name: 'Full width', type: 'checkbox', value: true },
    ]
    const md = renderFrontmatter('00000000-0000-4000-8000-000000000001', props, ['Alias'])
    assert.ok(!md.includes('Full width'))
    const meta = frontmatterToMeta(parseFrontmatter(`${md}\nbody`), props, [])
    assert.deepEqual(meta.aliases, ['Alias'])
    const byName = new Map(meta.properties.map((p) => [p.name, p]))
    assert.equal(byName.get('status')?.type, 'select')
    assert.equal(byName.get('status')?.id, 'p1')
    assert.equal(byName.get('priority')?.value, 3)
    assert.equal(byName.get('done')?.value, false)
    assert.equal(byName.get('due')?.value, '2026-11-01')
    assert.deepEqual(byName.get('tags')?.value, ['x', 'y'])
    assert.equal(byName.get('note')?.value, '123') // stays text, not a number
    assert.equal(byName.get('weird: name')?.value, 'true') // stays text, not a boolean
    assert.ok(meta.properties.some((p) => p.id === 'fullWidth'), 'internal property kept')
  })

  it('maps date/done onto the ids used by the calendar and due views', () => {
    const meta = frontmatterToMeta(parseFrontmatter('---\ndate: 2026-11-07\ndone: true\n---\n'), [], [])
    assert.deepEqual(
      meta.properties.map((p) => [p.id, p.type]),
      [
        ['date', 'date'],
        ['done', 'checkbox'],
      ],
    )
  })

  it('keeps properties untouched when the note has no frontmatter', () => {
    const props = [{ id: 'p1', name: 'a', type: 'text', value: 'x' }]
    assert.deepEqual(frontmatterToMeta(parseFrontmatter('just text'), props, ['al']).properties, props)
  })

  it('removes properties deleted from the file and re-infers changed types', () => {
    const props = [
      { id: 'p1', name: 'a', type: 'number', value: 1 },
      { id: 'p2', name: 'b', type: 'text', value: 'x' },
    ]
    const meta = frontmatterToMeta(parseFrontmatter('---\na: not a number\n---\n'), props, [])
    assert.equal(meta.properties.length, 1)
    assert.equal(meta.properties[0].type, 'text')
  })

  it('parses pathological lines in linear time', () => {
    const t0 = performance.now()
    parseFrontmatter(`---\n${' '.repeat(200_000)}x\n${'a'.repeat(200_000)}\n---\n`)
    normalizeMarkdown(`a${' \n'.repeat(200_000)}b`)
    assert.ok(performance.now() - t0 < 500)
  })
})

describe('revision tokens', () => {
  it('state vector part matches between live doc and stored state, and changes on edit', () => {
    const doc = new Y.Doc()
    doc.getText('t').insert(0, 'hello')
    const meta = metaHash([], [])
    const live = revisionFromDoc(doc, meta)
    assert.equal(revisionFromState(Y.encodeStateAsUpdate(doc), meta), live)
    doc.getText('t').insert(5, '!')
    assert.notEqual(revisionFromDoc(doc, meta), live)
    assert.equal(revisionFromState(null, meta), revisionFromDoc(new Y.Doc(), meta))
  })

  it('a pure deletion changes the revision, the same way from the live doc and the stored state (docs/adr/1920-*)', () => {
    const doc = new Y.Doc()
    const t = doc.getText('t')
    t.insert(0, 'hello world, more text')
    const meta = metaHash([], [])
    const before = revisionFromDoc(doc, meta)
    t.delete(5, 6)
    const after = revisionFromDoc(doc, meta)
    assert.notEqual(after, before)
    assert.equal(revisionSvPart(after), revisionSvPart(before), 'the state vector did not move')
    assert.equal(revisionFromState(Y.encodeStateAsUpdate(doc), meta), after)
    assert.equal(revisionFromState(Y.encodeStateAsUpdateV2(doc), meta), after)
    // two separate deletions that touch, written as one range after a reload, hash the same
    t.delete(0, 2)
    t.delete(0, 1)
    const reloaded = new Y.Doc()
    Y.applyUpdate(reloaded, Y.encodeStateAsUpdate(doc))
    assert.equal(revisionFromDoc(reloaded, meta), revisionFromDoc(doc, meta))
  })

  it('pre-0.15.1 tokens are told apart and never equal a current one', () => {
    const doc = new Y.Doc()
    doc.getText('t').insert(0, 'x')
    const rev = revisionFromDoc(doc, 'abc')
    assert.match(rev, /^[0-9a-f]{20}-[0-9a-f]{12}\.abc$/)
    assert.equal(isLegacyRevision(rev), false)
    const legacy = `${revisionSvPart(rev)}.abc`
    assert.equal(isLegacyRevision(legacy), true)
    assert.equal(revisionSvPart(legacy), revisionSvPart(rev))
    assert.notEqual(legacy, rev)
  })

  it('metadata part reacts to properties, aliases and link-target titles', () => {
    const base = metaHash([{ a: 1 }], ['x'], 'id:Title')
    assert.notEqual(metaHash([{ a: 2 }], ['x'], 'id:Title'), base)
    assert.notEqual(metaHash([{ a: 1 }], ['y'], 'id:Title'), base)
    assert.notEqual(metaHash([{ a: 1 }], ['x'], 'id:Renamed'), base)
  })

  it('content hash ignores line endings and trailing whitespace only', () => {
    assert.equal(contentHashOf('a\r\nb\n\n'), contentHashOf('a\nb'))
    assert.notEqual(contentHashOf('a\nb'), contentHashOf('a\n b'))
  })
})
