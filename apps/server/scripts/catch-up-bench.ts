/**
 * catch_up at scale (docs/adr/1520-*, docs/PERFORMANCE.md): one workspace with PAGES pages and
 * CHANGES change-log rows in the last 12 hours by six people (some through agents), plus comments,
 * inbox items and dated tasks. Measures readCatchUp latency and output tokens per budget.
 *   cd apps/server && DATABASE_URL=postgres://…/throwaway npx tsx scripts/catch-up-bench.ts [pages] [changes]
 */
import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { db, closeDb } from '../src/db/index'
import * as schema from '../src/db/schema'
import { readCatchUp } from '../src/catchUp'
import { estimateTokens } from '../src/context/tokens'
import { generateInviteCodeColumns } from '../src/helpers'

const PAGES = Number(process.argv[2] ?? 2500)
const CHANGES = Number(process.argv[3] ?? 6000)
const tag = randomUUID().slice(0, 8)

const users = []
for (let i = 0; i < 6; i++) {
  const [u] = await db.insert(schema.users).values({ email: `bench-${i}-${tag}@t.t`, name: `Person ${i}`, passwordHash: 'x' }).returning()
  users.push(u)
}
const me = users[0]
const wsId = randomUUID()
await db.insert(schema.workspaces).values({ id: wsId, name: `Bench ${tag}`, ...(await generateInviteCodeColumns(db, wsId)) })
await db.insert(schema.workspaceMembers).values(users.map((u, i) => ({ workspaceId: wsId, userId: u.id, role: i === 0 ? ('owner' as const) : ('member' as const) })))
await db.execute(sql`
  INSERT INTO pages (workspace_id, title, kind, scope, created_by, sort_order)
  SELECT ${wsId}::uuid, 'Bench page ' || g, 'doc', 'shared', ${users[1 + 0].id}::uuid, g FROM generate_series(1, ${PAGES}) g`)
const pageIds = ((await db.execute(sql`SELECT id FROM pages WHERE workspace_id = ${wsId} ORDER BY sort_order`)) as unknown as { id: string }[]).map((r) => r.id)
const text = (k: number) => `Paragraph ${k}: the deployment checklist was reviewed and the rollback steps were updated. `.repeat(4)
const t0 = Date.now() - 12 * 3_600_000
const rows = []
for (let i = 0; i < CHANGES; i++) {
  // a skewed distribution: a few hot pages get most edits
  const p = pageIds[Math.floor(Math.pow(Math.random(), 3) * Math.min(2000, pageIds.length))]
  const actor = users[Math.random() < 0.2 ? 0 : 1 + Math.floor(Math.random() * 5)]
  const a = `s${1 + Math.floor(Math.random() * 5)}`
  rows.push({
    workspaceId: wsId, pageId: p, anchor: a, headingPath: `Section ${a}`, kind: 'modified', scope: 'shared',
    beforeText: text(i), afterText: `${text(i)}\nAdded line ${i}.`, actorId: actor.id, viaClient: Math.random() < 0.3 ? 'Claude' : null,
    changedAt: new Date(t0 + (i / CHANGES) * 12 * 3_600_000),
  })
}
for (let i = 0; i < rows.length; i += 1000) await db.insert(schema.pageChanges).values(rows.slice(i, i + 1000))
const comments = []
for (let i = 0; i < 400; i++) {
  const id = randomUUID()
  const root = i % 4 === 0 || comments.length === 0 ? id : comments[comments.length - 1].threadId
  comments.push({ id, pageId: pageIds[i % 300], blockId: 'b', threadId: root, authorId: users[1 + (i % 5)].id, body: `Comment ${i}: can we double-check the numbers in this section?`, createdAt: new Date(t0 + i * 60_000) })
}
await db.insert(schema.comments).values(comments)
await db.insert(schema.notifications).values(Array.from({ length: 30 }, (_, i) => ({ userId: me.id, type: 'comment_mention' as const, pageId: pageIds[i], workspaceId: wsId, actorId: users[1].id, excerpt: `@Person 0 please check ${i}`, createdAt: new Date(t0 + i * 600_000) })))
const day = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10)
await db.insert(schema.pageTasks).values(Array.from({ length: 200 }, (_, i) => ({ pageId: pageIds[i], workspaceId: wsId, blockId: `t${i}`, text: `Task ${i}`, due: day((i % 21) - 10), checked: i % 5 === 0 })))

const since = new Date(t0 - 60_000).toISOString()
const med = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]
console.log(JSON.stringify({ pages: PAGES, changes: CHANGES, comments: 400, inbox: 30, tasks: 200 }))
for (const budget of [4000, 12000]) {
  const times: number[] = []
  let res
  for (let i = 0; i < 6; i++) {
    const t = performance.now()
    res = await readCatchUp({ userId: me.id, connection: null, workspaceId: wsId }, { since, workspaceId: wsId, budget, advance: false })
    times.push(performance.now() - t)
  }
  console.log(JSON.stringify({ budget, medianMs: +med(times.slice(1)).toFixed(0), firstMs: +times[0].toFixed(0), outputTokens: estimateTokens(res!.text), counts: res!.counts }))
}
// all workspaces of the person (no filter)
{
  const t = performance.now()
  const r = await readCatchUp({ userId: me.id, connection: null, workspaceId: null }, { since, budget: 4000, advance: false })
  console.log(JSON.stringify({ allWorkspaces: true, ms: +(performance.now() - t).toFixed(0), outputTokens: estimateTokens(r.text) }))
  if (process.env.SHOW) console.log(r.text)
}
await closeDb()
