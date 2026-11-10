// Formula engine (packages/shared/src/formula.ts, docs/adr/1823-1825): parsing, evaluation, caps,
// cycles and renames. Pure: no database. The web runs the same functions, so these are the answers
// both sides give.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  applyFormulas,
  compileFormulas,
  evaluateRowFormulas,
  FORMULA_LIMITS,
  FormulaError,
  formulaResultType,
  parseFormula,
  renameFormulaProps,
} from '@inkling/shared'
import type { CollectionField, FormulaValue } from '@inkling/shared'

const NOW = new Date('2026-11-10T09:30:00Z')

const base: CollectionField[] = [
  { id: 'price', name: 'Price', type: 'number' },
  { id: 'qty', name: 'Qty', type: 'number' },
  { id: 'done', name: 'Done', type: 'checkbox' },
  { id: 'due', name: 'Due', type: 'date' },
  { id: 'note', name: 'Note', type: 'text' },
  {
    id: 'status',
    name: 'Status',
    type: 'select',
    options: [
      { id: 'o1', name: 'Todo', color: 'gray' },
      { id: 'o2', name: 'Done', color: 'green' },
    ],
  },
  { id: 'who', name: 'Owner', type: 'person' },
  { id: 'cnt', name: 'Links', type: 'rollup', rollup: { relationFieldId: 'rel', targetFieldId: 'title', fn: 'count' } },
]

const props = { price: 12.5, qty: 4, done: false, due: '2026-11-20', note: 'hello 세계', status: 'o2', who: '00000000-0000-4000-8000-000000000001', cnt: 3 }

function run(expr: string, rowProps: Record<string, unknown> = props, title = 'Row one'): { v: FormulaValue; e?: string } {
  const fields: CollectionField[] = [...base, { id: 'f', name: 'F', type: 'formula', formula: { expression: expr } }]
  const r = evaluateRowFormulas(compileFormulas(fields), { title, props: { ...rowProps } }, { now: NOW })
  return { v: r.values.f, ...(r.errors.f ? { e: r.errors.f } : {}) }
}
const val = (expr: string, p?: Record<string, unknown>) => {
  const r = run(expr, p)
  assert.equal(r.e, undefined, `${expr} → error ${r.e}`)
  return r.v
}
const err = (expr: string, p?: Record<string, unknown>) => run(expr, p).e

describe('formula: arithmetic and precedence', () => {
  it('follows the usual precedence and parentheses', () => {
    assert.equal(val('1 + 2 * 3'), 7)
    assert.equal(val('(1 + 2) * 3'), 9)
    assert.equal(val('-2 * -3'), 6)
    assert.equal(val('10 % 4'), 2)
    assert.equal(val('7 / 2'), 3.5)
    assert.equal(val('prop("Price") * prop("Qty")'), 50)
    assert.equal(val('1 + 2 > 2 and 3 < 4'), true)
  })
  it('divides by zero into an error, never Infinity', () => {
    assert.equal(err('1 / 0'), 'divZero')
    assert.equal(err('prop("Qty") % 0'), 'divZero')
  })
  it('+ with text concatenates; numbers print without float noise', () => {
    assert.equal(val('"a" + 1'), 'a1')
    assert.equal(val('0.1 + 0.2'), 0.30000000000000004)
    assert.equal(val('concat(0.1 + 0.2)'), '0.3')
  })
  it('empty numbers act as 0 in + and -, as empty in * and /', () => {
    assert.equal(val('prop("Price") + 1', {}), 1)
    assert.equal(val('prop("Price") * 2', {}), null)
  })
})

describe('formula: comparisons and logic', () => {
  it('compares numbers, text and dates; = and == are the same', () => {
    assert.equal(val('prop("Status") = "Done"'), true)
    assert.equal(val('prop("Status") == "Todo"'), false)
    assert.equal(val('prop("Note") != "x"'), true)
    assert.equal(val('prop("Due") > "2026-11-01"'), true)
    assert.equal(val('prop("Due") <= now()'), false)
    assert.equal(val('"b" > "a"'), true)
  })
  it('and / or / not as words, symbols and functions; short-circuit', () => {
    assert.equal(val('true and not false'), true)
    assert.equal(val('false || true && false'), false)
    assert.equal(val('and(true, 1, "x")'), true)
    assert.equal(val('or(false, 0, "")'), false)
    assert.equal(val('not(prop("Done"))'), true)
    assert.equal(val('!prop("Done")'), true)
    assert.equal(val('prop("Done") and (1 / 0 > 1)'), false)
    assert.equal(val('true or (1 / 0 > 1)'), true)
    assert.equal(val('prop("Price") > 1 and (prop("Qty") > 10 or prop("Qty") < 5)'), true)
  })
  it('if picks a branch and evaluates only that one', () => {
    assert.equal(val('if(prop("Done"), "yes", "no")'), 'no')
    assert.equal(val('if(prop("Qty") > 3, 1 / 1, 1 / 0)'), 1)
  })
  it('refuses a chained comparison', () => {
    assert.throws(() => parseFormula('1 < 2 < 3'), FormulaError)
  })
})

