// Formula fields against a real database (docs/adr/1823-1827): saving (parse, cycles, renames),
// reading (GET /collection, query_rows display), writing (ignored), query_rows filters / sorts /
// cursors on formulas, formulas over rollups, chart aggregates by and of a formula, MCP.
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.APP_SECRET_KEY ||= 'test-app-secret-key-0123456789-abcdefghij'

import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'
import type { ChartDataDTO, CollectionField, RowDTO } from '@inkling/shared'

const HAS_DB = !!process.env.DATABASE_URL

describe('[db] formula fields', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const h = await import('../mcpTools/testHarness')
  const { closeDb, db } = await import('../db/index')
  const schema = await import('../db/schema')
  const { eq } = await import('drizzle-orm')
  const app = await h.buildTestApp()
  const alice = await h.makeUser('alice')
  const bob = await h.makeUser('bob')
  const ws = await h.makeWorkspace(alice, [bob])
  const token = await h.mintToken(alice, 'notes', 'Calc Agent')
  const M = await h.connectMcp(app, alice, token, { user: { ...alice, via: 'Calc Agent' } })
  after(async () => {
    await M.close()
    await app.close()
    await closeDb()
  })

  const as = (u: { cookie: string }, method: string, url: string, payload?: unknown) =>
    app.inject({
      method: method as 'GET',
      url: `/api${url}`,
      headers: { cookie: u.cookie, ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) },
      payload: payload === undefined ? undefined : JSON.stringify(payload),
    })
  const mkColl = async (title: string) => {
    const r = await as(alice, 'POST', '/pages', { workspaceId: ws.id, kind: 'collection', title })
    assert.equal(r.statusCode, 200, r.body)
    return r.json().page.id as string
  }
  const putFields = (id: string, fields: CollectionField[]) => as(alice, 'PUT', `/pages/${id}/collection/fields`, { fields })

  const coll = await mkColl('Orders')
  const base: CollectionField[] = [
    { id: 'pr', name: 'Price', type: 'number' },
    { id: 'qt', name: 'Qty', type: 'number' },
    { id: 'st', name: 'Status', type: 'select', options: [{ id: 'a', name: 'Open', color: 'gray' }, { id: 'b', name: 'Paid', color: 'green' }] },
    { id: 'du', name: 'Due', type: 'date' },
  ]
  const formulas: CollectionField[] = [
    { id: 'tt', name: 'Total', type: 'formula', formula: { expression: 'prop("Price") * prop("Qty")' } },
    { id: 'sz', name: 'Size', type: 'formula', formula: { expression: 'if(prop("Total") >= 100, "big", "small")' } },
    { id: 'pd', name: 'Settled', type: 'formula', formula: { expression: 'prop("Status") = "Paid"' } },
    { id: 'nx', name: 'Next', type: 'formula', formula: { expression: 'dateAdd(prop("Due"), 7, "days")' } },
    { id: 'bad', name: 'Broken', type: 'formula', formula: { expression: '1 / (prop("Qty") - prop("Qty"))' } },
  ]
  const ids: Record<string, string> = {}
  const data: [string, Record<string, unknown>][] = [
    ['o1', { pr: 10, qt: 3, st: 'a', du: '2026-11-01' }], // 30 small open
    ['o2', { pr: 25, qt: 4, st: 'b', du: '2026-11-15' }], // 100 big paid
    ['o3', { pr: 7.5, qt: 2, st: 'b' }], // 15 small paid
    ['o4', { pr: 50, qt: 5, st: 'a', du: '2026-12-01' }], // 250 big open
    ['o5', { st: 'a' }], // empty total
  ]

  it('saves valid formulas and refuses broken, unknown and circular ones with the reason', async () => {
    const syntax = await putFields(coll, [...base, { id: 'x', name: 'X', type: 'formula', formula: { expression: 'prop("Price") *' } }])
    assert.equal(syntax.statusCode, 400)
    assert.match(syntax.json().error.message, /Formula "X"/)
    const unknown = await putFields(coll, [...base, { id: 'x', name: 'X', type: 'formula', formula: { expression: 'prop("Nope")' } }])
    assert.equal(unknown.statusCode, 400)
    assert.match(unknown.json().error.message, /No property "Nope"/)
    const cycle = await putFields(coll, [
      ...base,
      { id: 'x', name: 'X', type: 'formula', formula: { expression: 'prop("Y") + 1' } },
      { id: 'y', name: 'Y', type: 'formula', formula: { expression: 'prop("X") + 1' } },
    ])
    assert.equal(cycle.statusCode, 400)
    assert.match(cycle.json().error.message, /refers to itself/)
    const evalFn = await putFields(coll, [...base, { id: 'x', name: 'X', type: 'formula', formula: { expression: 'eval("1")' } }])
    assert.equal(evalFn.statusCode, 400)
    const empty = await putFields(coll, [...base, { id: 'x', name: 'X', type: 'formula' }])
    assert.equal(empty.statusCode, 400)
    const ok = await putFields(coll, [...base, ...formulas])
    assert.equal(ok.statusCode, 200, ok.body)
    for (const [title, props] of data) {
      const r = await as(alice, 'POST', `/pages/${coll}/collection/rows`, { template: null, title, props })
      assert.equal(r.statusCode, 200, r.body)
      ids[title] = r.json().row.id
    }
  })

  it('GET /collection computes every formula per row; errors are null and never stored', async () => {
    const res = await as(bob, 'GET', `/pages/${coll}/collection`)
    const rows = res.json().rows as RowDTO[]
    const by = (t: string) => rows.find((r) => r.title === t)!.props
    assert.equal(by('o1').tt, 30)
    assert.equal(by('o2').sz, 'big')
    assert.equal(by('o3').pd, true)
    assert.equal(by('o1').nx, '2026-11-08')
    assert.equal(by('o3').nx, null)
    assert.equal(by('o5').tt, null)
    assert.equal(by('o1').bad, null)
    const stored = await db.select({ props: schema.pages.props }).from(schema.pages).where(eq(schema.pages.id, ids.o1))
    assert.equal('tt' in (stored[0].props as object), false)
  })

  it('a formula cell cannot be written (PATCH props, update_row)', async () => {
    const r = await as(alice, 'PATCH', `/pages/${ids.o1}/props`, { props: { tt: 999, qt: 4 } })
    assert.equal(r.statusCode, 200, r.body)
    assert.equal(r.json().row.props.tt, 40, 'the response computes it from the new Qty')
    const [st] = await db.select({ props: schema.pages.props }).from(schema.pages).where(eq(schema.pages.id, ids.o1))
    assert.equal((st.props as Record<string, unknown>).tt, undefined)
    const version = (await as(alice, 'GET', `/pages/${ids.o1}/row`)).json().row.version as string
    const u = await M.tool('update_row', { rowId: ids.o1, baseVersion: version, properties: { Total: 5 } })
    assert.equal(u.isError, true)
    assert.match(u.text, /formula \(computed, read-only\)/)
    await as(alice, 'PATCH', `/pages/${ids.o1}/props`, { props: { qt: 3 } })
  })

  it('query_rows shows, filters and sorts by formulas (with a cursor across pages)', async () => {
    const q = async (params: Record<string, string>) => {
      const res = await as(bob, 'GET', `/pages/${coll}/collection/query?${new URLSearchParams(params)}`)
      assert.equal(res.statusCode, 200, res.body)
      return res.json() as { columns: string[]; rows: { id: string; cells: string[] }[]; nextCursor: string | null; fields: { name: string; formula?: { result: string } }[] }
    }
    const shown = await q({ fields: 'Total,Size,Settled,Next,Broken', sort: 'Total desc' })
    assert.deepEqual(shown.columns, ['Title', 'Total', 'Size', 'Settled', 'Next', 'Broken'])
    assert.deepEqual(shown.rows.map((r) => r.cells[0]), ['o4', 'o2', 'o1', 'o3', 'o5'], 'empty totals last')
    assert.deepEqual(shown.rows[0].cells, ['o4', '250', 'big', 'false', '2026-12-08', '#error(divZero)'])
    assert.deepEqual(shown.fields.find((f) => f.name === 'Total')?.formula?.result, 'number')

    const big = await q({ filter: 'Total >= 100 AND Status = Open', fields: 'Total' })
    assert.deepEqual(big.rows.map((r) => r.cells[0]), ['o4'])
    const text = await q({ filter: 'Size = BIG', sort: 'Title' })
    assert.deepEqual(text.rows.map((r) => r.cells[0]), ['o2', 'o4'])
    const bool = await q({ filter: 'Settled = true', sort: 'Title' })
    assert.deepEqual(bool.rows.map((r) => r.cells[0]), ['o2', 'o3'])
    const dates = await q({ filter: 'Next > 2026-11-20 OR Total is empty', sort: 'Title' })
    assert.deepEqual(dates.rows.map((r) => r.cells[0]), ['o2', 'o4', 'o5'])
    const not = await q({ filter: 'NOT Size ~ sma', sort: 'Total' })
    assert.deepEqual(not.rows.map((r) => r.cells[0]), ['o2', 'o4'])
    const wrongOp = await as(bob, 'GET', `/pages/${coll}/collection/query?filter=${encodeURIComponent('Total ~ 1')}`)
    assert.equal(wrongOp.statusCode, 400, wrongOp.body)
    assert.match(wrongOp.json().error.message, /not valid for number/)

    // keyset pages over a formula sort
    const p1 = await q({ sort: 'Total', limit: '2' })
    assert.deepEqual(p1.rows.map((r) => r.cells[0]), ['o3', 'o1'])
    assert.ok(p1.nextCursor)
    const p2 = await q({ sort: 'Total', limit: '2', cursor: p1.nextCursor! })
    assert.deepEqual(p2.rows.map((r) => r.cells[0]), ['o2', 'o4'])
    const p3 = await q({ sort: 'Total', limit: '2', cursor: p2.nextCursor! })
    assert.deepEqual(p3.rows.map((r) => r.cells[0]), ['o5'])
    assert.equal(p3.nextCursor, null)
  })

  it('MCP query_rows filters on a formula and describe lists it as read-only', async () => {
    const r = await M.tool('query_rows', { collectionId: coll, filter: 'Size = big', sort: 'Total desc', fields: ['Total'] })
    assert.equal(r.isError, false, r.text)
    assert.match(r.text, /o4[\s\S]*o2/)
    assert.doesNotMatch(r.text, /o1|o3|o5/)
    const d = await M.tool('query_rows', { collectionId: coll, describe: true })
    assert.match(d.text, /Total \(formula → number, read-only\)/)
  })

  it('renaming a property rewrites the formulas that read it', async () => {
    const cur = (await as(alice, 'GET', `/pages/${coll}/collection?rows=0`)).json().collection.fields as CollectionField[]
    const renamed = cur.map((f) => (f.id === 'pr' ? { ...f, name: 'Unit price' } : f))
    const r = await putFields(coll, renamed)
    assert.equal(r.statusCode, 200, r.body)
    const tt = (r.json().collection.fields as CollectionField[]).find((f) => f.id === 'tt')!
    assert.equal(tt.formula?.expression, 'prop("Unit price") * prop("Qty")')
    // deleting a property a formula reads is allowed; the cell shows the error
    const without = (r.json().collection.fields as CollectionField[]).filter((f) => f.id !== 'du')
    const del = await putFields(coll, without)
    assert.equal(del.statusCode, 200, del.body)
    const q = await as(bob, 'GET', `/pages/${coll}/collection/query?fields=Next`)
    assert.equal(q.json().rows[0].cells[1], '#error(unknownProp)')
  })

  it('charts group by and sum a formula (the view filter on a formula too)', async () => {
    const src = { type: 'collection', collectionId: coll }
    const res = await as(bob, 'POST', `/workspaces/${ws.id}/charts/aggregate`, { source: src, groupBy: { field: 'sz' }, measure: { fn: 'sum', field: 'tt' } })
    assert.equal(res.statusCode, 200, res.body)
    const d = res.json() as ChartDataDTO
    const at = (label: string) => d.values[d.groups.findIndex((g) => g.label === label)]
    assert.equal(at('big'), 350)
    assert.equal(at('small'), 45)
    const v = await as(alice, 'POST', `/pages/${coll}/collection/views`, {
      name: 'Big only',
      type: 'chart',
      config: { filters: [{ fieldId: 'tt', op: 'gt', value: 99 }], chart: { kind: 'bar', groupBy: { field: 'st' } } },
    })
    assert.equal(v.statusCode, 200, v.body)
    const viewId = v.json().view.id
    const f = await as(bob, 'POST', `/workspaces/${ws.id}/charts/aggregate`, { source: { ...src, viewId }, groupBy: { field: 'st' } })
    assert.equal(f.statusCode, 200, f.body)
    assert.equal((f.json() as ChartDataDTO).rowCount, 2)
    const notNumber = await as(bob, 'POST', `/workspaces/${ws.id}/charts/aggregate`, { source: src, groupBy: { field: 'st' }, measure: { fn: 'sum', field: 'sz' } })
    assert.equal(notNumber.statusCode, 400)
  })

  it('a formula reads a rollup; a rollup does not aggregate a formula', async () => {
    const items = await mkColl('Items')
    const r1 = await putFields(items, [{ id: 'w', name: 'Weight', type: 'number' }])
    assert.equal(r1.statusCode, 200, r1.body)
    const a = (await as(alice, 'POST', `/pages/${items}/collection/rows`, { template: null, title: 'i1', props: { w: 2 } })).json().row.id
    const b = (await as(alice, 'POST', `/pages/${items}/collection/rows`, { template: null, title: 'i2', props: { w: 5 } })).json().row.id
    const boxes = await mkColl('Boxes')
    const fs: CollectionField[] = [
      { id: 'rel', name: 'Items', type: 'relation', relation: { targetPageId: items } },
      { id: 'sum', name: 'Load', type: 'rollup', rollup: { relationFieldId: 'rel', targetFieldId: 'w', fn: 'sum' } },
      { id: 'over', name: 'Over', type: 'formula', formula: { expression: 'if(prop("Load") > 6, "over", "ok")' } },
    ]
    const r2 = await putFields(boxes, fs)
    assert.equal(r2.statusCode, 200, r2.body)
    const box = (await as(alice, 'POST', `/pages/${boxes}/collection/rows`, { template: null, title: 'b1', props: { rel: [a, b] } })).json().row.id
    const rows = (await as(alice, 'GET', `/pages/${boxes}/collection`)).json().rows as RowDTO[]
    assert.equal(rows.find((r) => r.id === box)?.props.over, 'over')
    const q = await as(alice, 'GET', `/pages/${boxes}/collection/query?${new URLSearchParams({ filter: 'Over = over', fields: 'Over' })}`)
    assert.equal(q.statusCode, 200, q.body)
    assert.equal(q.json().rows.length, 1)
    // rollup over another collection's formula: refused unless count
    await putFields(items, [{ id: 'w', name: 'Weight', type: 'number' }, { id: 'dw', name: 'Double', type: 'formula', formula: { expression: 'prop("Weight") * 2' } }])
    const r3 = await putFields(boxes, [...fs, { id: 's2', name: 'S2', type: 'rollup', rollup: { relationFieldId: 'rel', targetFieldId: 'dw', fn: 'sum' } }])
    assert.equal(r3.statusCode, 400, r3.body)
    assert.match(r3.json().error.message, /formula/)
  })

  it('MCP create_collection takes a formula with its expression', async () => {
    const r = await M.tool('create_collection', {
      workspaceId: ws.id,
      title: 'Calc',
      fields: [
        { name: 'A', type: 'number' },
        { name: 'B', type: 'formula', expression: 'prop("A") + 1' },
      ],
    })
    assert.equal(r.isError, false, r.text)
    assert.match(r.text, /B \(formula: prop\("A"\) \+ 1, read-only\)/)
    const bad = await M.tool('create_collection', { workspaceId: ws.id, title: 'Calc2', fields: [{ name: 'B', type: 'formula' }] })
    assert.equal(bad.isError, true)
  })
})
