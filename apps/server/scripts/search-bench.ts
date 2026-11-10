/**
 * Agent search benchmark (docs/adr/2183-*). Not part of CI.
 *
 *   cd apps/server
 *   DATABASE_URL=postgres://…/scratch npx tsx scripts/search-bench.ts [--pages 5000] [--workspaces 1,5,10]
 *
 * Uses a migrated SCRATCH database: it inserts thousands of rows and does not clean up at the end
 * (between two workspace counts it deletes the previous count's pages, so each run of the table
 * sees `--pages` pages of its own on top of whatever the database held before).
 *
 * For each workspace count W, one user is a member of W workspaces holding `--pages` pages in all
 * (pages / W each, ~1.8 KB of body text, three sections whose heading paths sometimes hold the
 * common word). Through `app.inject` with an OAuth bearer token (the MCP tools' path) it times:
 *
 *   before  what the MCP search tool did up to 0.16: GET /api/workspaces, then
 *           GET /api/workspaces/:id/search?q= once per workspace, one after another
 *   after   GET /api/search?q= (one ranked statement over every workspace, default limit 10)
 *
 * for a 2-character term ("ai": inside "said", "maintain"; no trigram index), a common word
 * ("deploy": ~20 % of bodies, some titles and headings) and a rare one ("zanzibar": 3 pages).
 * N rounds per cell (env N, default 100) after 20 warm-up calls, before/after interleaved; p50/p95 in ms.
 */
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.APP_SECRET_KEY ||= 'test-app-secret-key-0123456789-abcdefghij'
process.env.DATA_DIR ||= `${process.env.TMPDIR || '/tmp'}/inkling-bench-${process.pid}`

const arg = (name: string, d: string) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : d)
const PAGES = Number(arg('--pages', '5000'))
const COUNTS = arg('--workspaces', '1,5,10').split(',').map(Number)
const N = Number(process.env.N ?? 100)
const TERMS = ['ai', 'deploy', 'zanzibar']

const h = await import('../src/mcpTools/testHarness')
const { db, closeDb } = await import('../src/db/index')
const { sql } = await import('drizzle-orm')
const collab = await import('../src/collab')
const { MCP_INTERNAL_HEADER, MCP_INTERNAL_SECRET } = await import('../src/oauth')
const app = await h.buildTestApp()

const FILLER = 'lorem ipsum dolor sit amet the team said we maintain the notes for the weekly review '

async function seed(w: number) {
  const user = await h.makeUser(`bench${w}`)
  const wss: { id: string }[] = []
  for (let i = 0; i < w; i++) wss.push(await h.makeWorkspace(user, [], `Bench ${w}-${i + 1}`))
  const per = Math.ceil(PAGES / w)
  for (const ws of wss) {
    await db.execute(sql`
      INSERT INTO pages (workspace_id, title, created_by, kind, sort_order, updated_at)
      SELECT ${ws.id}::uuid,
             CASE WHEN g % 100 = 0 THEN 'Deploy runbook ' || g ELSE 'Note ' || g END,
             ${user.id}::uuid, 'doc', g, now() - make_interval(mins => g)
        FROM generate_series(1, ${per}) g`)
    // body: ~1.8 KB; "deploy" in every 5th page, mid-text
    await db.execute(sql`
      INSERT INTO page_texts (page_id, text)
      SELECT p.id, repeat(${FILLER}, 10) || CASE WHEN p.sort_order::int % 5 = 0 THEN ' we deploy the service on friday ' ELSE ' ' END || repeat(${FILLER}, 10)
        FROM pages p WHERE p.workspace_id = ${ws.id}`)
    // three sections per page; every 20th page has "Deploy notes" as a heading
    await db.execute(sql`
      INSERT INTO page_chunks (page_id, ord, workspace_id, anchor, heading_path, level, part, text, token_estimate, hash, section_hash)
      SELECT p.id, s.ord, p.workspace_id, s.anchor, s.path, s.lvl, 0,
             repeat(${FILLER}, 7) || CASE WHEN s.ord = 1 AND p.sort_order::int % 5 = 0 THEN ' we deploy the service on friday' ELSE '' END,
             150, md5(p.id::text || s.ord), md5(p.id::text || s.anchor)
        FROM pages p
        CROSS JOIN LATERAL (VALUES
          (0, '_intro', '', 0),
          (1, 'setup', 'Setup', 2),
          (2, CASE WHEN p.sort_order::int % 20 = 0 THEN 'deploy-notes' ELSE 'notes' END, CASE WHEN p.sort_order::int % 20 = 0 THEN 'Deploy notes' ELSE 'Notes' END, 2)
        ) AS s(ord, anchor, path, lvl)
       WHERE p.workspace_id = ${ws.id}`)
  }
  // the rare word: three pages in the first workspace
  await db.execute(sql`
    UPDATE page_texts SET text = text || ' zanzibar quokka'
     WHERE page_id IN (SELECT id FROM pages WHERE workspace_id = ${wss[0].id} AND sort_order::int IN (7, 70, 170))`)
  await db.execute(sql`ANALYZE pages`)
  await db.execute(sql`ANALYZE page_texts`)
  await db.execute(sql`ANALYZE page_chunks`)
  const token = await h.mintToken(user, 'notes', 'Bench Agent')
  // the headers mcpTools/core.ts call() sends: OAuth tokens are accepted only on the MCP path
  return { user, wss, headers: { authorization: `Bearer ${token}`, [MCP_INTERNAL_HEADER]: MCP_INTERNAL_SECRET } }
}

