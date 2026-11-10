/**
 * Default-scope latency with archived workspaces (docs/adr/2303-*). Not part of CI.
 *
 *   cd apps/server
 *   DATABASE_URL=postgres://…/scratch npx tsx scripts/archive-bench.ts [--workspaces 50] [--pages 5000] [--archived 0,40]
 *
 * ROOT=<another checkout> runs the same calls against that tree's server code (the "before" column:
 * a tree without workspace_listings, where only --archived 0 makes sense).
 *
 * Uses a migrated SCRATCH database and does not clean up. One user, member of W workspaces holding
 * --pages pages in all (~1.8 KB of body, three sections each, "deploy" in every 5th page). Through
 * `app.inject` with an OAuth bearer token (the MCP tools' path), without workspaceId:
 *
 *   find_context cached    GET /api/context?q=deploy, the same query again (a result cache hit:
 *                          scope statement + key + lookup)
 *   find_context uncached  the same with the result cache off (scope + retrieval every call)
 *   search                 GET /api/search?q=deploy
 *
 * For each archived count A, the first A workspaces are archived for that user. N rounds per cell
 * (env N, default 60) after 15 warm-up calls; p50/p95 in ms. Then (this tree only) the scope statement
 * alone, 0.17's against this one, interleaved in one process.
 */
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.APP_SECRET_KEY ||= 'test-app-secret-key-0123456789-abcdefghij'
process.env.DATA_DIR ||= `${process.env.TMPDIR || '/tmp'}/inkling-bench-${process.pid}`

const arg = (name: string, d: string) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : d)
const W = Number(arg('--workspaces', '50'))
const PAGES = Number(arg('--pages', '5000'))
const ARCHIVED = arg('--archived', '0,40').split(',').map(Number)
const N = Number(process.env.N ?? 60)
const ROOT = process.env.ROOT ? `${process.env.ROOT.replace(/\/$/, '')}/apps/server/src` : new URL('../src', import.meta.url).pathname

const h = await import(`${ROOT}/mcpTools/testHarness.ts`)
const { db, closeDb } = await import(`${ROOT}/db/index.ts`)
const { setContextCacheEnabled } = await import(`${ROOT}/context/contextCache.ts`)
const { MCP_INTERNAL_HEADER, MCP_INTERNAL_SECRET } = await import(`${ROOT}/oauth.ts`)
const collab = await import(`${ROOT}/collab.ts`)
const { sql } = await import('drizzle-orm')
const app = await h.buildTestApp()

const FILLER = 'lorem ipsum dolor sit amet the team said we maintain the notes for the weekly review '
const user = await h.makeUser('archbench')
const wss: { id: string }[] = []
for (let i = 0; i < W; i++) wss.push(await h.makeWorkspace(user, [], `Bench ${i + 1}`))
const per = Math.ceil(PAGES / W)
for (const ws of wss) {
  await db.execute(sql`
    INSERT INTO pages (workspace_id, title, created_by, kind, sort_order, updated_at)
    SELECT ${ws.id}::uuid, 'Note ' || g, ${user.id}::uuid, 'doc', g, now() - make_interval(mins => g)
      FROM generate_series(1, ${per}) g`)
  await db.execute(sql`
    INSERT INTO page_texts (page_id, text)
    SELECT p.id, repeat(${FILLER}, 10) || CASE WHEN p.sort_order::int % 5 = 0 THEN ' we deploy the service on friday ' ELSE ' ' END || repeat(${FILLER}, 10)
      FROM pages p WHERE p.workspace_id = ${ws.id}`)
  await db.execute(sql`
    INSERT INTO page_chunks (page_id, ord, workspace_id, anchor, heading_path, level, part, text, token_estimate, hash, section_hash)
    SELECT p.id, s.ord, p.workspace_id, s.anchor, s.path, s.lvl, 0,
           repeat(${FILLER}, 7) || CASE WHEN s.ord = 1 AND p.sort_order::int % 5 = 0 THEN ' we deploy the service on friday' ELSE '' END,
           150, md5(p.id::text || s.ord), md5(p.id::text || s.anchor)
      FROM pages p
      CROSS JOIN LATERAL (VALUES (0, '_intro', '', 0), (1, 'setup', 'Setup', 2), (2, 'notes', 'Notes', 2)) AS s(ord, anchor, path, lvl)
     WHERE p.workspace_id = ${ws.id}`)
}
await db.execute(sql`ANALYZE pages`)
await db.execute(sql`ANALYZE page_texts`)
await db.execute(sql`ANALYZE page_chunks`)
const token = await h.mintToken(user, 'notes', 'Bench Agent')
const headers = { authorization: `Bearer ${token}`, [MCP_INTERNAL_HEADER]: MCP_INTERNAL_SECRET }