describe('formula: functions', () => {
  it('concat, length (code points), round, min, max, abs', () => {
    assert.equal(val('concat(prop("Note"), "!", 3, true)'), 'hello 세계!3true')
    assert.equal(val('length(prop("Note"))'), 8)
    assert.equal(val('length("")'), 0)
    assert.equal(val('round(2.345, 2)'), 2.35)
    assert.equal(val('round(prop("Price"))'), 13)
    assert.equal(val('min(3, prop("Qty"), 9)'), 3)
    assert.equal(val('max(3, prop("Qty"), 9)'), 9)
    assert.equal(val('max(prop("Price"))', {}), null)
    assert.equal(val('abs(-4.5)'), 4.5)
  })
  it('dates: now, dateAdd (month end clamps), dateBetween (truncates)', () => {
    assert.equal(val('now()'), '2026-11-10T09:30Z')
    assert.equal(val('dateAdd(prop("Due"), 3, "days")'), '2026-11-23')
    assert.equal(val('dateAdd("2026-01-31", 1, "month")'), '2026-02-28')
    assert.equal(val('dateAdd("2024-02-29", 1, "years")'), '2025-02-28')
    assert.equal(val('dateAdd(prop("Due"), -2, "weeks")'), '2026-11-06')
    assert.equal(val('dateAdd("2026-11-10", 90, "minutes")'), '2026-11-10T01:30Z')
    assert.equal(val('dateBetween(prop("Due"), "2026-11-10", "days")'), 10)
    assert.equal(val('dateBetween("2026-11-10", prop("Due"), "days")'), -10)
    assert.equal(val('dateBetween("2026-03-30", "2026-01-31", "months")'), 1)
    assert.equal(val('dateBetween("2027-11-09", "2026-11-10", "years")'), 0)
    assert.equal(val('dateBetween(prop("Due"), now(), "hours")'), 230)
    assert.equal(val('dateAdd(prop("Due"), 1, "days")', {}), null)
  })
  it('bad dates and units are errors', () => {
    assert.equal(err('dateAdd("tomorrow", 1, "days")'), 'badDate')
    assert.equal(err('dateAdd(prop("Due"), 1, "fortnights")'), 'badUnit')
    assert.equal(err('prop("Due") + 1'), 'type')
  })
  it('wrong arity and unknown functions fail at parse time', () => {
    assert.throws(() => parseFormula('if(true, 1)'), (e: FormulaError) => e.code === 'args')
    assert.throws(() => parseFormula('abs()'), (e: FormulaError) => e.code === 'args')
    assert.throws(() => parseFormula('eval("1")'), (e: FormulaError) => e.code === 'unknownFunction')
    assert.throws(() => parseFormula('prop(1)'), (e: FormulaError) => e.code === 'args')
    assert.throws(() => parseFormula('constructor'), (e: FormulaError) => e.code === 'syntax')
  })
})

describe('formula: properties', () => {
  it('reads select names, multiSelect names, checkbox false when unset, rollups, the title', () => {
    assert.equal(val('prop("Status")'), 'Done')
    assert.equal(val('prop("Done")', {}), false)
    assert.equal(val('prop("Links") * 2'), 6)
    assert.equal(val('prop("Title")'), 'Row one')
    assert.equal(val('prop("price")'), 12.5, 'case-insensitive fallback')
  })
  it('does not read person or relation cells (ids)', () => {
    assert.equal(val('prop("Owner")'), null)
    assert.equal(val('length(prop("Owner"))'), 0)
  })
  it('an unknown property is an error in the cell', () => {
    assert.equal(err('prop("Nope") + 1'), 'unknownProp')
  })
  it('formulas read other formulas (in dependency order) and errors spread', () => {
    const fields: CollectionField[] = [
      ...base,
      { id: 'b', name: 'B', type: 'formula', formula: { expression: 'prop("A") * 2' } },
      { id: 'a', name: 'A', type: 'formula', formula: { expression: 'prop("Qty") + 1' } },
      { id: 'c', name: 'C', type: 'formula', formula: { expression: 'prop("Bad") + 1' } },
      { id: 'bad', name: 'Bad', type: 'formula', formula: { expression: '1 / 0' } },
    ]
    const r = evaluateRowFormulas(compileFormulas(fields), { title: '', props: { ...props } }, { now: NOW })
    assert.equal(r.values.a, 5)
    assert.equal(r.values.b, 10)
    assert.equal(r.errors.bad, 'divZero')
    assert.equal(r.errors.c, 'divZero')
  })
  it('cycles are found, whatever their length, and only their members fail', () => {
    const fields: CollectionField[] = [
      ...base,
      { id: 'x', name: 'X', type: 'formula', formula: { expression: 'prop("Y") + 1' } },
      { id: 'y', name: 'Y', type: 'formula', formula: { expression: 'prop("Z") + 1' } },
      { id: 'z', name: 'Z', type: 'formula', formula: { expression: 'prop("X") + 1' } },
      { id: 'self', name: 'Self', type: 'formula', formula: { expression: 'prop("Self")' } },
      { id: 'ok', name: 'Ok', type: 'formula', formula: { expression: 'prop("Qty")' } },
    ]
    const c = compileFormulas(fields)
    for (const id of ['x', 'y', 'z', 'self']) assert.equal(c.byId.get(id)?.error?.code, 'cycle', id)
    assert.equal(c.byId.get('ok')?.error, null)
    const r = evaluateRowFormulas(c, { title: '', props }, { now: NOW })
    assert.equal(r.values.ok, 4)
    assert.equal(r.errors.x, 'cycle')
  })
})

