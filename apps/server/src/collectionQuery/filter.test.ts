// Pure tests for the collection filter / sort language, cursor and value mapping (docs/adr/0934-*).
// Run: cd apps/server && node ../../scripts/run-tests.mjs --test-name-pattern=collection
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { CollectionField } from '@inkling/shared'
import { CursorError, decodeCursor, encodeCursor, querySignature } from './compile'
import { FilterError, parseFilter, parseSort, tokenize } from './filter'
import type { Cond, Expr } from './filter'
import { cleanCell, formatCell, formatNumber, mapWrite, ValueError } from './values'

const FIELDS: CollectionField[] = [
  {
    id: 'st',
    name: 'Status',
    type: 'select',
    options: [
      { id: 'o1', name: 'Todo', color: 'gray' },
      { id: 'o2', name: 'In progress', color: 'blue' },
      { id: 'o3', name: 'Done', color: 'green' },
    ],
  },
  { id: 'due', name: 'Due date', type: 'date' },
  {
    id: 'tg',
    name: 'Tags',
    type: 'multiSelect',
    options: [
      { id: 't1', name: 'urgent', color: 'red' },
      { id: 't2', name: 'later', color: 'gray' },
    ],
  },
  { id: 'pt', name: 'Points', type: 'number' },
  { id: 'dn', name: 'Done', type: 'checkbox' },
  { id: 'ow', name: 'Owner', type: 'person' },
  { id: 'nt', name: 'Notes', type: 'text' },
  { id: 'pr', name: 'Project', type: 'relation', relation: { targetPageId: '00000000-0000-4000-8000-000000000001' } },
  { id: 'rc', name: 'Project count', type: 'rollup', rollup: { relationFieldId: 'pr', targetFieldId: 'title', fn: 'count' } },
  { id: 'x1', name: 'Title', type: 'text' },
  { id: 'd1', name: 'Dup', type: 'text' },
  { id: 'd2', name: 'Dup', type: 'number' },
]
const ME = '11111111-1111-4111-8111-111111111111'
const ctx = { fields: FIELDS, userId: ME, today: '2026-11-07' }
const parse = (s: string) => parseFilter(s, ctx)
const cond = (e: Expr | null) => e as Cond
const err = (fn: () => unknown, re: RegExp) =>
  assert.throws(fn, (e: unknown) => e instanceof FilterError && re.test(e.message))

