// Collection agent tools end to end through the MCP server (docs/adr/0934-*): query_rows filter
// correctness per operator/type against an in-memory oracle, sort, keyset pagination stability,
// permissions, update_row version conflicts (no lost update), read-only tokens, create_row, and the
// token measurement against read_page.
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.DATA_DIR ||= `${process.env.TMPDIR || '/tmp'}/inkling-colq-${process.pid}`

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import type { CollectionField } from '@inkling/shared'

const HAS_DB = !!process.env.DATABASE_URL

describe('[db] collection agent tools', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const h = await import('../mcpTools/testHarness')
  const { db, closeDb } = await import('../db/index')
  const schema = await import('../db/schema')
  const { eq } = await import('drizzle-orm')
  const { estimateTokens } = await import('../context/tokens')
  const collab = await import('../collab')
  const app = await h.buildTestApp()

  after(async () => {
    await collab.destroyCollab()
    await app.close()
    await closeDb()
  })

  type User = Awaited<ReturnType<typeof h.makeUser>>
  type Mcp = Awaited<ReturnType<typeof h.connectMcp>>
  let A: User
  let B: User
  let C: User
  let ws: { id: string }
  let mcpA: Mcp
  let mcpB: Mcp
  let mcpC: Mcp
  let tasksId: string
  let projectsId: string
  const P: Record<'alpha' | 'beta' | 'secret', string> = { alpha: '', beta: '', secret: '' }

  interface Model {
    id: string
    title: string
    sort: number
    status?: 'Todo' | 'Doing' | 'Done'
    due?: string
    tags: string[]
    points?: number
    done: boolean
    owner?: 'A' | 'B'
    notes: string
    project: ('alpha' | 'beta' | 'secret')[]
  }
  const rows: Model[] = []
  const N = 40
  const pad = (n: number) => String(n).padStart(2, '0')

  const FIELDS: CollectionField[] = [
    {
      id: 'st',
      name: 'Status',
      type: 'select',
      options: [
        { id: 'o-todo', name: 'Todo', color: 'gray' },
        { id: 'o-doing', name: 'Doing', color: 'blue' },
        { id: 'o-done', name: 'Done', color: 'green' },
      ],
    },
    { id: 'due', name: 'Due date', type: 'date' },
    {
      id: 'tg',
      name: 'Tags',
      type: 'multiSelect',
      options: [
        { id: 't-urgent', name: 'urgent', color: 'red' },
        { id: 't-later', name: 'later', color: 'gray' },
      ],
    },
    { id: 'pt', name: 'Points', type: 'number' },
    { id: 'dn', name: 'Done', type: 'checkbox' },
    { id: 'ow', name: 'Owner', type: 'person' },
    { id: 'nt', name: 'Notes', type: 'text' },
    // relation + rollup are filled in before() once the Projects collection exists
  ]

  async function makeCollection(owner: User, title: string, fields: CollectionField[], extra: Partial<typeof schema.pages.$inferInsert> = {}) {
    const [p] = await db
      .insert(schema.pages)
      .values({ workspaceId: ws.id, title, createdBy: owner.id, kind: 'collection', ...extra })
      .returning()
    await db.insert(schema.collections).values({ pageId: p.id, fields })
    return p.id
  }

  before(async () => {
    A = await h.makeUser('Alice')
    B = await h.makeUser('Bob')
    C = await h.makeUser('Carol')
    ws = await h.makeWorkspace(A, [B])
    mcpA = await h.connectMcp(app, A, await h.mintToken(A))
    mcpB = await h.connectMcp(app, B, await h.mintToken(B))
    mcpC = await h.connectMcp(app, C, await h.mintToken(C))

    projectsId = await makeCollection(A, 'Projects', [{ id: 'ps', name: 'Stage', type: 'text' }])
    const proj = await db
      .insert(schema.pages)
      .values([
        { workspaceId: ws.id, parentId: projectsId, title: 'Alpha', createdBy: A.id, kind: 'doc' as const, sortOrder: 1 },
        { workspaceId: ws.id, parentId: projectsId, title: 'Beta', createdBy: A.id, kind: 'doc' as const, sortOrder: 2 },
        // private row of B: A must never see it, nor learn that a link to it exists
        { workspaceId: ws.id, parentId: projectsId, title: 'Secret', createdBy: B.id, kind: 'doc' as const, scope: 'private' as const, sortOrder: 3 },
      ])
      .returning({ id: schema.pages.id, title: schema.pages.title })
    P.alpha = proj.find((p) => p.title === 'Alpha')!.id
    P.beta = proj.find((p) => p.title === 'Beta')!.id
    P.secret = proj.find((p) => p.title === 'Secret')!.id

    FIELDS.push(
      { id: 'pr', name: 'Project', type: 'relation', relation: { targetPageId: projectsId } },
      { id: 'rc', name: 'Project count', type: 'rollup', rollup: { relationFieldId: 'pr', targetFieldId: 'title', fn: 'count' } },
    )
    tasksId = await makeCollection(A, 'Tasks', FIELDS)

    const statuses = ['Todo', 'Doing', 'Done', undefined] as const
    const optId = { Todo: 'o-todo', Doing: 'o-doing', Done: 'o-done' } as const
    for (let i = 0; i < N; i++) {
      const m: Model = {
        id: '',
        title: `Task ${pad(i)}`,
        // manual order differs from title order
        sort: (N - i) * 1000,
        status: statuses[i % 4],
        due: i % 5 === 0 ? undefined : `2026-${pad(1 + (i % 12))}-${pad(1 + (i % 28))}`,
        tags: i % 3 === 0 ? ['urgent'] : i % 3 === 1 ? ['urgent', 'later'] : [],
        points: i % 6 === 5 ? undefined : i % 9,
        done: i % 2 === 0,
        owner: i % 3 === 0 ? 'A' : i % 3 === 1 ? 'B' : undefined,
        notes: i % 7 === 0 ? 'please DEPLOY | now' : 'misc 50%_off',
        project: i % 4 === 0 ? ['alpha'] : i % 4 === 1 ? ['beta', 'alpha'] : i % 4 === 2 ? ['secret'] : [],
      }
      const props: Record<string, unknown> = {}
      if (m.status) props.st = optId[m.status]
      if (m.due) props.due = m.due
      if (m.tags.length) props.tg = m.tags.map((t) => (t === 'urgent' ? 't-urgent' : 't-later'))
      if (m.points !== undefined) props.pt = m.points
      if (m.done) props.dn = true
      if (m.owner) props.ow = m.owner === 'A' ? A.id : B.id
      props.nt = m.notes
      if (m.project.length) props.pr = m.project.map((k) => P[k])
      const [r] = await db
        .insert(schema.pages)
        .values({ workspaceId: ws.id, parentId: tasksId, title: m.title, createdBy: A.id, kind: 'doc', sortOrder: m.sort, props })
        .returning({ id: schema.pages.id })
      m.id = r.id
      rows.push(m)
    }
  })

  // ---- helpers -------------------------------------------------------------

  interface Page {
    header: string[]
    lines: string[][]
    next: string | null
    text: string
  }
  function parsePage(text: string): Page {
    const all = text.split('\n')
    const hi = all.findIndex((l) => l.startsWith('id | version'))
    assert.ok(hi >= 0, text)
    const lines: string[][] = []
    let next: string | null = null
    for (const l of all.slice(hi + 1)) {
      if (l.startsWith('next cursor: ')) next = l.slice('next cursor: '.length)
      else if (l === '(end of results)') break
      else if (/^\d+ row\(s\)/.test(l)) continue
      else lines.push(l.split(' | '))
    }
    return { header: all[hi].split(' | '), lines, next, text }
  }
  async function queryAll(mcp: Mcp, args: Record<string, unknown>, limit = 7): Promise<string[][]> {
    const out: string[][] = []
    let cursor: string | undefined
    for (let guard = 0; guard < 100; guard++) {
      const r = await mcp.tool('query_rows', { collectionId: tasksId, limit, ...args, ...(cursor ? { cursor } : {}) })
      assert.equal(r.isError, false, r.text)
      const p = parsePage(r.text)
      out.push(...p.lines)
      if (!p.next) return out
      cursor = p.next
    }
    throw new Error('pagination did not terminate')
  }
  const idsOf = (lines: string[][]) => lines.map((l) => l[0])
  const sorted = (xs: string[]) => [...xs].sort()
  const expectIds = (pred: (m: Model) => boolean) => sorted(rows.filter(pred).map((m) => m.id))

  // ---- filter correctness ----------------------------------------------------

  it('filters match an in-memory oracle for every operator and type', async () => {
    const visible = (m: Model) => m.project.filter((k) => k !== 'secret')
    const cases: [string, (m: Model) => boolean][] = [
      ['Status = Done', (m) => m.status === 'Done'],
      ['status = done', (m) => m.status === 'Done'],
      ['Status != Done', (m) => m.status !== 'Done'],
      ['Status is empty', (m) => !m.status],
      ['Status is not empty', (m) => !!m.status],
      ['Due date < 2026-06-01', (m) => !!m.due && m.due < '2026-06-01'],
      ['Due date >= 2026-06-01', (m) => !!m.due && m.due >= '2026-06-01'],
      ['Due date = 2026-02-02', (m) => m.due === '2026-02-02'],
      ['Due date != 2026-02-02', (m) => m.due !== '2026-02-02'],
      ['Due date is empty', (m) => !m.due],
      ['Tags has urgent', (m) => m.tags.includes('urgent')],
      ['Tags = later', (m) => m.tags.includes('later')],
      ['Tags !has later', (m) => !m.tags.includes('later')],
      ['Tags is empty', (m) => m.tags.length === 0],
      ['Points > 4 AND Points <= 7', (m) => m.points !== undefined && m.points > 4 && m.points <= 7],
      ['Points = 3', (m) => m.points === 3],
      ['Points != 3', (m) => m.points !== 3],
      ['Points < 2', (m) => m.points !== undefined && m.points < 2],
      ['Points is empty', (m) => m.points === undefined],
      ['Done = true', (m) => m.done],
      ['Done = false', (m) => !m.done],
      ['Done != true', (m) => !m.done],
      ['Owner = me', (m) => m.owner === 'A'],
      [`Owner = ${B.name}`, (m) => m.owner === 'B'],
      [`Owner = "${B.email.toUpperCase()}"`, (m) => m.owner === 'B'],
      ['Owner != me', (m) => m.owner !== 'A'],
      ['Owner is empty', (m) => !m.owner],
      ['Notes ~ deploy', (m) => m.notes.toLowerCase().includes('deploy')],
      ['Notes ~ "50%_"', (m) => m.notes.includes('50%_')],
      ['Notes ~ "%"', (m) => m.notes.includes('%')],
      ['Notes !~ deploy', (m) => !m.notes.toLowerCase().includes('deploy')],
      ['Notes = "PLEASE deploy | now"', (m) => m.notes === 'please DEPLOY | now'],
      ['Title ~ "task 1"', (m) => m.title.toLowerCase().includes('task 1')],
      ['Title = "task 03"', (m) => m.title === 'Task 03'],
      ['Project has Alpha', (m) => m.project.includes('alpha')],
      [`Project has ${P.beta}`, (m) => m.project.includes('beta')],
      ['Project !has alpha', (m) => !m.project.includes('alpha')],
      // A cannot see "Secret": rows linking only to it are empty for A, and searching it finds nothing
      ['Project is empty', (m) => visible(m).length === 0],
      ['Project is not empty', (m) => visible(m).length > 0],
      ['Project has Secret', () => false],
      [`Project has ${P.secret}`, () => false],
      ['NOT (Status = Done OR Points > 4)', (m) => !(m.status === 'Done' || (m.points !== undefined && m.points > 4))],
      [
        'Status = Todo AND Tags has urgent OR Owner = me AND Done = true',
        (m) => (m.status === 'Todo' && m.tags.includes('urgent')) || (m.owner === 'A' && m.done),
      ],
    ]
    let checked = 0
    for (const [filter, pred] of cases) {
      const got = idsOf(await queryAll(mcpA, { filter }))
      assert.equal(new Set(got).size, got.length, `duplicates for ${filter}`)
      assert.deepEqual(sorted(got), expectIds(pred), filter)
      checked += got.length
    }
    console.log(`[colq] filters checked: ${cases.length} cases, ${checked} matching rows compared with the oracle`)
  })

  it('B sees the private linked row; A does not', async () => {
    const forB = idsOf(await queryAll(mcpB, { filter: 'Project has Secret' }))
    assert.deepEqual(sorted(forB), expectIds((m) => m.project.includes('secret')))
    const emptyB = idsOf(await queryAll(mcpB, { filter: 'Project is empty' }))
    assert.deepEqual(sorted(emptyB), expectIds((m) => m.project.length === 0))
    // display: A sees only visible titles; the rollup count is also limited to visible links
    const r = await mcpA.tool('query_rows', { collectionId: tasksId, filter: `Title = "Task 02"`, fields: ['Project', 'Project count'] })
    assert.match(r.text, /\| Task 02 \|  \| 0$/m)
    const rb = await mcpB.tool('query_rows', { collectionId: tasksId, filter: `Title = "Task 02"`, fields: ['Project', 'Project count'] })
    assert.match(rb.text, /\| Task 02 \| Secret \| 1$/m)
  })

  it('cells: option names, member names, linked titles, escaped separators', async () => {
    const r = await mcpA.tool('query_rows', { collectionId: tasksId, filter: 'Title = "Task 01"', fields: ['*'] })
    const p = parsePage(r.text)
    assert.deepEqual(p.header, ['id', 'version', 'Title', 'Status', 'Due date', 'Tags', 'Points', 'Done', 'Owner', 'Notes', 'Project', 'Project count'])
    assert.deepEqual(p.lines[0].slice(2), ['Task 01', 'Doing', '2026-02-02', 'urgent, later', '1', 'false', B.name, 'misc 50%_off', 'Beta, Alpha', '2'])
    const d = await mcpA.tool('query_rows', { collectionId: tasksId, filter: 'Title = "Task 00"', fields: ['Notes'] })
    assert.match(d.text, /please DEPLOY \\\| now/)
  })

  // ---- sort + pagination -------------------------------------------------------

  it('sorts in SQL with empty values last and a stable tie-break', async () => {
    const byPoints = idsOf(await queryAll(mcpA, { sort: 'Points desc' }))
    const exp = [...rows]
      .sort((a, b) => {
        const an = a.points === undefined
        const bn = b.points === undefined
        if (an !== bn) return an ? 1 : -1
        if (!an && a.points !== b.points) return b.points! - a.points!
        return a.sort - b.sort
      })
      .map((m) => m.id)
    assert.deepEqual(byPoints, exp)

    const byDueTitle = idsOf(await queryAll(mcpA, { sort: 'Due date, Title desc' }, 5))
    const exp2 = [...rows]
      .sort((a, b) => {
        if (!a.due !== !b.due) return a.due ? -1 : 1
        if (a.due !== b.due) return (a.due ?? '') < (b.due ?? '') ? -1 : 1
        return a.title < b.title ? 1 : -1
      })
      .map((m) => m.id)
    assert.deepEqual(byDueTitle, exp2)

    const byStatus = await queryAll(mcpA, { sort: 'Status desc', fields: ['Status'] })
    const order = byStatus.map((l) => l[3])
    const firstEmpty = order.indexOf('')
    assert.deepEqual(order.slice(0, firstEmpty), [...order.slice(0, firstEmpty)].sort((x, y) => ['Todo', 'Doing', 'Done'].indexOf(y) - ['Todo', 'Doing', 'Done'].indexOf(x)))
    assert.ok(order.slice(firstEmpty).every((s) => s === ''))

    const manual = idsOf(await queryAll(mcpA, {}, 200))
    assert.deepEqual(manual, [...rows].sort((a, b) => a.sort - b.sort).map((m) => m.id))
  })

  it('pages are identical for any page size; inserts between pages cause no duplicates or gaps', async () => {
    const all = idsOf(await queryAll(mcpA, { sort: 'Title' }, 200))
    for (const n of [1, 3, 13]) assert.deepEqual(idsOf(await queryAll(mcpA, { sort: 'Title' }, n)), all)

    const first = parsePage((await mcpA.tool('query_rows', { collectionId: tasksId, sort: 'Title', limit: 10 })).text)
    // a row that sorts before the cursor and one after it
    const [early, late] = await db
      .insert(schema.pages)
      .values([
        { workspaceId: ws.id, parentId: tasksId, title: 'Task 00a', createdBy: A.id, kind: 'doc' as const },
        { workspaceId: ws.id, parentId: tasksId, title: 'Task 99', createdBy: A.id, kind: 'doc' as const },
      ])
      .returning({ id: schema.pages.id })
    try {
      const rest: string[] = []
      let cursor = first.next
      while (cursor) {
        const p = parsePage((await mcpA.tool('query_rows', { collectionId: tasksId, sort: 'Title', limit: 10, cursor })).text)
        rest.push(...idsOf(p.lines))
        cursor = p.next
      }
      const seen = [...idsOf(first.lines), ...rest]
      assert.equal(new Set(seen).size, seen.length, 'no duplicates')
      assert.deepEqual(seen.filter((id) => id !== late.id), all, 'no gaps, original order')
      assert.ok(!seen.includes(early.id) && seen.includes(late.id))
    } finally {
      await db.delete(schema.pages).where(eq(schema.pages.id, early.id))
      await db.delete(schema.pages).where(eq(schema.pages.id, late.id))
    }
  })

  it('cursor from another filter is refused; errors list the valid choices', async () => {
    const p = parsePage((await mcpA.tool('query_rows', { collectionId: tasksId, filter: 'Done = true', limit: 2 })).text)
    const bad = await mcpA.tool('query_rows', { collectionId: tasksId, filter: 'Done = false', cursor: p.next! })
    assert.equal(bad.isError, true)
    assert.match(bad.text, /different filter or sort/)
    const unk = await mcpA.tool('query_rows', { collectionId: tasksId, filter: 'Stat = Done' })
    assert.match(unk.text, /Unknown field "Stat". Valid fields: Title, Status, Due date, Tags, Points, Done, Owner, Notes, Project, Project count/)
    const op = await mcpA.tool('query_rows', { collectionId: tasksId, filter: 'Tags < 3' })
    assert.match(op.text, /Valid: has, !has, is empty, is not empty/)
    const col = await mcpA.tool('query_rows', { collectionId: tasksId, fields: ['Nope'] })
    assert.match(col.text, /Unknown field "Nope"/)
    const desc = await mcpA.tool('query_rows', { collectionId: tasksId, describe: true })
    assert.match(desc.text, /- Status \(select: Todo, Doing, Done\)/)
    assert.match(desc.text, /- Project \(relation → Projects\)/)
    assert.match(desc.text, /- Project count \(rollup count, read-only\)/)
  })

  it('deterministic output: same call twice is byte-identical; editing an unrelated row changes nothing', async () => {
    const args = { collectionId: tasksId, filter: 'Status = Done', sort: 'Points desc', fields: ['*'], limit: 5 }
    const a = await mcpA.tool('query_rows', args)
    const b = await mcpA.tool('query_rows', args)
    assert.equal(a.isError, false, a.text)
    assert.equal(b.text, a.text)
    const lines = a.text.split('\n')
    assert.match(lines[0], /^Collection "Tasks" \(/)
    assert.match(lines[1], /^Fields: /)
    // a row outside the result set (Status = Todo) changes
    const other = rows.find((m) => m.status === 'Todo')!
    await db.update(schema.pages).set({ props: { pt: 999, nt: 'changed' } }).where(eq(schema.pages.id, other.id))
    const c = await mcpA.tool('query_rows', args)
    assert.equal(c.text, a.text)
    const d1 = await mcpA.tool('query_rows', { collectionId: tasksId, describe: true })
    const d2 = await mcpA.tool('query_rows', { collectionId: tasksId, describe: true })
    assert.equal(d2.text, d1.text)
    other.status = undefined
    other.points = 999
    other.notes = 'changed'
    other.tags = []
    other.done = false
    other.owner = undefined
    other.project = []
    other.due = undefined
  })

  // ---- permissions -------------------------------------------------------------

  it('non-members and other users’ private collections are refused', async () => {
    const r = await mcpC.tool('query_rows', { collectionId: tasksId })
    assert.equal(r.isError, true)
    assert.doesNotMatch(r.text, /Task 0/)
    const privId = await makeCollection(B, 'B private', [{ id: 'f', name: 'F', type: 'text' }], { scope: 'private' })
    await db.insert(schema.pages).values({ workspaceId: ws.id, parentId: privId, title: 'hidden row', createdBy: B.id, kind: 'doc', scope: 'private' })
    const ra = await mcpA.tool('query_rows', { collectionId: privId })
    assert.equal(ra.isError, true)
    assert.match(ra.text, /not found/i)
    const rb = await mcpB.tool('query_rows', { collectionId: privId })
    assert.equal(rb.isError, false, rb.text)
    assert.match(rb.text, /hidden row/)
    const row = rows[3]
    const v = parsePage((await mcpA.tool('query_rows', { collectionId: tasksId, filter: `Title = "${row.title}"` })).text).lines[0][1]
    const up = await mcpC.tool('update_row', { rowId: row.id, properties: { Points: 1 }, baseVersion: v })
    assert.equal(up.isError, true)
  })

  it('read-only tokens can query but not write', async () => {
    const ro = await h.connectMcp(app, A, await h.mintToken(A, 'read'), { canWrite: false })
    try {
      const q = await ro.tool('query_rows', { collectionId: tasksId, limit: 1 })
      assert.equal(q.isError, false, q.text)
      const v = parsePage(q.text).lines[0]
      const up = await ro.tool('update_row', { rowId: v[0], properties: { Points: 8 }, baseVersion: v[1] })
      assert.equal(up.isError, true)
      assert.match(up.text, /read-only/)
      const cr = await ro.tool('create_row', { collectionId: tasksId, title: 'x' })
      assert.equal(cr.isError, true)
      assert.match(cr.text, /read-only/)
    } finally {
      await ro.close()
    }
  })

  // ---- writes ----------------------------------------------------------------

  const versionOf = async (mcp: Mcp, title: string) =>
    parsePage((await mcp.tool('query_rows', { collectionId: tasksId, filter: `Title = "${title}"` })).text).lines[0]

  it('update_row maps names, validates, and returns the new version', async () => {
    const [id, v0] = await versionOf(mcpA, 'Task 05')
    const r = await mcpA.tool('update_row', {
      rowId: id,
      properties: { status: 'done', 'Due date': '2026-12-24', Tags: ['later'], Points: 42, Owner: B.email, Project: ['Beta'], Notes: null },
      baseVersion: v0,
    })
    assert.equal(r.isError, false, r.text)
    const v1 = /New version: (\w+)/.exec(r.text)![1]
    assert.notEqual(v1, v0)
    const line = parsePage((await mcpA.tool('query_rows', { collectionId: tasksId, filter: 'Title = "Task 05"', fields: ['*'] })).text).lines[0]
    assert.equal(line[1], v1, 'version from update_row equals the version query_rows reports')
    assert.deepEqual(line.slice(3, 11), ['Done', '2026-12-24', 'later', '42', 'false', B.name, '', 'Beta'])

    const bad = await mcpA.tool('update_row', { rowId: id, properties: { Status: 'Shipped', Points: 'lots', 'Project count': 1 }, baseVersion: v1 })
    assert.equal(bad.isError, true)
    assert.match(bad.text, /expects one of: Todo, Doing, Done/)
    assert.match(bad.text, /expects a number/)
    assert.match(bad.text, /rollup/)
    assert.match(bad.text, /Nothing was written/)
    const ttl = await mcpA.tool('update_row', { rowId: id, properties: { Title: 'x' }, baseVersion: v1 })
    assert.match(ttl.text, /rename_page/)
    const rel = await mcpA.tool('update_row', { rowId: id, properties: { Project: ['Secret'] }, baseVersion: v1 })
    assert.match(rel.text, /No row titled "Secret"/)
    assert.equal((await versionOf(mcpA, 'Task 05'))[1], v1, 'failed calls wrote nothing')
  })

  it('stale baseVersion: conflict with current values, other writer’s change kept', async () => {
    const [id, v0] = await versionOf(mcpA, 'Task 06')
    const [, vb] = await versionOf(mcpB, 'Task 06')
    assert.equal(vb, v0)
    const okB = await mcpB.tool('update_row', { rowId: id, properties: { Points: 77 }, baseVersion: vb })
    assert.equal(okB.isError, false, okB.text)
    const stale = await mcpA.tool('update_row', { rowId: id, properties: { Notes: 'from A' }, baseVersion: v0 })
    assert.equal(stale.isError, true)
    assert.match(stale.text, /Version conflict/)
    assert.match(stale.text, /Points: 77/)
    assert.match(stale.text, /Nothing was written/)
    const cur = /current (\w+)\)/.exec(stale.text)![1]
    const [row] = await db.select({ props: schema.pages.props }).from(schema.pages).where(eq(schema.pages.id, id))
    assert.equal((row.props as Record<string, unknown>).pt, 77)
    assert.equal((row.props as Record<string, unknown>).nt, 'misc 50%_off')
    const retry = await mcpA.tool('update_row', { rowId: id, properties: { Notes: 'from A' }, baseVersion: cur })
    assert.equal(retry.isError, false, retry.text)
  })

  it('concurrent updates with the same baseVersion: exactly one wins (checked under the row lock)', async () => {
    const [id, v0] = await versionOf(mcpA, 'Task 07')
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => (i % 2 ? mcpA : mcpB).tool('update_row', { rowId: id, properties: { Points: 100 + i }, baseVersion: v0 })),
    )
    const wins = results.filter((r) => !r.isError)
    assert.equal(wins.length, 1, results.map((r) => r.text).join('\n'))
    assert.ok(results.filter((r) => r.isError).every((r) => /Version conflict/.test(r.text)))
  })

  it('REST: PATCH props without baseVersion is unchanged; with a stale one it is a 409', async () => {
    const id = rows[8].id
    const plain = await app.inject({ method: 'PATCH', url: `/api/pages/${id}/props`, headers: { cookie: A.cookie }, payload: { props: { pt: 1 } } })
    assert.equal(plain.statusCode, 200)
    assert.deepEqual(Object.keys(plain.json()), ['row'])
    const stale = await app.inject({
      method: 'PATCH',
      url: `/api/pages/${id}/props`,
      headers: { cookie: A.cookie },
      payload: { props: { pt: 2 }, baseVersion: 'deadbeef0000' },
    })
    assert.equal(stale.statusCode, 409)
    assert.equal(stale.json().error.code, 'ROW_VERSION_CONFLICT')
    assert.match(stale.json().error.currentVersion, /^[0-9a-f]{12}$/)
    const row = await app.inject({ method: 'GET', url: `/api/pages/${id}/row`, headers: { cookie: A.cookie } })
    assert.equal(row.json().row.version, stale.json().error.currentVersion)
    const notRow = await app.inject({ method: 'GET', url: `/api/pages/${tasksId}/row`, headers: { cookie: A.cookie } })
    assert.equal(notRow.statusCode, 400)
  })

  it('create_row with names, relation by title, and the returned version', async () => {
    const r = await mcpA.tool('create_row', {
      collectionId: tasksId,
      title: 'Created by agent',
      properties: { Status: 'Todo', Tags: 'urgent', Owner: 'me', Project: ['alpha', P.beta] },
    })
    assert.equal(r.isError, false, r.text)
    const id = /Created row ([0-9a-f-]{36})/.exec(r.text)![1]
    const v = /Version: (\w+)/.exec(r.text)![1]
    assert.match(r.text, /Project: Alpha, Beta/)
    const line = parsePage((await mcpA.tool('query_rows', { collectionId: tasksId, filter: 'Title = "Created by agent"', fields: ['Status', 'Owner', 'Project count'] })).text).lines[0]
    assert.deepEqual(line, [id, v, 'Created by agent', 'Todo', A.name, '2'])
    const bad = await mcpA.tool('create_row', { collectionId: tasksId, properties: { Status: 'Nope' } })
    assert.equal(bad.isError, true)
    const n = (await queryAll(mcpA, { filter: 'Title is empty' })).length
    assert.equal(n, 0, 'invalid create wrote nothing')
    await db.delete(schema.pages).where(eq(schema.pages.id, id))
  })

  // ---- measurement -------------------------------------------------------------

  it('tokens: query_rows vs read_page on a 200-row collection', async () => {
    const bigId = await makeCollection(A, 'Big', FIELDS.slice(0, 7))
    const opt = { Todo: 'o-todo', Doing: 'o-doing', Done: 'o-done' } as const
    const big = Array.from({ length: 200 }, (_, i) => ({
      i,
      status: (['Todo', 'Doing', 'Done'] as const)[i % 3],
      due: `2026-${pad(1 + (i % 12))}-${pad(1 + (i % 28))}`,
      points: i % 13,
    }))
    await db.insert(schema.pages).values(
      big.map((b) => ({
        workspaceId: ws.id,
        parentId: bigId,
        title: `Item ${b.i} ${b.i % 2 ? 'migrate billing service' : 'review onboarding docs'}`,
        createdBy: A.id,
        kind: 'doc' as const,
        sortOrder: b.i,
        props: {
          st: opt[b.status],
          due: b.due,
          tg: b.i % 4 ? ['t-urgent'] : [],
          pt: b.points,
          dn: b.i % 2 === 0,
          ow: b.i % 2 ? A.id : B.id,
          nt: `Note for item ${b.i}: some context about the work to be done`,
        },
      })),
    )
    const readPage = await mcpA.tool('read_page', { pageId: bigId })
    assert.equal(readPage.isError, false, readPage.text)
    const tokRead = estimateTokens(readPage.text)
    const q = async (args: Record<string, unknown>) => {
      const r = await mcpA.tool('query_rows', { collectionId: bigId, ...args })
      assert.equal(r.isError, false, r.text)
      return r.text
    }
    const def = await q({})
    const all200 = await q({ limit: 200 })
    const all200Fields = await q({ limit: 200, fields: ['*'] })
    const filtered = await q({ filter: 'Status = Done AND Due date < 2026-04-01 AND Tags has urgent', limit: 200, fields: ['Status', 'Due date'] })
    const nFiltered = parsePage(filtered).lines.length
    const expFiltered = big.filter((b) => b.status === 'Done' && b.due < '2026-04-01' && b.i % 4 !== 0).length
    assert.equal(nFiltered, expFiltered)
    const report = {
      read_page: tokRead,
      query_rows_default_25: estimateTokens(def),
      query_rows_200_default_fields: estimateTokens(all200),
      query_rows_200_all_fields: estimateTokens(all200Fields),
      query_rows_filtered: estimateTokens(filtered),
      filtered_rows: nFiltered,
      filtered_expected: expFiltered,
    }
    console.log('[colq] tokens', JSON.stringify(report))
    assert.ok(report.query_rows_default_25 < tokRead / 4)
    assert.ok(report.query_rows_filtered < tokRead / 10)
    assert.ok(readPage.text.includes('Item 199'), 'read_page shows all rows (baseline is complete)')
  })
})
