/**
 * Connection range benchmark (docs/adr/1202-*). Not part of CI.
 *
 *   cd apps/server
 *   DATABASE_URL=postgres://…/scratch npx tsx scripts/range-bench.ts     # a migrated throwaway database
 *
 * p50/p95 of read_page (GET /pages/:id/export?format=md), list (GET /workspaces/:id/pages) and search
 * (GET /workspaces/:id/search?q=) through `app.inject`, for a browser cookie (no range term: the SQL
 * from before ranges), API tokens with range 'all', 'workspaces', and two subtrees (102 and 1,012 pages)
 * on a 5,053-page workspace. One full warm-up round, then the reported round in reverse order.
 */
const h = await import('../src/mcpTools/testHarness')
const { db, closeDb } = await import('../src/db/index')
const { sql } = await import('drizzle-orm')
const { createApiToken } = await import('../src/apiTokens')
const Fastify = (await import('fastify')).default
const app = Fastify()
await app.register(import('@fastify/cookie'))
await app.register(async (api) => {
  await (await import('../src/routes/workspaces')).registerWorkspaceRoutes(api)
  await (await import('../src/routes/pages')).registerPageRoutes(api)
  await (await import('../src/routes/exportImport')).registerExportImportRoutes(api)
}, { prefix: '/api' })
await app.ready()

const owner = await h.makeUser('bench')
const ws = await h.makeWorkspace(owner)
const other = await h.makeWorkspace(owner)
// 40 folders × 100 pages, plus one big folder: 10 subfolders × 100 pages (≈ 5,051 pages)
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
// the page read_page reads: inside both subtrees? one per subtree; use a page under Folder 7 and one under Big
const target = await h.makeDocPage(ws.id, owner.id, 'Read me', [{ type: 'paragraph', content: [{ type: 'text', text: 'hello '.repeat(400), styles: {} }] }] as never, { parentId: small.id })
const targetBig = await h.makeDocPage(ws.id, owner.id, 'Read me big', [{ type: 'paragraph', content: [{ type: 'text', text: 'hello '.repeat(400), styles: {} }] }] as never, { parentId: big.id })
await db.execute(sql`ANALYZE pages; ANALYZE page_texts`)
const [{ n }] = (await db.execute(sql`SELECT count(*)::int AS n FROM pages WHERE workspace_id = ${ws.id}`)) as unknown as { n: number }[]

const pat = async (range: unknown) => `Bearer ${(await createApiToken(owner.id, { name: 'b', expiresInDays: null, access: 'read', range: range as never })).secret}`
const modes: [string, Record<string, string>, string][] = [
  ['cookie (before: no range term)', { cookie: owner.cookie }, target.id],
  ['token, range all', { authorization: await pat({ kind: 'all' }) }, target.id],
  ['token, range workspaces', { authorization: await pat({ kind: 'workspaces', workspaceIds: [ws.id, other.id] }) }, target.id],
  ['token, subtree 102 pages', { authorization: await pat({ kind: 'subtree', pageId: small.id }) }, target.id],
  ['token, subtree 1,012 pages', { authorization: await pat({ kind: 'subtree', pageId: big.id }) }, targetBig.id],
]
const N = Number(process.env.N ?? 300)
async function measure(headers: Record<string, string>, url: string) {
  for (let i = 0; i < 30; i++) await app.inject({ method: 'GET', url, headers })
  const t: number[] = []
  for (let i = 0; i < N; i++) {
    const a = performance.now()
    const r = await app.inject({ method: 'GET', url, headers })
    t.push(performance.now() - a)
    if (r.statusCode !== 200) throw new Error(`${url} ${r.statusCode} ${r.body.slice(0, 200)}`)
  }
  t.sort((x, y) => x - y)
  return { p50: t[Math.floor(N * 0.5)], p95: t[Math.floor(N * 0.95)] }
}
console.log(`pages in workspace: ${n}, N=${N} per cell (after 30 warm-up), ms`)
console.log('mode | read_page p50/p95 | list p50/p95 | search p50/p95')
// Two rounds; the first (all modes, forward) only warms caches and JIT, the second is reported in
// reverse order so no mode always runs first.
for (const [, headers, pageId] of modes) {
  await measure(headers, `/api/pages/${pageId}/export?format=md`)
  await measure(headers, `/api/workspaces/${ws.id}/pages`)
  await measure(headers, `/api/workspaces/${ws.id}/search?q=needle`)
}
for (const [name, headers, pageId] of [...modes].reverse()) {
  const r = await measure(headers, `/api/pages/${pageId}/export?format=md`)
  const l = await measure(headers, `/api/workspaces/${ws.id}/pages`)
  const s = await measure(headers, `/api/workspaces/${ws.id}/search?q=needle`)
  const f = (x: { p50: number; p95: number }) => `${x.p50.toFixed(2)} / ${x.p95.toFixed(2)}`
  console.log(`${name} | ${f(r)} | ${f(l)} | ${f(s)}`)
}
await app.close()
await closeDb()
process.exit(0)