describe('formula: caps', () => {
  it('limits the expression length, the parts and the nesting', () => {
    assert.throws(() => parseFormula('1+'.repeat(FORMULA_LIMITS.expression)), (e: FormulaError) => e.code === 'tooLong')
    assert.throws(() => parseFormula(Array.from({ length: 200 }, () => '1').join('+')), (e: FormulaError) => e.code === 'tooComplex')
    assert.throws(() => parseFormula(`${'('.repeat(60)}1${')'.repeat(60)}`), (e: FormulaError) => e.code === 'tooComplex')
    assert.throws(() => parseFormula(`${'-'.repeat(60)}1`), (e: FormulaError) => e.code === 'tooComplex')
  })
  it('limits the length of text it builds', () => {
    // 2^14 characters through formulas doubling each other
    const fields: CollectionField[] = [{ id: 's0', name: 'S0', type: 'formula', formula: { expression: '"xxxxxxxxxxxxxxxx"' } }]
    for (let i = 1; i <= 12; i++) fields.push({ id: `s${i}`, name: `S${i}`, type: 'formula', formula: { expression: `concat(prop("S${i - 1}"), prop("S${i - 1}"))` } })
    const r = evaluateRowFormulas(compileFormulas(fields), { title: '', props: {} }, { now: NOW })
    assert.equal(r.values.s9, 'x'.repeat(16 * 512))
    assert.equal(r.errors.s10, 'tooLong')
    assert.equal(r.errors.s12, 'tooLong')
  })
})

describe('formula: types, renames, applyFormulas', () => {
  it('infers what a formula yields', () => {
    const fields: CollectionField[] = [
      ...base,
      { id: 'n', name: 'N', type: 'formula', formula: { expression: 'prop("Price") * 2' } },
      { id: 't', name: 'T', type: 'formula', formula: { expression: 'concat("a", 1)' } },
      { id: 'b', name: 'B', type: 'formula', formula: { expression: 'prop("N") > 3' } },
      { id: 'd', name: 'D', type: 'formula', formula: { expression: 'dateAdd(prop("Due"), 1, "days")' } },
      { id: 'i', name: 'I', type: 'formula', formula: { expression: 'if(prop("Done"), prop("N"), 0)' } },
      { id: 'm', name: 'M', type: 'formula', formula: { expression: 'if(prop("Done"), prop("N"), "none")' } },
    ]
    assert.deepEqual(
      ['n', 't', 'b', 'd', 'i', 'm'].map((id) => formulaResultType(fields, id)),
      ['number', 'text', 'boolean', 'date', 'number', 'text'],
    )
  })
  it('renames prop() names by field id and keeps the rest of the text', () => {
    const oldF = [{ id: 'a', name: 'Price' }, { id: 'b', name: 'Qty' }]
    const newF = [{ id: 'a', name: 'Unit price' }, { id: 'b', name: 'Qty' }]
    assert.equal(renameFormulaProps('prop("Price")*prop( "Qty" ) + "Price"', oldF, newF), 'prop("Unit price")*prop( "Qty" ) + "Price"')
    assert.equal(renameFormulaProps('prop("Gone")', oldF, newF), 'prop("Gone")')
    assert.equal(renameFormulaProps('prop("a\\"b")', [{ id: 'q', name: 'a"b' }], [{ id: 'q', name: 'c"d' }]), 'prop("c\\"d")')
  })
  it('applyFormulas writes values into props and reports errors per row', () => {
    const fields: CollectionField[] = [...base, { id: 'f', name: 'F', type: 'formula', formula: { expression: '10 / prop("Qty")' } }]
    const rows = [
      { id: 'r1', title: 'a', props: { qty: 4, f: 'stale stored value' } as Record<string, unknown> },
      { id: 'r2', title: 'b', props: { qty: 0 } as Record<string, unknown> },
    ]
    const errs = applyFormulas(fields, rows, { now: NOW })
    assert.equal(rows[0].props.f, 2.5)
    assert.equal(rows[1].props.f, null)
    assert.deepEqual(errs.get('r2'), { f: 'divZero' })
    assert.equal(errs.has('r1'), false)
  })
  it('accepts curly quotes and single quotes as strings', () => {
    assert.equal(val("prop('Qty') + 1"), 5)
    assert.equal(val('prop(“Qty”) + 1'), 5)
  })
})
