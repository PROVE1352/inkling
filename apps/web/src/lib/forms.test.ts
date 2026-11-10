// @ts-nocheck — Node test file (node:test types are not part of the web tsconfig); not bundled.
// Form views on the web (docs/adr/1820-*) and formula cells (docs/adr/1825-*): the logic the
// components call, without React.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { defaultFormSettings } from '@inkling/shared'
import { addableQuestions, formProblems, memberQuestions, moveQuestion, publicFormModel, publicQuestions } from './forms'
import { formulaErrorOf, formulaText, withFormulas } from './formulas'
import { applyView, formatValue } from './collection'

const fields = [
  { id: 'st', name: 'Status', type: 'select', options: [{ id: 'o1', name: 'New', color: 'gray' }, { id: 'o2', name: 'Done', color: 'green' }] },
  { id: 'n', name: 'Score', type: 'number' },
  { id: 'who', name: 'Owner', type: 'person' },
  { id: 'rel', name: 'Link', type: 'relation', relation: { targetPageId: '00000000-0000-4000-8000-000000000000' } },
  { id: 'ok', name: 'Agree', type: 'checkbox' },
  { id: 'f', name: 'Double', type: 'formula', formula: { expression: 'prop("Score") * 2' } },
]

describe('form questions', () => {
  const settings = {
    fields: [
      { fieldId: 'title', required: true },
      { fieldId: 'n', description: '0 to 10' },
      { fieldId: 'who' },
      { fieldId: 'rel' },
      { fieldId: 'f' },
      { fieldId: 'gone' },
      { fieldId: 'n' },
    ],
  }
  it('members get title, number and person; relation, formula, unknown and repeats are left out', () => {
    const qs = memberQuestions(settings, fields, 'Name')
    assert.deepEqual(qs.map((q) => q.key), ['title', 'n', 'who'])
    assert.equal(qs[0].name, 'Name')
    assert.equal(qs[1].description, '0 to 10')
  })
  it('the default asks for the title and the first public-friendly properties', () => {
    const d = defaultFormSettings(fields)
    assert.deepEqual(d.fields.map((q) => q.fieldId), ['title', 'st', 'n', 'ok'])
  })
  it('checks required and invalid answers the way the server does', () => {
    assert.deepEqual(formProblems(settings, fields, {}, false), { title: 'required' })
    assert.deepEqual(formProblems(settings, fields, { title: 'x', n: 'abc' }, false), { n: 'invalid' })
    assert.deepEqual(formProblems(settings, fields, { title: 'x', n: '7', who: 'not-a-uuid' }, false), { who: 'invalid' })
    assert.deepEqual(formProblems(settings, fields, { title: 'x', n: 7 }, false), {})
  })
  it('a public form rebuilt from its DTO validates the same answers', () => {
    const dto = {
      title: 'Signup', description: '', submitLabel: null, successMessage: null, honeypot: 'website',
      fields: [
        { key: 'title', name: 'Title', type: 'title', required: true, description: '' },
        { key: 'st', name: 'Status', type: 'select', required: true, description: '', options: fields[0].options },
        { key: 'ok', name: 'Agree', type: 'checkbox', required: true, description: '' },
      ],
    }
    const m = publicFormModel(dto)
    assert.deepEqual(publicQuestions(dto).map((q) => q.key), ['title', 'st', 'ok'])
    assert.deepEqual(formProblems(m.settings, m.fields, { title: 'a', st: 'Nope' }, true), { st: 'invalid', ok: 'required' })
    assert.deepEqual(formProblems(m.settings, m.fields, { title: 'a', st: 'done', ok: true }, true), {})
  })
  it('the editor offers what is not asked yet and moves questions', () => {
    const s = { fields: [{ fieldId: 'n' }, { fieldId: 'st' }] }
    assert.deepEqual(addableQuestions(s, fields, (t) => ['select', 'number', 'checkbox', 'person'].includes(t)), ['title', 'who', 'ok'])
    assert.deepEqual(moveQuestion(s, 1, -1).fields.map((q) => q.fieldId), ['st', 'n'])
    assert.equal(moveQuestion(s, 0, -1), s)
  })
})

describe('formula cells on the web', () => {
  const rows = [
    { id: 'a', title: 'A', props: { n: 3 } },
    { id: 'b', title: 'B', props: { n: 1 } },
    { id: 'c', title: 'C', props: {} },
  ]
  it('recomputes after an edit, sorts and filters by the computed value', () => {
    const out = withFormulas(rows, fields, new Date('2026-11-10T00:00:00Z'))
    assert.deepEqual(out.map((r) => r.props.f), [6, 2, null])
    const sorted = applyView(out, fields, { sorts: [{ fieldId: 'f', dir: 'desc' }] })
    assert.deepEqual(sorted.map((r) => r.id), ['a', 'b', 'c'])
    const kept = applyView(out, fields, { filters: [{ fieldId: 'f', op: 'gt', value: 3 }] })
    assert.deepEqual(kept.map((r) => r.id), ['a'])
    assert.equal(formatValue(fields[5], 6), '6')
  })
  it('an error is a marker the cell shows and filters read as empty', () => {
    const bad = [...fields.slice(0, 5), { id: 'f', name: 'Double', type: 'formula', formula: { expression: '10 / prop("Score")' } }]
    const out = withFormulas([{ id: 'z', title: '', props: { n: 0 } }], bad)
    assert.equal(formulaErrorOf(out[0].props.f), 'divZero')
    assert.equal(formulaText(out[0].props.f), '')
    assert.equal(applyView(out, bad, { filters: [{ fieldId: 'f', op: 'empty' }] }).length, 1)
  })
  it('rows are returned as they are when the collection has no formula', () => {
    const plain = fields.slice(0, 5)
    assert.equal(withFormulas(rows, plain), rows)
  })
})
