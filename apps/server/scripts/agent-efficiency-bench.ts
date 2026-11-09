/**
 * Several agents at once (docs/adr/1550-* .. 1552-*, docs/PERFORMANCE.md):
 *
 *  A. find_context: three agent connections of one person ask the same QUESTIONS (each question
 *     ROUNDS times per agent, interleaved) in a workspace of PAGES pages × 6 sections. Cache off
 *     (the path before 0.12) vs on: tool latency p50/p95, hit rate. Then one page is edited and
 *     reindexed: the next call must miss and show the new text.
 *  B. changes_since: three agents watch the workspace for SECONDS while a person edits a page every
 *     EDIT_EVERY seconds. Polling every POLL seconds vs wait=25: tool calls, database transactions
 *     (pg_stat_database.xact_commit of this database) and the delay from commit to the agent seeing it.
 *
 *   cd apps/server && DATABASE_URL=postgres://…/throwaway npx tsx scripts/agent-efficiency-bench.ts [pages] [seconds]
 */
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.APP_URL ||= 'https://notes.example.com'

import { eq, sql } from 'drizzle-orm'
import { db, closeDb } from '../src/db/index'
import * as schema from '../src/db/schema'
import * as h from '../src/mcpTools/testHarness'
import { reindexPageChunks } from '../src/context/chunkIndex'
import { drainChangeLog } from '../src/context/changeLog'
import { _resetContextCache, contextCacheStats, setContextCacheEnabled } from '../src/context/contextCache'
import { blocksToStateBuffer } from '../src/md/convert'
import { sha256 } from '../src/oauth'
import { usageFor, _resetUsage } from '../src/connectionUsage'

const PAGES = Number(process.argv[2] ?? 1500)
const SECONDS = Number(process.argv[3] ?? 40)
const ROUNDS = 5
const EDIT_EVERY = 8
const POLL = 2
const QUESTIONS = [
  'rollback checklist', 'deployment canary', 'database migration timeout', 'on-call escalation', 'backup restore test',
  '배포 체크리스트', 'incident review owner', 'cache invalidation rule', 'release notes draft', 'api rate limit',
]
const WORDS = ['deployment', 'rollback', 'checklist', 'canary', 'database', 'migration', 'timeout', 'escalation', 'backup', 'restore',
  'incident', 'review', 'owner', 'cache', 'invalidation', 'release', 'notes', 'rate', 'limit', '배포', '체크리스트', '장애', '회고']

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : 0
}
const ms = (n: number) => `${n.toFixed(1)} ms`
let seed = 7
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648)
const sentence = () => Array.from({ length: 24 }, () => WORDS[Math.floor(rnd() * WORDS.length)]).join(' ') + '.'
type Blocks = Parameters<typeof h.makeDocPage>[3]
const doc = (n: number, extra = ''): Blocks =>
  Array.from({ length: 6 }, (_, s) => [
    { type: 'heading', props: { level: 2 }, content: [{ type: 'text', text: `Section ${n}.${s}`, styles: {} }] },
    { type: 'paragraph', content: [{ type: 'text', text: `${sentence()} ${sentence()} ${s === 0 ? extra : ''}`, styles: {} }] },
  ]).flat() as Blocks

const app = await h.buildTestApp()
const owner = await h.makeUser('Bench Owner')
const editor = await h.makeUser('Bench Editor')
const ws = await h.makeWorkspace(owner, [editor])
console.log(`seeding ${PAGES} pages…`)
const t0 = Date.now()
const pageIds: string[] = []
for (let i = 0; i < PAGES; i++) {
  const blocks = doc(i)
  const p = await h.makeDocPage(ws.id, owner.id, `Bench page ${i}`, blocks)
  await reindexPageChunks(p.id, blocks as never)
  pageIds.push(p.id)
}
await drainChangeLog(500)
console.log(`seeded in ${((Date.now() - t0) / 1000).toFixed(1)} s`)

async function agentOf(name: string) {
  const token = await h.mintToken(owner, 'notes', name)
  const [g] = await db.select({ id: schema.oauthGrants.id, clientId: schema.oauthGrants.clientId }).from(schema.oauthGrants).where(eq(schema.oauthGrants.accessHash, sha256(token)))
  const m = await h.connectMcp(app, owner, token, { user: { ...owner, via: name, grantId: g.id, clientId: g.clientId } })
  return { ...m, grantId: g.id }
}
const agents = [await agentOf('Agent A'), await agentOf('Agent B'), await agentOf('Agent C')]

