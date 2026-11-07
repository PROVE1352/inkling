// Workspace settings bundle (docs/adr/0945-* .. 0952-*): admin role matrix, member-add policy and
// invite link toggle, audit log (same transaction, filters, pagination, retention), public sharing
// switch and bulk unpublish, export policy, trash retention, per-workspace agent blocks enforced
// through MCP, document owner / review and the daily review_due webhook digest.
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.DATA_DIR ||= `${process.env.TMPDIR || '/tmp'}/inkling-wssettings-${process.pid}`

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, describe, it } from 'node:test'

const HAS_DB = !!process.env.DATABASE_URL

describe('[db] workspace settings, audit log and agent blocks', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const h = await import('./mcpTools/testHarness')
  const { db, closeDb } = await import('./db/index')
  const schema = await import('./db/schema')
  const { eq, and, sql } = await import('drizzle-orm')
  const collab = await import('./collab')
  const { purgeOldTrash, purgeOldAuditEvents } = await import('./housekeeping')
  const { scanReviewDigests, reviewFactsFor, localISODate } = await import('./review')
  const { countReads, flushReads, purgeOldReads, _bufferedReads } = await import('./pageReads')
  const { invalidateWebhookCache } = await import('./webhooks')
  const { _resetAgentTouches } = await import('./agentAccess')
  const app = await h.buildTestApp()

  after(async () => {
    await collab.destroyCollab()
    await app.close()
    await closeDb()
  })

  type U = Awaited<ReturnType<typeof h.makeUser>>
  const req = (u: U, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
    app.inject({ method, url: `/api${url}`, headers: { cookie: u.cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) })

  async function team() {
    const owner = await h.makeUser('owner')
    const admin = await h.makeUser('admin')
    const member = await h.makeUser('member')
    const ws = await h.makeWorkspace(owner, [admin, member])
    await db
      .update(schema.workspaceMembers)
      .set({ role: 'admin' })
      .where(and(eq(schema.workspaceMembers.workspaceId, ws.id), eq(schema.workspaceMembers.userId, admin.id)))
    return { owner, admin, member, ws }
  }
  const audit = async (wsId: string) =>
    db
      .select()
      .from(schema.workspaceAuditEvents)
      .where(eq(schema.workspaceAuditEvents.workspaceId, wsId))
      .orderBy(schema.workspaceAuditEvents.id)

  it('role matrix: admins manage members and links but not roles, settings or owners', async () => {
    const { owner, admin, member, ws } = await team()
    const outsider = await h.makeUser('outsider')
    // admin sees capabilities and the invite code; members do not
    const list = async (u: U) =>
      ((await req(u, 'GET', '/workspaces')).json() as { workspaces: { id: string; inviteCode: string; can: Record<string, boolean> }[] }).workspaces.find((w) => w.id === ws.id)!
    const a = await list(admin)
    assert.equal(a.can.manage, true)
    assert.equal(a.can.editSettings, false)
    assert.notEqual(a.inviteCode, '')
    const m = await list(member)
    assert.equal(m.can.manage, false)
    assert.equal(m.inviteCode, '')
    assert.equal((await list(owner)).can.editSettings, true)

    assert.equal((await req(admin, 'POST', `/workspaces/${ws.id}/invite/regenerate`)).statusCode, 200)
    assert.equal((await req(member, 'POST', `/workspaces/${ws.id}/invite/regenerate`)).statusCode, 403)
    assert.equal((await req(admin, 'PATCH', `/workspaces/${ws.id}/members/${member.id}`, { role: 'admin' })).statusCode, 403)
    assert.equal((await req(admin, 'PATCH', `/workspaces/${ws.id}/settings`, { exportPolicy: 'owners' })).statusCode, 403)
    assert.equal((await req(admin, 'PATCH', `/workspaces/${ws.id}`, { name: 'x' })).statusCode, 403)
    assert.equal((await req(admin, 'DELETE', `/workspaces/${ws.id}/members/${owner.id}`)).statusCode, 403)
    assert.equal((await req(member, 'GET', `/workspaces/${ws.id}/audit`)).statusCode, 403)
    assert.equal((await req(outsider, 'GET', `/workspaces/${ws.id}/settings`)).statusCode, 403)
    // owner promotes and renames with an icon; admin removes a plain member
    assert.equal((await req(owner, 'PATCH', `/workspaces/${ws.id}`, { name: 'Renamed', icon: '🚀' })).statusCode, 200)
    assert.equal((await req(admin, 'DELETE', `/workspaces/${ws.id}/members/${member.id}`)).statusCode, 204)

    const actions = (await audit(ws.id)).map((e) => e.action)
    assert.deepEqual(actions, ['invite.regenerated', 'workspace.updated', 'member.removed'])
    const upd = (await audit(ws.id))[1]
    assert.deepEqual(upd.after, { name: 'Renamed', icon: '🚀' })
    assert.equal(upd.actorName, owner.name)
  })

  it('member-add policy (default admins) and the invite link toggle (C-M3)', async () => {
    const { owner, admin, member, ws } = await team()
    const friend = await h.makeUser('friend')
    // friend shares another workspace with everyone, so they are a candidate
    await h.makeWorkspace(friend, [owner, admin, member])
    assert.equal((await req(member, 'POST', `/workspaces/${ws.id}/members`, { userId: friend.id })).statusCode, 403)
    assert.equal((await req(member, 'GET', `/workspaces/${ws.id}/member-candidates?q=friend`)).statusCode, 403)
    assert.equal((await req(admin, 'POST', `/workspaces/${ws.id}/members`, { userId: friend.id })).statusCode, 200)
    assert.equal((await req(admin, 'DELETE', `/workspaces/${ws.id}/members/${friend.id}`)).statusCode, 204)
    assert.equal((await req(owner, 'PATCH', `/workspaces/${ws.id}/settings`, { memberAddPolicy: 'members' })).statusCode, 200)
    assert.equal((await req(member, 'POST', `/workspaces/${ws.id}/members`, { userId: friend.id })).statusCode, 200)

    // invite link off → join and preview answer like a wrong code
    const joiner = await h.makeUser('joiner')
    // the database keeps only the code's hash (docs/adr/1110-*): take the code the owner sees
    const code = ((await req(owner, 'GET', '/workspaces')).json() as { workspaces: { id: string; inviteCode: string }[] }).workspaces.find((w) => w.id === ws.id)!.inviteCode
    assert.match(code, /^[A-Z2-9]{10}$/)
    assert.equal((await req(owner, 'PATCH', `/workspaces/${ws.id}/settings`, { inviteLinkEnabled: false })).statusCode, 200)
    const off = await req(joiner, 'POST', '/workspaces/join', { inviteCode: code })
    assert.equal(off.statusCode, 404)
    assert.equal((off.json() as { error: { code: string } }).error.code, 'INVALID_CODE')
    assert.equal((await req(joiner, 'GET', `/workspaces/invite-preview?code=${code}`)).statusCode, 404)
    assert.equal(((await req(admin, 'GET', '/workspaces')).json() as { workspaces: { id: string; inviteCode: string }[] }).workspaces.find((w) => w.id === ws.id)!.inviteCode, '')
    assert.equal((await req(owner, 'PATCH', `/workspaces/${ws.id}/settings`, { inviteLinkEnabled: true })).statusCode, 200)
    assert.equal((await req(joiner, 'POST', '/workspaces/join', { inviteCode: code })).statusCode, 200)

    const ev = await audit(ws.id)
    assert.deepEqual(
      ev.map((e) => e.action),
      ['member.added', 'member.removed', 'settings.updated', 'member.added', 'settings.updated', 'settings.updated', 'member.joined'],
    )
    assert.deepEqual(ev[2].before, { memberAddPolicy: 'admins' })
    assert.deepEqual(ev[2].after, { memberAddPolicy: 'members' })
  })

  it('audit rows exist only for committed actions; filter and cursor pagination', async () => {
    const { owner, admin, ws } = await team()
    // the last owner cannot demote themselves: the action fails, nothing is logged
    assert.equal((await req(owner, 'PATCH', `/workspaces/${ws.id}/members/${owner.id}`, { role: 'member' })).statusCode, 400)
    assert.equal((await audit(ws.id)).length, 0)
    for (let i = 0; i < 5; i++) await req(admin, 'POST', `/workspaces/${ws.id}/invite/regenerate`)
    await req(owner, 'PATCH', `/workspaces/${ws.id}/members/${admin.id}`, { role: 'member' })
    const p1 = (await req(owner, 'GET', `/workspaces/${ws.id}/audit?limit=4`)).json() as { events: { id: string; action: string }[]; nextCursor: string | null; retentionDays: number }
    assert.equal(p1.events.length, 4)
    assert.equal(p1.events[0].action, 'member.role_changed')
    assert.equal(p1.retentionDays, 90)
    assert.ok(p1.nextCursor)
    const p2 = (await req(owner, 'GET', `/workspaces/${ws.id}/audit?limit=4&cursor=${p1.nextCursor}`)).json() as { events: { id: string }[]; nextCursor: string | null }
    assert.equal(p2.events.length, 2)
    assert.equal(p2.nextCursor, null)
    const f = (await req(owner, 'GET', `/workspaces/${ws.id}/audit?action=member`)).json() as { events: { action: string }[] }
    assert.deepEqual(f.events.map((e) => e.action), ['member.role_changed'])
    const byActor = (await req(owner, 'GET', `/workspaces/${ws.id}/audit?actorId=${admin.id}`)).json() as { events: unknown[] }
    assert.equal(byActor.events.length, 5)
  })

  it('audit retention purge uses each workspace setting', async () => {
    const { owner, ws } = await team()
    await req(owner, 'PATCH', `/workspaces/${ws.id}/settings`, { auditRetentionDays: 30 })
    const old = new Date(Date.now() - 40 * 86_400_000)
    await db.insert(schema.workspaceAuditEvents).values({ workspaceId: ws.id, actorName: 'x', action: 'invite.regenerated', createdAt: old })
    const other = await team()
    await db.insert(schema.workspaceAuditEvents).values({ workspaceId: other.ws.id, actorName: 'x', action: 'invite.regenerated', createdAt: old })
    await purgeOldAuditEvents(new Date())
    const left = await db.execute(sql`select workspace_id from workspace_audit_events where created_at = ${old.toISOString()}::timestamptz and workspace_id in (${ws.id}::uuid, ${other.ws.id}::uuid)`)
    // 40 days: gone where retention is 30, kept where it is the default 90
    assert.deepEqual((left as unknown as { workspace_id: string }[]).map((r) => r.workspace_id), [other.ws.id])
  })

  it('public sharing switch, bulk unpublish and the shared list', async () => {
    const { owner, admin, member, ws } = await team()
    const [p1] = await db.insert(schema.pages).values({ workspaceId: ws.id, title: 'P1', createdBy: owner.id }).returning()
    const [p2] = await db.insert(schema.pages).values({ workspaceId: ws.id, title: 'P2', createdBy: owner.id }).returning()
    const [p3] = await db.insert(schema.pages).values({ workspaceId: ws.id, title: 'P3', createdBy: owner.id }).returning()
    assert.equal((await req(member, 'POST', `/pages/${p1.id}/share`)).statusCode, 403)
    for (const p of [p1, p2, p3]) assert.equal((await req(admin, 'POST', `/pages/${p.id}/share`)).statusCode, 200)
    const shared = (await req(admin, 'GET', `/workspaces/${ws.id}/shared`)).json() as { canManage: boolean; items: unknown[] }
    assert.equal(shared.canManage, true)
    assert.equal(shared.items.length, 3)
    assert.equal((await req(admin, 'POST', `/workspaces/${ws.id}/shared/unpublish`, { pageIds: [p1.id] })).statusCode, 200)
    // switch on without unpublishing: existing links stay, new ones are refused
    await req(owner, 'PATCH', `/workspaces/${ws.id}/settings`, { publicSharingDisabled: true })
    const refused = await req(admin, 'POST', `/pages/${p1.id}/share`)
    assert.equal(refused.statusCode, 403)
    assert.equal((refused.json() as { error: { code: string } }).error.code, 'PUBLIC_SHARING_DISABLED')
    // re-publishing an already public page is idempotent and allowed
    assert.equal((await req(admin, 'POST', `/pages/${p2.id}/share`)).statusCode, 200)
    // turning it on again with unpublishExisting clears the rest in the same transaction
    await req(owner, 'PATCH', `/workspaces/${ws.id}/settings`, { publicSharingDisabled: false })
    const r = await req(owner, 'PATCH', `/workspaces/${ws.id}/settings`, { publicSharingDisabled: true, unpublishExisting: true })
    assert.equal((r.json() as { unpublished: number }).unpublished, 2)
    const tokens = await db.select({ t: schema.pages.shareToken }).from(schema.pages).where(eq(schema.pages.workspaceId, ws.id))
    assert.ok(tokens.every((x) => x.t === null))
    const actions = (await audit(ws.id)).map((e) => e.action)
    assert.deepEqual(actions, [
      'share.published', 'share.published', 'share.published', 'share.unpublished',
      'settings.updated', 'settings.updated', 'settings.updated',
    ])
    assert.deepEqual((await audit(ws.id)).at(-1)!.after, { publicSharingDisabled: true, unpublishedLinks: 2 })
  })

  it('export policy gates the workspace zip, not the per-page export; downloads are audited', async () => {
    const { owner, member, ws } = await team()
    const [p] = await db.insert(schema.pages).values({ workspaceId: ws.id, title: 'Doc', createdBy: owner.id }).returning()
    await req(owner, 'PATCH', `/workspaces/${ws.id}/settings`, { exportPolicy: 'owners' })
    assert.equal((await req(member, 'GET', `/workspaces/${ws.id}/export`)).statusCode, 403)
    assert.equal((await req(member, 'GET', `/pages/${p.id}/export?format=md`)).statusCode, 200)
    assert.equal((await req(owner, 'GET', `/workspaces/${ws.id}/export`)).statusCode, 200)
    assert.equal((await audit(ws.id)).at(-1)!.action, 'export.downloaded')
  })

  it('trash retention is per workspace and bounded', async () => {
    const { owner, ws } = await team()
    const other = await team()
    assert.equal((await req(owner, 'PATCH', `/workspaces/${ws.id}/settings`, { trashRetentionDays: 3 })).statusCode, 400)
    assert.equal((await req(owner, 'PATCH', `/workspaces/${ws.id}/settings`, { trashRetentionDays: 7 })).statusCode, 200)
    const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000)
    const [a] = await db.insert(schema.pages).values({ workspaceId: ws.id, title: 'old', createdBy: owner.id, deletedAt: tenDaysAgo }).returning()
    const [b] = await db.insert(schema.pages).values({ workspaceId: other.ws.id, title: 'old', createdBy: other.owner.id, deletedAt: tenDaysAgo }).returning()
    await purgeOldTrash(new Date(), () => {})
    const ids = (await db.select({ id: schema.pages.id }).from(schema.pages).where(sql`${schema.pages.id} in (${a.id}::uuid, ${b.id}::uuid)`)).map((r) => r.id)
    assert.deepEqual(ids, [b.id])
  })

  it('agent blocks: enforced per workspace for MCP tools and listed for managers', async () => {
    _resetAgentTouches()
    const { owner, admin, member, ws } = await team()
    const ws2 = await h.makeWorkspace(member)
    const token = await h.mintToken(member, 'read write', 'Claude Test')
    const mcp = await h.connectMcp(app, member, token)
    try {
      const created = await mcp.tool('create_page', { workspaceId: ws.id, title: 'Runbook', markdown: '# Deploy\nUse the blue lever.' })
      assert.equal(created.isError, false, created.text)
      const pageId = (JSON.parse(created.text) as { id: string }).id
      assert.equal((await mcp.tool('read_page', { pageId })).isError, false)

      // the connection reached ws → listed for managers, not for members
      const agents = (await req(admin, 'GET', `/workspaces/${ws.id}/agents`)).json() as {
        connections: { user: { id: string }; client: { id: string; name: string }; access: string; blocked: boolean }[]
      }
      assert.equal(agents.connections.length, 1)
      assert.equal(agents.connections[0].client.name, 'Claude Test')
      assert.equal(agents.connections[0].access, 'write')
      assert.equal((await req(member, 'GET', `/workspaces/${ws.id}/agents`)).statusCode, 403)

      // admin blocks this client for the member; owner's agents are off limits to admins
      const clientId = agents.connections[0].client.id
      assert.equal((await req(admin, 'POST', `/workspaces/${ws.id}/agents/blocks`, { userId: owner.id })).statusCode, 403)
      const blk = await req(admin, 'POST', `/workspaces/${ws.id}/agents/blocks`, { userId: member.id, clientId })
      assert.equal(blk.statusCode, 200)
      // idempotent
      assert.equal((await req(admin, 'POST', `/workspaces/${ws.id}/agents/blocks`, { userId: member.id, clientId })).statusCode, 200)

      const ls = await mcp.tool('list_workspaces')
      assert.ok(!ls.text.includes(ws.id), 'blocked workspace hidden from list_workspaces')
      assert.ok(ls.text.includes(ws2.id))
      const read = await mcp.tool('read_page', { pageId })
      assert.equal(read.isError, true)
      const lp = await mcp.tool('list_pages', { workspaceId: ws.id })
      assert.equal(lp.isError, true)
      assert.match(lp.text, /blocked this agent connection/)
      const fc = await mcp.tool('find_context', { query: 'blue lever' })
      assert.ok(!fc.text.includes(pageId), 'find_context across workspaces skips the blocked one')
      // other workspaces keep working
      assert.equal((await mcp.tool('create_page', { workspaceId: ws2.id, title: 'Elsewhere', markdown: 'ok' })).isError, false)
      // the member still works in the browser
      assert.equal((await req(member, 'GET', `/workspaces/${ws.id}/pages`)).statusCode, 200)

      const listed = (await req(owner, 'GET', `/workspaces/${ws.id}/agents`)).json() as { connections: { blocked: boolean }[]; blocks: { id: string }[] }
      assert.equal(listed.connections[0].blocked, true)
      assert.equal(listed.blocks.length, 1)
      assert.equal((await req(admin, 'DELETE', `/workspaces/${ws.id}/agents/blocks/${listed.blocks[0].id}`)).statusCode, 204)
      assert.equal((await mcp.tool('read_page', { pageId })).isError, false)
      // a block on "all agents" of the member also works
      await req(owner, 'POST', `/workspaces/${ws.id}/agents/blocks`, { userId: member.id })
      assert.equal((await mcp.tool('read_page', { pageId })).isError, true)
      assert.deepEqual(
        (await audit(ws.id)).map((e) => e.action),
        ['agent.blocked', 'agent.unblocked', 'agent.blocked'],
      )
    } finally {
      await mcp.close()
    }
  })

  it('document owner, review priority buckets (stale by score, archive, living); MCP output carries the facts', async () => {
    const { owner, member, ws } = await team()
    const outsider = await h.makeUser('outsider')
    const ago = (d: number) => new Date(Date.now() - d * 86_400_000)
    const mk = async (title: string, createdAt: Date, extra: Partial<typeof schema.pages.$inferInsert> = {}) =>
      (await db.insert(schema.pages).values({ workspaceId: ws.id, title, createdBy: owner.id, createdAt, updatedAt: createdAt, ...extra }).returning())[0]
    const A = await mk('Onboarding', ago(100))
    const B = await mk('Runbook', ago(100))
    const C = await mk('Old plan', ago(400))
    const D = await mk('Daily log', ago(100), { livingOverride: true })
    const E = await mk('Fresh', new Date())
    assert.equal((await req(member, 'PUT', `/pages/${A.id}/owner`, { ownerId: outsider.id })).statusCode, 400)
    const set = (await req(member, 'PUT', `/pages/${A.id}/owner`, { ownerId: member.id })).json() as { review: { owner: { id: string }; dueOn: string | null; priority: unknown } }
    assert.equal(set.review.owner.id, member.id)
    assert.equal(set.review.dueOn, null) // reminders off by default
    assert.equal(set.review.priority, null)

    // reads: A five times, B once (buffered, then flushed as page totals)
    for (let i = 0; i < 5; i++) countReads([A.id])
    countReads([B.id, B.id])
    assert.ok(_bufferedReads() >= 2)
    await flushReads()
    const [ra] = await db.select().from(schema.pageReads).where(eq(schema.pageReads.pageId, A.id))
    assert.equal(ra.count, 5)
    assert.equal(Object.keys(ra).includes('userId'), false)

    await req(owner, 'PATCH', `/workspaces/${ws.id}/settings`, { reviewIntervalDays: 30 })
    type Due = { items: { id: string; score: number; pStale: number; reads30: number; estMinutes: number }[]; archive: { id: string }[]; living: { id: string }[] }
    const due = (await req(member, 'GET', `/workspaces/${ws.id}/review-due`)).json() as Due
    // A: 5 reads × p(100 days, λ=ln2/30 ≈ 0.90) ranks above B: 1 read × 0.90
    assert.deepEqual(due.items.map((i) => i.id), [A.id, B.id])
    assert.equal(due.items[0].reads30, 5)
    assert.equal(due.items[0].pStale, 0.9)
    assert.equal(due.items[0].score, 4.5)
    assert.equal(due.items[0].estMinutes, 1)
    assert.deepEqual(due.archive.map((i) => i.id), [C.id])
    assert.deepEqual(due.living.map((i) => i.id), [D.id])
    assert.ok(![...due.items, ...due.archive, ...due.living].some((i) => i.id === E.id))
    const mine = (await req(member, 'GET', `/workspaces/${ws.id}/review-due?mine=1`)).json() as Due
    assert.deepEqual(mine.items.map((i) => i.id), [A.id])

    const facts = (await reviewFactsFor([A.id, E.id]))
    assert.equal(facts.get(A.id)!.owner, member.name)
    assert.equal(facts.get(A.id)!.stale, true)
    assert.equal(facts.get(A.id)!.p, 0.9)
    assert.equal(facts.get(E.id)!.stale, false)

    // read_page shows owner, dates and the rounded p (document values, no relative time)
    const token = await h.mintToken(member, 'read', 'Reader')
    const mcp = await h.connectMcp(app, member, token, { canWrite: false })
    try {
      const out = await mcp.tool('read_page', { pageId: A.id })
      assert.match(out.text, new RegExp(`- owner: ${member.name}`))
      assert.match(out.text, /- reviewDue: \d{4}-\d{2}-\d{2} \(stale, p=0\.90\)/)
      assert.doesNotMatch(out.text, /days ago/)
      assert.match((await mcp.tool('read_page', { pageId: D.id })).text, /- living: yes/)
      // review sign-off is a browser action; tokens never reach it
      const viaToken = await app.inject({ method: 'POST', url: `/api/pages/${A.id}/review`, headers: { authorization: `Bearer ${token}` } })
      assert.equal(viaToken.statusCode, 401)
    } finally {
      await mcp.close()
    }
    // the MCP read was counted (buffered)
    await flushReads()
    const [ra2] = await db.select().from(schema.pageReads).where(eq(schema.pageReads.pageId, A.id))
    assert.equal(ra2.count, 6)

    const marked = (await req(member, 'POST', `/pages/${A.id}/review`)).json() as { review: { stale: boolean; reviewedBy: { id: string }; priority: { pStale: number } } }
    assert.equal(marked.review.stale, false)
    assert.equal(marked.review.priority.pStale, 0)
    assert.equal(marked.review.reviewedBy.id, member.id)
    assert.equal((await reviewFactsFor([A.id])).get(A.id)!.reviewedOn, localISODate(new Date()))
    // living override back to automatic: D has no edits, so it is not living any more
    const lv = (await req(member, 'PUT', `/pages/${D.id}/living`, { living: null })).json() as { review: { livingOverride: boolean | null; priority: { living: boolean } } }
    assert.equal(lv.review.livingOverride, null)
    assert.equal(lv.review.priority.living, false)

    // read counters past 90 days are purged
    await db.insert(schema.pageReads).values({ pageId: B.id, day: localISODate(ago(100)), count: 3 })
    await purgeOldReads()
    const left = await db.select().from(schema.pageReads).where(eq(schema.pageReads.pageId, B.id))
    assert.deepEqual(left.map((r) => r.count), [1]) // duplicates in one call count once

    // leaving clears ownership
    await req(member, 'DELETE', `/workspaces/${ws.id}/members/${member.id}`)
    const [row] = await db.select({ ownerId: schema.pages.ownerId }).from(schema.pages).where(eq(schema.pages.id, A.id))
    assert.equal(row.ownerId, null)
  })

  it('review_due digest: once a day, shared pages only, delivered through the webhook', async () => {
    process.env.WEBHOOK_TEST_ALLOW_LOOPBACK = '1'
    const bodies: string[] = []
    let got: () => void = () => {}
    const received = new Promise<void>((resolve) => (got = resolve))
    const server = createServer((r, s) => {
      let b = ''
      r.on('data', (c) => (b += c))
      r.on('end', () => {
        bodies.push(b)
        s.writeHead(200).end('ok')
        got()
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const { owner, ws } = await team()
      const old = new Date(Date.now() - 400 * 86_400_000)
      const made = await db
        .insert(schema.pages)
        .values([
          { workspaceId: ws.id, title: 'Shared stale', createdBy: owner.id, ownerId: owner.id, createdAt: old, updatedAt: old },
          { workspaceId: ws.id, title: 'Private stale', createdBy: owner.id, ownerId: owner.id, createdAt: old, updatedAt: old, scope: 'private' },
        ])
        .returning({ id: schema.pages.id })
      // read recently → stale (to review), not archive candidates
      countReads(made.map((m) => m.id))
      await flushReads()
      await db.update(schema.workspaces).set({ reviewIntervalDays: 90 }).where(eq(schema.workspaces.id, ws.id))
      // no hook subscribed yet: nothing is claimed
      await scanReviewDigests(new Date())
      const [before1] = await db.select({ d: schema.workspaces.reviewDigestSentOn }).from(schema.workspaces).where(eq(schema.workspaces.id, ws.id))
      assert.equal(before1.d, null)
      const port = (server.address() as AddressInfo).port
      await db.insert(schema.workspaceWebhooks).values({ workspaceId: ws.id, kind: 'slack', url: `http://127.0.0.1:${port}/hook`, events: ['review_due'] })
      invalidateWebhookCache(ws.id)
      assert.ok((await scanReviewDigests(new Date())) >= 1)
      await received
      assert.equal(await scanReviewDigests(new Date()).then(() => bodies.length), 1)
      const text = (JSON.parse(bodies[0]) as { text: string }).text
      assert.match(text, /1 document is due for review/)
      assert.match(text, /Shared stale/)
      assert.doesNotMatch(text, /Private stale/)
      const [after1] = await db.select({ d: schema.workspaces.reviewDigestSentOn }).from(schema.workspaces).where(eq(schema.workspaces.id, ws.id))
      assert.equal(after1.d, localISODate(new Date()))
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      delete process.env.WEBHOOK_TEST_ALLOW_LOOPBACK
    }
  })
})