async function get(headers: Record<string, string>, url: string) {
  const r = await app.inject({ method: 'GET', url, headers })
  if (r.statusCode !== 200) throw new Error(`${url} ${r.statusCode} ${r.body.slice(0, 200)}`)
  return r
}
async function before(headers: Record<string, string>, q: string) {
  const list = (await get(headers, '/api/workspaces')).json() as { workspaces: { id: string }[] }
  let n = 0
  for (const w of list.workspaces) n += ((await get(headers, `/api/workspaces/${w.id}/search?q=${encodeURIComponent(q)}`)).json() as { pages: unknown[] }).pages.length
  return n
}
async function afterFlow(headers: Record<string, string>, q: string) {
  const r = (await get(headers, `/api/search?q=${encodeURIComponent(q)}`)).json() as { results: unknown[]; total: number }
  return { shown: r.results.length, total: r.total }
}
const pct = (t: number[], p: number) => [...t].sort((a, b) => a - b)[Math.min(t.length - 1, Math.floor(t.length * p))]

console.log(`pages: ${PAGES} per row, N=${N} per cell after 20 warm-up calls, ms (p50 / p95)`)
console.log('workspaces | term | before: list + W x /workspaces/:id/search | after: /api/search | rows before (shown) | after shown / total')
let prev: { id: string }[] = []
for (const w of COUNTS) {
  if (prev.length) await db.execute(sql`DELETE FROM pages WHERE workspace_id = ANY(${`{${prev.map((x) => x.id).join(',')}}`}::uuid[])`)
  const { wss, headers } = await seed(w)
  prev = wss
  for (const q of TERMS) {
    for (let i = 0; i < 20; i++) {
      await before(headers, q)
      await afterFlow(headers, q)
    }
    const tb: number[] = []
    const ta: number[] = []
    let rowsBefore = 0
    let rowsAfter = { shown: 0, total: 0 }
    for (let i = 0; i < N; i++) {
      // interleaved, alternating which goes first
      const runs: [number[], () => Promise<void>][] = [
        [tb, async () => { rowsBefore = await before(headers, q) }],
        [ta, async () => { rowsAfter = await afterFlow(headers, q) }],
      ]
      if (i % 2) runs.reverse()
      for (const [t, fn] of runs) {
        const a = performance.now()
        await fn()
        t.push(performance.now() - a)
      }
    }
    const f = (t: number[]) => `${pct(t, 0.5).toFixed(2)} / ${pct(t, 0.95).toFixed(2)}`
    console.log(`${w} | ${q} | ${f(tb)} | ${f(ta)} | ${rowsBefore} | ${rowsAfter.shown} / ${rowsAfter.total}`)
  }
}
await collab.destroyCollab()
await app.close()
await closeDb()
process.exit(0)