// ---------------------------------------------------------------- A. find_context
async function runA(cacheOn: boolean) {
  setContextCacheEnabled(cacheOn)
  _resetContextCache()
  const lat: number[] = []
  for (let r = 0; r < ROUNDS; r++) {
    for (const q of QUESTIONS) {
      for (const a of agents) {
        const s = performance.now()
        const out = await a.tool('find_context', { query: q })
        lat.push(performance.now() - s)
        if (out.isError) throw new Error(out.text)
      }
    }
  }
  return { lat, hits: contextCacheStats.hits, misses: contextCacheStats.misses }
}
// warm-up (plans, connection pool)
await runA(false)
const results: Record<string, Awaited<ReturnType<typeof runA>>> = {}
for (const round of [1, 2]) {
  for (const on of [false, true]) {
    const r = await runA(on)
    const k = on ? 'on' : 'off'
    results[k] = results[k] ? { lat: [...results[k].lat, ...r.lat], hits: results[k].hits + r.hits, misses: results[k].misses + r.misses } : r
    console.log(`A round ${round} cache ${k}: ${r.lat.length} calls, p50 ${ms(pct(r.lat, 50))}, p95 ${ms(pct(r.lat, 95))}, hits ${r.hits}/${r.hits + r.misses}`)
  }
}
for (const k of ['off', 'on']) {
  const r = results[k]
  console.log(`A total cache ${k}: ${r.lat.length} calls, p50 ${ms(pct(r.lat, 50))}, p95 ${ms(pct(r.lat, 95))}, mean ${ms(r.lat.reduce((a, b) => a + b, 0) / r.lat.length)}, hit rate ${((100 * r.hits) / Math.max(1, r.hits + r.misses)).toFixed(1)}%`)
}

// invalidation right after an edit
setContextCacheEnabled(true)
_resetContextCache()
const target = pageIds[3]
await agents[0].tool('find_context', { query: 'rollback checklist' })
await agents[0].tool('find_context', { query: 'rollback checklist' })
const newBlocks = doc(3, 'rollback checklist zanzibar-marker')
await db.update(schema.pageDocs).set({ state: blocksToStateBuffer(newBlocks as never) }).where(eq(schema.pageDocs.pageId, target))
await reindexPageChunks(target, newBlocks as never)
const before = { ...contextCacheStats }
const after = await agents[1].tool('find_context', { query: 'rollback checklist zanzibar-marker' })
const after2 = await agents[0].tool('find_context', { query: 'rollback checklist' })
console.log(
  `A invalidation: after the edit ${contextCacheStats.misses - before.misses} miss(es), ${contextCacheStats.hits - before.hits} hit(s); ` +
    `new text found: ${/zanzibar-marker/.test(after.text)} / ${/zanzibar-marker/.test(after2.text)}`,
)

// ---------------------------------------------------------------- B. changes_since
const xacts = async () =>
  Number(((await db.execute(sql`SELECT xact_commit::text AS x FROM pg_stat_database WHERE datname = current_database()`)) as unknown as { x: string }[])[0].x)

async function runB(mode: 'poll' | 'wait') {
  _resetUsage()
  const cursors = await Promise.all(agents.map(async (a) => /cursor: (\S+)$/m.exec((await a.tool('changes_since', { workspaceId: ws.id })).text)![1]))
  const seen: number[] = []
  const commits: number[] = []
  let calls = 0
  const stopAt = Date.now() + SECONDS * 1000
  const x0 = await xacts()
  const watchers = agents.map(async (a, i) => {
    let cursor = cursors[i]
    while (Date.now() < stopAt) {
      const left = Math.ceil((stopAt - Date.now()) / 1000)
      const r = await a.tool('changes_since', mode === 'wait' ? { cursor, workspaceId: ws.id, wait: Math.min(25, Math.max(1, left)), detail: 'none' } : { cursor, workspaceId: ws.id, detail: 'none' })
      calls++
      cursor = /next cursor: (\S+)$/m.exec(r.text)![1]
      if (/ change(s)? in /.test(r.text)) seen.push(Date.now())
      if (mode === 'poll') await new Promise((res) => setTimeout(res, POLL * 1000))
    }
  })
  const writer = (async () => {
    let n = 0
    while (Date.now() < stopAt - 2_000) {
      await new Promise((res) => setTimeout(res, EDIT_EVERY * 1000))
      const blocks = doc(5, `edit ${mode} ${n++}`)
      await db.update(schema.pageDocs).set({ state: blocksToStateBuffer(blocks as never) }).where(eq(schema.pageDocs.pageId, pageIds[5]))
      await reindexPageChunks(pageIds[5], blocks as never) // queues the change row; the consumer is kicked on commit
      commits.push(Date.now())
    }
  })()
  await Promise.all([...watchers, writer])
  const x1 = await xacts()
  // delay: for each commit, the first time each agent saw something after it
  const delays: number[] = []
  for (const c of commits) {
    const after = seen.filter((s) => s >= c).sort((a, b) => a - b).slice(0, agents.length)
    for (const s of after) delays.push(s - c)
  }
  const wait = agents.map((a) => usageFor(`grant:${a.grantId}`)!)
  return { calls, xacts: x1 - x0, edits: commits.length, delays, latencyMax: Math.max(...wait.map((u) => u.maxMs)), waitSec: wait.reduce((s, u) => s + u.waitMs, 0) / 1000 }
}
for (const mode of ['poll', 'wait'] as const) {
  const r = await runB(mode)
  console.log(
    `B ${mode === 'poll' ? `poll every ${POLL} s` : 'wait=25'}: ${SECONDS} s, 3 agents, ${r.edits} edits → ${r.calls} tool calls ` +
      `(${((r.calls / SECONDS) * 60).toFixed(0)}/min), ${r.xacts} db transactions (incl. the edits), ` +
      `seen after p50 ${pct(r.delays, 50)} ms / max ${Math.max(0, ...r.delays)} ms; usage: wait ${r.waitSec.toFixed(1)} s, max latency ${r.latencyMax} ms`,
  )
}

for (const a of agents) await a.close()
await app.close()
await closeDb()
