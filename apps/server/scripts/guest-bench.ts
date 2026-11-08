/**
 * Guests and page rows benchmark (docs/adr/1252-*). Not part of CI.
 *
 *   cd apps/server
 *   DATABASE_URL=postgres://…/scratch npx tsx scripts/guest-bench.ts     # a migrated throwaway database
 *
 * p50/p95 of read_page (GET /pages/:id/export?format=md for members; guests are refused there, so
 * GET /pages/:id/lock + /comments, what a guest's page view loads), list (GET /workspaces/:id/pages)
 * and search (GET /workspaces/:id/search?q=, members only) through `app.inject` with browser cookies,
 * on a 5,053-page workspace (the seed of range-bench.ts):
 *   - member, no page rows anywhere (the "0 guests" case);
 *   - member, other people have rows in the workspace (5 guests, 2 member rows);
 *   - member with a row of their own (view, on another folder);
 *   - guests with a row on a 102-page and a 1,012-page subtree.
 * One full warm-up round, then the reported round in reverse order. Modes a tree cannot run (the
 * guest modes on a tree without guests) print n/a.
 */
const h = await import('../src/mcpTools/testHarness')
const { db, closeDb } = await import('../src/db/index')
const { sql } = await import('drizzle-orm')
const Fastify = (await import('fastify')).default
const app = Fastify()
await app.register(import('@fastify/cookie'))
await app.register(async (api) => {
  await (await import('../src/routes/workspaces')).registerWorkspaceRoutes(api)
  await (await import('../src/routes/pages')).registerPageRoutes(api)
  await (await import('../src/routes/exportImport')).registerExportImportRoutes(api)
  await (await import('../src/routes/editLock')).registerEditLockRoutes(api)
  await (await import('../src/routes/comments')).registerCommentRoutes(api)
}, { prefix: '/api' })
await app.ready()

const owner = await h.makeUser('bench')
const member = await h.makeUser('member')
const memberRows = await h.makeUser('member-rows')
const ws = await h.makeWorkspace(owner, [member, memberRows])
await db.execute(sql`
  WITH f AS (
    INSERT INTO pages (workspace_id, title, created_by, kind, sort_order)
    SELECT ${ws.id}::uuid, 'Folder ' || g, ${owner.id}::uuid, 'folder', g FROM generate_series(1, 40) g RETURNING id, sort_order
  )
  INSERT INTO pages (workspace_id, parent_id, title, created_by, kind, sort_order)
  SELECT ${ws.id}::uuid, f.id, 'Note ' || f.sort_order || '-' || g || CASE WHEN g % 20 = 0 THEN ' needle' ELSE '' END, ${owner.id}::uuid, 'doc', g
    FROM f, generate_series(1, 100) g`)
const [big] = (await db.execute(sql`INSERT INTO pages (workspace_id, title, created_by, kind, sort_order) VALUES (${ws.id}, 'Big', ${owner.id}, 'folder', 100) RETURNING id`)) as unknown as { id: string }[]
await db.execute(sql`
  WITH s AS (
    INSERT INTO pages (workspace_id, parent_id, title, created_by, kind, sort_order)
    SELECT ${ws.id}::uuid, ${big.id}::uuid, 'Sub ' || g, ${owner.id}::uuid, 'folder', g FROM generate_series(1, 10) g RETURNING id, sort_order
  )
  INSERT INTO pages (workspace_id, parent_id, title, created_by, kind, sort_order)
  SELECT ${ws.id}::uuid, s.id, 'Big note ' || s.sort_order || '-' || g || CASE WHEN g % 20 = 0 THEN ' needle' ELSE '' END, ${owner.id}::uuid, 'doc', g
    FROM s, generate_series(1, 100) g`)
await db.execute(sql`INSERT INTO page_texts (page_id, text) SELECT id, repeat('lorem ipsum dolor sit amet ', 20) || title FROM pages WHERE workspace_id = ${ws.id}`)
const [small] = (await db.execute(sql`SELECT id FROM pages WHERE workspace_id = ${ws.id} AND title = 'Folder 7'`)) as unknown as { id: string }[]
const [folder9] = (await db.execute(sql`SELECT id FROM pages WHERE workspace_id = ${ws.id} AND title = 'Folder 9'`)) as unknown as { id: string }[]
const para = [{ type: 'paragraph', content: [{ type: 'text', text: 'hello '.repeat(400), styles: {} }] }] as never
const target = await h.makeDocPage(ws.id, owner.id, 'Read me', para, { parentId: small.id })
const targetBig = await h.makeDocPage(ws.id, owner.id, 'Read me big', para, { parentId: big.id })
// A second workspace without any row: the "0 guests" case.
const plain = await h.makeWorkspace(owner, [member])
await db.execute(sql`
  INSERT INTO pages (workspace_id, title, created_by, kind, sort_order)
  SELECT ${plain.id}::uuid, 'Plain ' || g || CASE WHEN g % 20 = 0 THEN ' needle' ELSE '' END, ${owner.id}::uuid, 'doc', g FROM generate_series(1, 5000) g`)