describe('collection filter parser', () => {
  it('tokenizes operators, quotes and words', () => {
    const t = tokenize(`Title ~ "a \\"b\\"" AND Points>=3 OR x!=y`)
    assert.deepEqual(
      t.map((x) => ('v' in x ? x.v : x.t)),
      ['Title', '~', 'a "b"', 'AND', 'Points', '>=', '3', 'OR', 'x', '!=', 'y'],
    )
  })

  it('resolves multi-word names and values without quotes, case-insensitively', () => {
    const c = cond(parse('due DATE < 2026-12-01'))
    assert.equal(c.field.name, 'Due date')
    assert.equal(c.op, '<')
    assert.deepEqual(c.value, { t: 'date', v: '2026-12-01' })
    const s = cond(parse('Status = in Progress'))
    assert.deepEqual(s.value, { t: 'option', v: 'o2' })
  })

  it('precedence: NOT > AND > OR, parentheses', () => {
    // shape as nested kinds: or(cond, and(cond, not(cond)))
    const shape = (e: Expr | null): unknown =>
      !e ? null : e.k === 'cond' ? 'cond' : e.k === 'not' ? ['not', shape(e.e)] : [e.k, ...e.items.map(shape)]
    assert.deepEqual(shape(parse('Status = Done OR Points > 3 AND NOT Done = true')), ['or', 'cond', ['and', 'cond', ['not', 'cond']]])
    assert.deepEqual(shape(parse('(Status = Done OR Points > 3) AND Done = true')), ['and', ['or', 'cond', 'cond'], 'cond'])
  })

  it('empty forms and word operators', () => {
    assert.equal(cond(parse('Due date is empty')).op, 'empty')
    assert.equal(cond(parse('Due date is not empty')).op, 'notEmpty')
    assert.equal(cond(parse('Notes not empty')).op, 'notEmpty')
    assert.equal(cond(parse('Notes contains deploy')).op, '~')
    assert.equal(cond(parse('Notes not contains deploy')).op, '!~')
    assert.equal(cond(parse('Status is Done')).op, '=')
    assert.equal(cond(parse('Status is not Done')).op, '!=')
  })

  it('aliases: = on multi-value fields means has; has on text means contains', () => {
    assert.equal(cond(parse('Tags = urgent')).op, 'has')
    assert.equal(cond(parse('Tags != urgent')).op, '!has')
    assert.equal(cond(parse('Tags !has later')).op, '!has')
    assert.equal(cond(parse('Project has Alpha')).op, 'has')
    assert.equal(cond(parse('Notes has x')).op, '~')
  })

  it('binds values per type', () => {
    assert.deepEqual(cond(parse('Points = -2.5')).value, { t: 'number', v: -2.5 })
    assert.deepEqual(cond(parse('Done = yes')).value, { t: 'bool', v: true })
    assert.deepEqual(cond(parse('Due date >= today+7')).value, { t: 'date', v: '2026-11-14' })
    assert.deepEqual(cond(parse('Due date < today-7')).value, { t: 'date', v: '2026-10-31' })
    assert.deepEqual(cond(parse('Owner = me')).value, { t: 'personId', v: ME })
    assert.deepEqual(cond(parse('Owner = "me"')).value, { t: 'personName', v: 'me' })
    assert.deepEqual(cond(parse('Owner = Kim Lee')).value, { t: 'personName', v: 'Kim Lee' })
    assert.deepEqual(cond(parse('Notes = "a AND b"')).value, { t: 'text', v: 'a AND b' })
  })

  it('Title is the row title; a user field named Title is reachable by #id; duplicates need #id', () => {
    assert.equal(cond(parse('Title ~ deploy')).field.kind, 'title')
    const t = cond(parse('#x1 = a')).field
    assert.equal(t.kind === 'field' && t.field.id, 'x1')
    err(() => parse('Dup = 1'), /ambiguous.*#d1, #d2/)
    assert.equal(cond(parse('#d2 > 1')).op, '>')
  })

  it('errors name the valid fields / operators / options', () => {
    err(() => parse('Stauts = Done'), /Unknown field "Stauts". Valid fields: Title, Status, Due date/)
    err(() => parse('Status < Done'), /not valid for select field "Status". Valid: =, !=, is empty, is not empty/)
    err(() => parse('Tags has nope'), /"nope" is not an option of "Tags". Options: urgent, later/)
    err(() => parse('Points > many'), /number field/)
    err(() => parse('Due date < tomorrow'), /YYYY-MM-DD or today/)
    err(() => parse('Due date = 2026-02-30'), /YYYY-MM-DD/)
    err(() => parse('Done = maybe'), /true or false/)
    err(() => parse('Project count > 1'), /rollup.*read-only/)
    err(() => parse('Status'), /Expected an operator/)
    err(() => parse('Status ='), /Expected a value/)
    err(() => parse('(Status = Done'), /Missing \)/)
    err(() => parse('Status = Done)'), /Unbalanced/)
    err(() => parse('Notes = "open'), /Unclosed/)
    err(() => parse('Status = Done Points = 3'), /not an option/)
    err(() => parse(Array.from({ length: 31 }, () => 'Points = 1').join(' AND ')), /Too many conditions/)
  })

  it('empty filter → null', () => {
    assert.equal(parse('   '), null)
  })
})

