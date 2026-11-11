// LIMIT_TRASH_DAYS (0.22 integration, contract §13, docs/adr/2525-*): trashed pages are kept
// min(workspace setting, cap) days.
//  - Unset: the pages the hourly purge deletes are exactly those the 0.21.1 query picks, on the same rows.
//  - Set: the cap wins over a longer workspace setting; a shorter workspace setting wins over the cap.
//  - The settings route refuses a longer retention than the cap (and takes one up to it); /auth/mode says it.
// The purge is global, so this file has a database of its own.
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { after, describe, it } from 'node:test'

const HAS_DB = !!process.env.DATABASE_URL

describe('[db] LIMIT_TRASH_DAYS caps how long trashed pages are kept', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const kit = await import('./restrictedTestKit')
  const drop = await kit.scratchDatabase('trashdays')
  const { db } = await import('../db/index')
  const schema = await import('../db/schema')
  const { inArray, sql } = await import('drizzle-orm')
  const { purgeOldTrash } = await import('../housekeeping')
  const { setLimitsForTests, limits, parseLimitsEnv, effectiveTrashDays } = await import('../limits')
  const { createSession, SESSION_COOKIE } = await import('../auth')
  const { generateInviteCodeColumns } = await import('../helpers')
  const app = await kit.buildRestrictedApp()
  after(async () => {
    await app.close()
    await drop()
  })

  const tag = () => randomBytes(4).toString('hex')
  const DAY = 86_400_000
  const now = new Date()
  const AGES = [3, 6.5, 8, 13, 15, 29, 31, 59, 61, 200]

  const [owner] = await db.insert(schema.users).values({ email: `trash-${tag()}@t.t`, name: 'Trash owner', passwordHash: 'x' }).returning()
  const cookie = `${SESSION_COOKIE}=${(await createSession(owner.id)).token}`

  /** Workspaces with the given retention, each with one trashed page per age, plus one live page. */
  async function seed(retentions: number[]) {
    const out: { id: string; retention: number; pages: { id: string; age: number }[] }[] = []
    for (const retention of retentions) {
      const id = randomUUID()
      await db.insert(schema.workspaces).values({ id, name: `T ${tag()}`, trashRetentionDays: retention, ...(await generateInviteCodeColumns(db, id)) })
      await db.insert(schema.workspaceMembers).values({ workspaceId: id, userId: owner.id, role: 'owner' })
      const rows = await db
        .insert(schema.pages)
        .values([
          ...AGES.map((age) => ({ workspaceId: id, title: `age ${age}`, createdBy: owner.id, deletedAt: new Date(now.getTime() - age * DAY) })),
          { workspaceId: id, title: 'live', createdBy: owner.id },
        ])
        .returning({ id: schema.pages.id, title: schema.pages.title })
      out.push({ id, retention, pages: rows.filter((r) => r.title !== 'live').map((r) => ({ id: r.id, age: Number(r.title.slice(4)) })) })
    }
    return out
  }

  /** The 0.21.1 selection, verbatim (housekeeping.ts before LIMIT_TRASH_DAYS), on the given workspaces. */
  async function selection0211(workspaceIds: string[]): Promise<string[]> {
    const rows = (await db.execute(sql`
      SELECT p.id FROM pages p JOIN workspaces w ON w.id = p.workspace_id
       WHERE p.deleted_at IS NOT NULL
         AND p.deleted_at < ${now.toISOString()}::timestamptz - make_interval(days => w.trash_retention_days)
         AND p.workspace_id IN (${sql.join(workspaceIds.map((id) => sql`${id}::uuid`), sql`, `)})
    `)) as unknown as { id: string }[]
    return rows.map((r) => r.id).sort()
  }

  async function remaining(ids: string[]): Promise<Set<string>> {
    const rows = await db.select({ id: schema.pages.id }).from(schema.pages).where(inArray(schema.pages.id, ids))
    return new Set(rows.map((r) => r.id))
  }

  it('the setting: unset and empty are no cap; below 7 or not a whole number refuses to boot', () => {
    assert.equal(limits.trashDays, undefined)
    assert.ok(!('trashDays' in parseLimitsEnv({})))
    assert.ok(!('trashDays' in parseLimitsEnv({ LIMIT_TRASH_DAYS: '' })))
    assert.equal(parseLimitsEnv({ LIMIT_TRASH_DAYS: '7' }).trashDays, 7)
    for (const v of ['6', '0', '-7', '7.5', 'week']) assert.throws(() => parseLimitsEnv({ LIMIT_TRASH_DAYS: v }), /LIMIT_TRASH_DAYS=/)
    assert.equal(effectiveTrashDays(30), 30)
    const restore = setLimitsForTests({ trashDays: 7 })
    try {
      assert.equal(effectiveTrashDays(30), 7)
      assert.equal(effectiveTrashDays(7), 7)
    } finally {
      restore()
    }
    assert.ok(!('trashDays' in limits), 'restore drops the key again')
  })

  it('unset: the purge deletes exactly what the 0.21.1 query picks on the same rows', async () => {
    const ws = await seed([7, 14, 30, 60, 365])
    const all = ws.flatMap((w) => w.pages.map((p) => p.id))
    const picked = await selection0211(ws.map((w) => w.id))
    // the 0.21.1 rule, spelled out: older than the workspace's own retention
    const byRule = ws.flatMap((w) => w.pages.filter((p) => p.age > w.retention).map((p) => p.id)).sort()
    assert.deepEqual(picked, byRule)
    await purgeOldTrash(now, () => undefined)
    const left = await remaining(all)
    assert.deepEqual(all.filter((id) => !left.has(id)).sort(), picked)
  })

  it('set: the cap wins over a longer workspace setting, a shorter workspace setting wins over the cap', async () => {
    const ws = await seed([7, 10, 14, 30, 365])
    const all = ws.flatMap((w) => w.pages.map((p) => p.id))
    const restore = setLimitsForTests({ trashDays: 14 })
    try {
      await purgeOldTrash(now, () => undefined)
    } finally {
      restore()
    }
    const left = await remaining(all)
    for (const w of ws) {
      const kept = Math.min(w.retention, 14)
      for (const p of w.pages) assert.equal(left.has(p.id), p.age <= kept, `retention ${w.retention}, age ${p.age}`)
    }
    // the live pages are untouched
    const live = (await db.execute(sql`SELECT count(*)::int AS n FROM pages WHERE deleted_at IS NULL AND workspace_id IN (${sql.join(ws.map((w) => sql`${w.id}::uuid`), sql`, `)})`)) as unknown as { n: number }[]
    assert.equal(Number(live[0].n), ws.length)
  })

  it('settings: a longer retention than the cap is refused with the cap, one up to it is taken; /auth/mode says the cap', async () => {
    const [w] = await seed([30])
    const patch = (days: number) => app.inject({ method: 'PATCH', url: `/api/workspaces/${w.id}/settings`, headers: { cookie }, payload: { trashRetentionDays: days } })
    // unset: anything the schema allows, as in 0.21.1
    assert.equal((await patch(365)).statusCode, 200)
    assert.ok(!('limits' in ((await app.inject({ method: 'GET', url: '/api/auth/mode' })).json() as object)))
    const restore = setLimitsForTests({ trashDays: 14 })
    try {
      const refused = await patch(15)
      assert.equal(refused.statusCode, 400)
      assert.deepEqual((refused.json() as { error: { code: string; limit: number } }).error.code, 'LIMIT_TRASH_DAYS')
      assert.equal((refused.json() as { error: { limit: number } }).error.limit, 14)
      assert.equal((await patch(14)).statusCode, 200)
      assert.equal((await patch(7)).statusCode, 200)
      const mode = (await app.inject({ method: 'GET', url: '/api/auth/mode' })).json() as { limits?: { trashDays?: number } }
      assert.deepEqual(mode.limits, { trashDays: 14 })
      // other settings still save while the stored retention is above the cap
      await db.update(schema.workspaces).set({ trashRetentionDays: 30 }).where(sql`id = ${w.id}`)
      const other = await app.inject({ method: 'PATCH', url: `/api/workspaces/${w.id}/settings`, headers: { cookie }, payload: { reviewIntervalDays: 14 } })
      assert.equal(other.statusCode, 200, other.body)
    } finally {
      restore()
    }
  })
})