await db.execute(sql`INSERT INTO page_texts (page_id, text) SELECT id, repeat('lorem ipsum dolor sit amet ', 20) || title FROM pages WHERE workspace_id = ${plain.id}`)
const plainTarget = await h.makeDocPage(plain.id, owner.id, 'Read me plain', para)

// Rows: 3 guests on Folder 7, 2 on Big; member-rows has view on Folder 9 (not on the read targets).
const guestSmall = await h.makeUser('guest-small')
const guestBig = await h.makeUser('guest-big')
let rowsWork = true
try {
  const extra = [await h.makeUser('g3'), await h.makeUser('g4'), await h.makeUser('g5')]
  const rows = [
    [small.id, guestSmall.id, 'edit'],
    [big.id, guestBig.id, 'edit'],
    [small.id, extra[0].id, 'view'],
    [small.id, extra[1].id, 'comment'],
    [big.id, extra[2].id, 'view'],
    [folder9.id, memberRows.id, 'view'],
  ]
  for (const [p, u, l] of rows) await db.execute(sql`INSERT INTO page_grants (page_id, user_id, level) VALUES (${p}, ${u}, ${l})`)
  await db.execute(sql`UPDATE workspace_acl_versions SET version = version + 1 WHERE workspace_id = ${ws.id}`)
} catch {
  rowsWork = false
}
await db.execute(sql`ANALYZE pages; ANALYZE page_texts`)
const [{ n }] = (await db.execute(sql`SELECT count(*)::int AS n FROM pages WHERE workspace_id = ${ws.id}`)) as unknown as { n: number }[]

type Mode = [string, string, string, string, boolean] // name, cookie, workspace, page, guest
const modes: Mode[] = [
  ['member, workspace without rows', member.cookie, plain.id, plainTarget.id, false],
  ['member, workspace with rows of others', member.cookie, ws.id, target.id, false],
  ['member with a view row elsewhere', memberRows.cookie, ws.id, target.id, false],
  ['guest, 102-page subtree', guestSmall.cookie, ws.id, target.id, true],
  ['guest, 1,012-page subtree', guestBig.cookie, ws.id, targetBig.id, true],
]
const N = Number(process.env.N ?? 300)
async function measure(cookie: string, urls: string[]) {
  const run = async () => {
    for (const url of urls) {
      const r = await app.inject({ method: 'GET', url, headers: { cookie } })
      if (r.statusCode !== 200) throw new Error(`${url} ${r.statusCode} ${r.body.slice(0, 200)}`)
    }
  }
  for (let i = 0; i < 30; i++) await run()
  const t: number[] = []
  for (let i = 0; i < N; i++) {
    const a = performance.now()
    await run()
    t.push(performance.now() - a)
  }
  t.sort((x, y) => x - y)
  return { p50: t[Math.floor(N * 0.5)], p95: t[Math.floor(N * 0.95)] }
}
const cells = (m: Mode) => {
  const [, , w, p, guest] = m
  return [
    guest ? [`/api/pages/${p}/lock`, `/api/pages/${p}/comments`] : [`/api/pages/${p}/export?format=md`],
    [`/api/workspaces/${w}/pages`],
    guest ? null : [`/api/workspaces/${w}/search?q=needle`],
  ]
}
const f = (x: { p50: number; p95: number } | null) => (x ? `${x.p50.toFixed(2)} / ${x.p95.toFixed(2)}` : 'n/a')
console.log(`pages in workspace: ${n} (+5,001 in the plain one), rows written: ${rowsWork}, N=${N} per cell (after 30 warm-up), ms`)
console.log('mode | read p50/p95 | list p50/p95 | search p50/p95')
async function row(m: Mode) {
  const out: ({ p50: number; p95: number } | null)[] = []
  for (const urls of cells(m)) {
    if (!urls) out.push(null)
    else out.push(await measure(m[1], urls).catch(() => null))
  }
  return out
}
for (const m of modes) await row(m)
for (const m of [...modes].reverse()) {
  const [r, l, s] = await row(m)
  console.log(`${m[0]} | ${f(r)} | ${f(l)} | ${f(s)}`)
}
await app.close()
await closeDb()
process.exit(0)