describe('collection sort parser', () => {
  it('directions, quoting, sortable types only', () => {
    const s = parseSort('Due date desc, "Title"', FIELDS)
    assert.deepEqual(
      s.map((k) => [k.field.name, k.dir]),
      [
        ['Due date', 'desc'],
        ['Title', 'asc'],
      ],
    )
    assert.throws(() => parseSort('Tags', FIELDS), /Cannot sort by multiSelect field "Tags". Sortable fields: Title, Status/)
    assert.throws(() => parseSort('a,b,c,d', FIELDS), /At most 3/)
    assert.deepEqual(parseSort('', FIELDS), [])
  })
})

describe('collection cursor', () => {
  const parts = [{ cast: 'int' as const }, { cast: 'text' as const }, { cast: 'float8' as const }, { cast: 'uuid' as const }]
  const sig = querySignature('c', 'Status = Done', '')
  it('round-trips and is bound to the filter/sort', () => {
    const c = encodeCursor(sig, ['0', 'a|b', '1e+20', ME])
    assert.deepEqual(decodeCursor(c, sig, parts), ['0', 'a|b', '1e+20', ME])
    assert.throws(() => decodeCursor(c, querySignature('c', 'Status = Todo', ''), parts), CursorError)
  })
  it('rejects forged values before they reach a SQL cast', () => {
    assert.throws(() => decodeCursor(encodeCursor(sig, ['x', 'a', '1', ME]), sig, parts), CursorError)
    assert.throws(() => decodeCursor(encodeCursor(sig, ['0', 'a', '1', 'not-a-uuid']), sig, parts), CursorError)
    assert.throws(() => decodeCursor(encodeCursor(sig, ['0', 'a']), sig, parts), CursorError)
    assert.throws(() => decodeCursor('%%%', sig, parts), CursorError)
  })
})

describe('collection values', () => {
  it('maps names to ids and validates strictly', () => {
    const m = mapWrite(
      FIELDS,
      {
        status: 'done',
        'Due date': 'today+1',
        Tags: 'urgent, later',
        Points: '4',
        Done: false,
        Owner: 'kim@x.y',
        Notes: null,
        Project: ['Alpha', ME],
        Title: ' New ',
      },
      { userId: ME, today: '2026-11-07', members: [{ id: ME, name: 'Kim', email: 'kim@x.y' }] },
    )
    assert.deepEqual(m.props, { st: 'o3', due: '2026-11-08', tg: ['t1', 't2'], pt: 4, dn: false, ow: ME, nt: null })
    assert.deepEqual(m.relations.map((r) => [r.field.id, r.refs]), [['pr', ['Alpha', ME]]])
    assert.equal(m.title, 'New')
  })
  it('collects every error with the valid choices', () => {
    assert.throws(
      () =>
        mapWrite(FIELDS, { Status: 'Nope', Points: 'x', 'Project count': 3, Owner: 'ghost', Bogus: 1 }, { userId: ME, today: '2026-11-07', members: [] }),
      (e: unknown) =>
        e instanceof ValueError &&
        /expects one of: Todo, In progress, Done/.test(e.message) &&
        /expects a number/.test(e.message) &&
        /rollup/.test(e.message) &&
        /workspace member/.test(e.message) &&
        /Unknown field "Bogus"/.test(e.message),
    )
  })
  it('formats cells on one line without breaking the column separator', () => {
    assert.equal(cleanCell('a | b\nc'), 'a \\| b c')
    assert.equal(cleanCell('x'.repeat(500)).length, 200)
    assert.equal(formatNumber(0.1 + 0.2), '0.3')
    assert.equal(formatNumber(1e21), '1e+21')
    const f = { kind: 'field' as const, name: 'Tags', field: FIELDS[2] }
    assert.equal(formatCell(f, '', { tg: ['t2', 't1', 'gone'] }, { refTitles: new Map(), personNames: new Map() }), 'later, urgent')
    const r = { kind: 'field' as const, name: 'Project', field: FIELDS[7] }
    assert.equal(
      formatCell(r, '', { pr: ['a', 'b', 'hidden'] }, { refTitles: new Map([['a', 'Alpha'], ['b', '']]), personNames: new Map() }),
      'Alpha, Untitled',
    )
  })
})