async function get(url: string) {
  const r = await app.inject({ method: 'GET', url, headers })
  if (r.statusCode !== 200) throw new Error(`${url} ${r.statusCode} ${r.body.slice(0, 200)}`)
  return r
}
const pct = (t: number[], p: number) => [...t].sort((a, b) => a - b)[Math.min(t.length - 1, Math.floor(t.length * p))]
async function time(fn: () => Promise<unknown>): Promise<string> {
  for (let i = 0; i < 15; i++) await fn()
  const t: number[] = []
  for (let i = 0; i < N; i++) {
    const a = performance.now()
    await fn()
    t.push(performance.now() - a)
  }
  return `${pct(t, 0.5).toFixed(2)} / ${pct(t, 0.95).toFixed(2)}`
}

console.log(`${process.env.ROOT ? `ROOT=${process.env.ROOT}` : 'this tree'}: ${W} workspaces, ${PAGES} pages, N=${N} after 15 warm-up calls, ms p50 / p95`)
console.log('archived | find_context cached | find_context uncached | search | fragments | search total')
for (const a of ARCHIVED) {
  if (a > 0 || !process.env.ROOT) {
    await db.execute(sql`DELETE FROM workspace_listings WHERE user_id = ${user.id}`)
    for (const ws of wss.slice(0, a)) {
      await db.execute(sql`INSERT INTO workspace_listings (user_id, workspace_id, archived_at) VALUES (${user.id}, ${ws.id}, now())`)
    }
  }
  setContextCacheEnabled(true)
  const cached = await time(() => get('/api/context?q=deploy'))
  setContextCacheEnabled(false)
  const uncached = await time(() => get('/api/context?q=deploy&budget=3000'))
  setContextCacheEnabled(true)
  const search = await time(() => get('/api/search?q=deploy'))
  const frags = ((await get('/api/context?q=deploy')).json() as { fragments: unknown[] }).fragments.length
  const total = ((await get('/api/search?q=deploy')).json() as { total: number }).total
  console.log(`${a} | ${cached} | ${uncached} | ${search} | ${frags} | ${total}`)
}
// The scope statement alone, interleaved in this process (less sensitive to machine load than the
// routes): the 0.17 statement of contextCache.ts searchScope vs this one, with the archived probe.
if (!process.env.ROOT) {
  const { agentAllowedSql } = await import(`${ROOT}/agentAccess.ts`)
  const { twoFactorBlockedSql } = await import(`${ROOT}/twoFactorPolicy.ts`)
  const { archivedSql } = await import(`${ROOT}/workspaceListing.ts`)
  const scope = (probe: boolean) => sql`
    SELECT wm.workspace_id AS id, w.name, ${probe ? archivedSql(sql`wm.workspace_id`, user.id) : sql`false`} AS archived,
           coalesce(a.version, 0)::text AS acl,
           (SELECT coalesce(max(greatest(p.updated_at, coalesce(p.deleted_at, p.updated_at)))::text, '') || '/' ||
                   count(*) FILTER (WHERE p.deleted_at IS NULL)::text
              FROM pages p WHERE p.workspace_id = wm.workspace_id) AS pages
      FROM workspace_members wm
      JOIN workspaces w ON w.id = wm.workspace_id
      LEFT JOIN workspace_acl_versions a ON a.workspace_id = wm.workspace_id
     WHERE wm.user_id = ${user.id} AND w.deleted_at IS NULL AND ${agentAllowedSql(sql`wm.workspace_id`)}
       AND NOT ${twoFactorBlockedSql(sql`wm.workspace_id`, user.id)}
     ORDER BY wm.workspace_id`
  console.log('scope statement (find_context markers), interleaved, ms p50 / p95: archived | 0.17 statement | with the archive probe')
  for (const a of ARCHIVED) {
    await db.execute(sql`DELETE FROM workspace_listings WHERE user_id = ${user.id}`)
    for (const ws of wss.slice(0, a)) await db.execute(sql`INSERT INTO workspace_listings (user_id, workspace_id, archived_at) VALUES (${user.id}, ${ws.id}, now())`)
    const t0: number[] = []
    const t1: number[] = []
    for (let i = 0; i < 15; i++) await db.execute(scope(i % 2 === 0))
    for (let i = 0; i < N * 2; i++) {
      const runs: [number[], boolean][] = i % 2 ? [[t0, false], [t1, true]] : [[t1, true], [t0, false]]
      for (const [t, probe] of runs) {
        const s0 = performance.now()
        await db.execute(scope(probe))
        t.push(performance.now() - s0)
      }
    }
    const f = (t: number[]) => `${pct(t, 0.5).toFixed(2)} / ${pct(t, 0.95).toFixed(2)}`
    console.log(`${a} | ${f(t0)} | ${f(t1)}`)
  }
}
await collab.destroyCollab()
await app.close()
await closeDb()
process.exit(0)
