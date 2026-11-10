// Team agents against a real database (docs/adr/1860-* .. 1866-*): which connections are targets
// (members only, live, in range, not blocked), comment hand-offs into one connection's inbox only,
// the person's copies setting, hand-back when the connection is revoked, agent assignment in person
// cells (stored next to the person, 0.14 shape kept), query_rows "this connection", agent chips in a
// to-do, the board with hidden titles, and catch_up(team) with its token cost.
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.APP_URL ||= 'https://notes.example.com'
process.env.DATA_DIR ||= `${process.env.TMPDIR || '/tmp'}/inkling-team-${process.pid}`
process.env.NOTIFY_MAIL_DELAY_MS = '3600000'

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

const HAS_DB = !!process.env.DATABASE_URL

describe('[db] team agents: hand-offs, agent assignments, board', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const h = await import('./mcpTools/testHarness')
  const { db, closeDb } = await import('./db/index')
  const schema = await import('./db/schema')
  const { sql } = await import('drizzle-orm')
  const { sha256 } = await import('./oauth')
  const engine = await import('./notify/engine')
  const { syncDocMentions } = await import('./notify/producers')
  const { readTeamAgents, handBackConnections } = await import('./teamAgents')
  const { estimateTokens } = await import('./context/tokens')
  const app = await h.buildTestApp()
  const closers: (() => Promise<void>)[] = []
  after(async () => {
    for (const c of closers) await c()
    await app.close()
    await closeDb()
  })

  type U = Awaited<ReturnType<typeof h.makeUser>>
  type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  const req = (u: U, method: Method, url: string, payload?: unknown) =>
    app.inject({ method, url: `/api${url}`, headers: { cookie: u.cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) })
  const para = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text, styles: {} }] }) as never

  /** A connection of `u` named `client`: its grant id, key, ref and an MCP client acting through it. */
  async function connection(u: U, client: string) {
    const token = await h.mintToken(u, 'notes', client)
    const [g] = (await db.execute(sql`SELECT id FROM oauth_grants WHERE access_hash = ${sha256(token)}`)) as unknown as { id: string }[]
    const key = `grant:${g.id}`
    const mcp = await h.connectMcp(app, { ...u, via: client, grantId: g.id }, token)
    closers.push(() => mcp.close())
    return { grantId: g.id, key, ref: `${u.id}/${key}`, short: `g:${g.id.slice(0, 8)}`, token, mcp }
  }

  let A: U, B: U, C: U
  let ws: { id: string }, ws2: { id: string }
  let bClaude: Awaited<ReturnType<typeof connection>>
  let bCursor: Awaited<ReturnType<typeof connection>>
  let aClaude: Awaited<ReturnType<typeof connection>>
  let cClaude: Awaited<ReturnType<typeof connection>>
  let bOther: Awaited<ReturnType<typeof connection>>
  let page: { id: string }

  before(async () => {
    A = await h.makeUser('Alice')
    B = await h.makeUser('Bob')
    C = await h.makeUser('Carol')
    ws = await h.makeWorkspace(A, [B])
    ws2 = await h.makeWorkspace(B, [])
    aClaude = await connection(A, 'Claude Code')
    bClaude = await connection(B, 'Claude Code')
    bCursor = await connection(B, 'Cursor')
    cClaude = await connection(C, 'Claude Code')
    // Bob's connection limited to his other workspace: never a target here
    bOther = await connection(B, 'Scoped Agent')
    await db.execute(sql`UPDATE oauth_grants SET range_kind = 'workspaces', range_workspace_ids = ${`{${ws2.id}}`}::uuid[] WHERE id = ${bOther.grantId}`)
    page = await h.makeDocPage(ws.id, A.id, 'Launch plan', [para('Intro')])
  })

  it('agent-connections lists live connections of members only (range, expiry, blocks), with refs', async () => {
    const r = await req(A, 'GET', `/workspaces/${ws.id}/agent-connections`)
    assert.equal(r.statusCode, 200)
    const keys = (r.json() as { connections: { key: string; ref: string; userName: string; client: string }[] }).connections
    const has = (k: string) => keys.some((c) => c.key === k)
    assert.ok(has(aClaude.key) && has(bClaude.key) && has(bCursor.key))
    assert.ok(!has(cClaude.key), 'a non-member connection is not listed')
    assert.ok(!has(bOther.key), 'a connection whose range leaves this workspace out is not listed')
    assert.equal(keys.find((c) => c.key === bClaude.key)!.ref, bClaude.ref)
    // an expired grant and a blocked client disappear
    const exp = await connection(B, 'Old Agent')
    await db.execute(sql`UPDATE oauth_grants SET refresh_expires_at = now() - interval '1 minute' WHERE id = ${exp.grantId}`)
    const blocked = await connection(B, 'Blocked Agent')
    const [g] = (await db.execute(sql`SELECT client_id AS "clientId" FROM oauth_grants WHERE id = ${blocked.grantId}`)) as unknown as { clientId: string }[]
    await db.insert(schema.workspaceAgentBlocks).values({ workspaceId: ws.id, userId: B.id, clientId: g.clientId, clientName: 'Blocked Agent', createdBy: A.id })
    const r2 = (await req(A, 'GET', `/workspaces/${ws.id}/agent-connections`)).json() as { connections: { key: string }[] }
    assert.ok(!r2.connections.some((c) => c.key === exp.key || c.key === blocked.key))
    // guests and outsiders do not get the list
    assert.equal((await req(C, 'GET', `/workspaces/${ws.id}/agent-connections`)).statusCode, 403)
  })

  it('a comment handed to a connection reaches only that connection; refusals write nothing', async () => {
    const count = async () => ((await db.execute(sql`SELECT count(*)::int AS n FROM comments WHERE page_id = ${page.id}`)) as unknown as { n: number }[])[0].n
    const blockId = 'b-intro'
    // refusals first: another person's connection under Bob's id, a non-member's, an out-of-range one
    for (const bad of [`${B.id}/${aClaude.key}`, cClaude.key, bOther.key, 'grant:not-a-uuid']) {
      const r = await req(A, 'POST', `/pages/${page.id}/comments`, { blockId, body: 'please take this', mentionConnections: [bad] })
      assert.equal(r.statusCode, 400, bad)
      assert.equal((r.json() as { error: { code: string } }).error.code, 'AGENT_NOT_AVAILABLE')
    }
    assert.equal(await count(), 0)
    // a connection limited to a subtree of this workspace: listed, but refused for a page outside it
    const area = await h.makeDocPage(ws.id, B.id, 'Bob area', [para('x')])
    const inside = await h.makeDocPage(ws.id, B.id, 'Inside', [para('y')], { parentId: area.id })
    const sub = await connection(B, 'Subtree Agent')
    await db.execute(sql`UPDATE oauth_grants SET range_kind = 'subtree', range_page_id = ${area.id} WHERE id = ${sub.grantId}`)
    const listed = (await req(A, 'GET', `/workspaces/${ws.id}/agent-connections`)).json() as { connections: { key: string }[] }
    assert.ok(listed.connections.some((c) => c.key === sub.key))
    const out = await req(A, 'POST', `/pages/${page.id}/comments`, { blockId, body: 'outside', mentionConnections: [sub.key] })
    assert.equal(out.statusCode, 400)
    assert.match((out.json() as { error: { message: string } }).error.message, /range/)
    assert.equal(await count(), 0)
    const ok = await req(A, 'POST', `/pages/${inside.id}/comments`, { blockId: 'b-in', body: 'inside the range', mentionConnections: [sub.key] })
    assert.equal(ok.statusCode, 200)
    await engine.flushNotifications()
    assert.match((await sub.mcp.tool('inbox')).text, /inside the range/)

    const r = await req(A, 'POST', `/pages/${page.id}/comments`, { blockId, body: 'Bob’s Claude: draft the FAQ', mentionConnections: [bClaude.ref] })
    assert.equal(r.statusCode, 200)
    await engine.flushNotifications()

    const mine = await bClaude.mcp.tool('inbox')
    assert.match(mine.text, /mention \(comment\) → this connection \| page /)
    assert.match(mine.text, /\(1 handed to this connection\)/)
    const other = await bCursor.mcp.tool('inbox')
    assert.doesNotMatch(other.text, /draft the FAQ/, "Bob's other connection does not see it")
    // Bob's bell: not listed without the copies setting
    const bell = (await req(B, 'GET', '/notifications')).json() as { notifications: { excerpt: string | null }[]; unread: number }
    assert.ok(!bell.notifications.some((n) => n.excerpt?.includes('draft the FAQ')))

    // an ack through another connection cannot clear it
    await bCursor.mcp.tool('ack', { cursor: '999999999999' })
    assert.match((await bClaude.mcp.tool('inbox')).text, /draft the FAQ/)
  })

  it('copies setting: the person sees hand-offs to their agents in the bell, labelled with the agent', async () => {
    assert.equal((await req(B, 'PATCH', '/me/notification-settings', { agentHandoffCopy: true })).statusCode, 200)
    await req(A, 'POST', `/pages/${page.id}/comments`, { blockId: 'b-intro', body: 'Cursor, check the numbers', mentionConnections: [bCursor.short] })
    await engine.flushNotifications()
    const bell = (await req(B, 'GET', '/notifications')).json() as { notifications: { excerpt: string | null; forAgent?: string }[] }
    const n = bell.notifications.find((x) => x.excerpt?.includes('check the numbers'))
    assert.ok(n, 'copy listed')
    assert.equal(n!.forAgent, 'Cursor')
    assert.match((await bCursor.mcp.tool('inbox')).text, /check the numbers/)
    assert.doesNotMatch((await bClaude.mcp.tool('inbox')).text, /check the numbers/)
    await req(B, 'PATCH', '/me/notification-settings', { agentHandoffCopy: false })
  })

  it('revoking the connection hands its open items to the person (bell and every connection)', async () => {
    const extra = await connection(B, 'Temp Agent')
    await req(A, 'POST', `/pages/${page.id}/comments`, { blockId: 'b-intro', body: 'temp agent: summarise', mentionConnections: [extra.key] })
    await engine.flushNotifications()
    assert.doesNotMatch((await bCursor.mcp.tool('inbox')).text, /summarise/)
    assert.equal((await req(B, 'DELETE', `/oauth/grants/${extra.grantId}`)).statusCode, 204)
    const bell = (await req(B, 'GET', '/notifications')).json() as { notifications: { excerpt: string | null }[] }
    assert.ok(bell.notifications.some((n) => n.excerpt?.includes('summarise')), 'falls to the person')
    const inbox = await bCursor.mcp.tool('inbox')
    assert.match(inbox.text, /summarise/)
    assert.doesNotMatch(inbox.text.split('\n').find((l) => l.includes('summarise')) ?? '', /this connection/)
    // housekeeping catches what a revoke route did not (expiry): nothing left to hand back here
    assert.deepEqual(await handBackConnections(null), [])
  })

  it('person cells: assign a connection next to the person (0.14 shape kept), notify only it, refuse others', async () => {
    const [coll] = await db.insert(schema.pages).values({ workspaceId: ws.id, title: 'Tasks', createdBy: A.id, kind: 'collection' }).returning()
    await db.insert(schema.collections).values({ pageId: coll.id, fields: [{ id: 'own', name: 'Owner', type: 'person' }, { id: 'st', name: 'Status', type: 'text' }] as never })
    const [row] = await db.insert(schema.pages).values({ workspaceId: ws.id, parentId: coll.id, title: 'Write FAQ', createdBy: A.id, kind: 'doc', props: { st: 'todo' } }).returning()
    const [row2] = await db.insert(schema.pages).values({ workspaceId: ws.id, parentId: coll.id, title: 'Plain', createdBy: A.id, kind: 'doc', props: { own: B.id } }).returning()

    // refused: a non-member's connection, another person's connection, the cell set to someone else
    for (const props of [{ 'agent:own': cClaude.key }, { 'agent:own': `${B.id}/${aClaude.key}` }, { own: A.id, 'agent:own': bClaude.key }, { 'agent:st': bClaude.key }]) {
      const r = await req(A, 'PATCH', `/pages/${row.id}/props`, { props })
      assert.equal(r.statusCode, 400, JSON.stringify(props))
    }
    const r = await req(A, 'PATCH', `/pages/${row.id}/props`, { props: { 'agent:own': bClaude.ref } })
    assert.equal(r.statusCode, 200)
    const stored = ((await db.execute(sql`SELECT props FROM pages WHERE id = ${row.id}`)) as unknown as { props: Record<string, unknown> }[])[0].props
    // what a 0.14 client reads: the person id in the cell, an extra key it ignores
    assert.equal(stored.own, B.id)
    assert.equal(stored['agent:own'], bClaude.ref)
    await engine.flushNotifications()
    assert.match((await bClaude.mcp.tool('inbox')).text, /assigned → this connection \| page /)
    assert.doesNotMatch((await bCursor.mcp.tool('inbox', { kinds: ['assigned'] })).text, /Write FAQ/)

    // query_rows: "this connection" finds it for that connection only; the cell names the agent
    const q1 = await bClaude.mcp.tool('query_rows', { collectionId: coll.id, filter: 'Owner = this connection', fields: ['Owner'] })
    assert.match(q1.text, /Write FAQ/)
    assert.doesNotMatch(q1.text, /Plain/)
    assert.match(q1.text, new RegExp(`Bob → Claude Code \\(${bClaude.short}\\)`))
    const q2 = await bCursor.mcp.tool('query_rows', { collectionId: coll.id, filter: 'Owner = this connection' })
    assert.doesNotMatch(q2.text, /Write FAQ/)
    // "me" still means the person (rows of their agents included)
    const q3 = await bCursor.mcp.tool('query_rows', { collectionId: coll.id, filter: 'Owner = me' })
    assert.match(q3.text, /Write FAQ/)
    assert.match(q3.text, /Plain/)

    // an old client changing the person leaves a stale key that never counts; a new write clears it
    await db.execute(sql`UPDATE pages SET props = props || ${JSON.stringify({ own: A.id })}::jsonb WHERE id = ${row.id}`)
    assert.doesNotMatch((await bClaude.mcp.tool('query_rows', { collectionId: coll.id, filter: 'Owner = this connection' })).text, /Write FAQ/)
    await req(A, 'PATCH', `/pages/${row.id}/props`, { props: { own: B.id } })
    const after2 = ((await db.execute(sql`SELECT props FROM pages WHERE id = ${row.id}`)) as unknown as { props: Record<string, unknown> }[])[0].props
    assert.equal(after2['agent:own'], bClaude.ref, 'Bob is back in the cell: his agent counts again')
    await req(A, 'PATCH', `/pages/${row.id}/props`, { props: { own: A.id } })
    const after3 = ((await db.execute(sql`SELECT props FROM pages WHERE id = ${row.id}`)) as unknown as { props: Record<string, unknown> }[])[0].props
    assert.equal(after3['agent:own'], undefined, 'a write that moves the cell to another person drops the agent')

    // update_row through MCP: "this connection" assigns the caller's own connection; the server fills the person
    const v = (await bCursor.mcp.tool('query_rows', { collectionId: coll.id, filter: 'Title = Plain' })).text.match(new RegExp(`${row2.id} \\| (\\S+)`))![1]
    const up = await bCursor.mcp.tool('update_row', { rowId: row2.id, properties: { Owner: 'this connection' }, baseVersion: v })
    assert.equal(up.isError, false, up.text)
    assert.match((await bCursor.mcp.tool('query_rows', { collectionId: coll.id, filter: 'Owner = this connection' })).text, /Plain/)

    // revoked connection: the cell reads as the person, "this connection" no longer matches
    await req(B, 'DELETE', `/oauth/grants/${bCursor.grantId}`)
    const q4 = await bClaude.mcp.tool('query_rows', { collectionId: coll.id, filter: 'Owner = me', fields: ['Owner'] })
    assert.match(q4.text, /Plain/)
    assert.doesNotMatch(q4.text, /Cursor/)
  })

  it('agent chip in a to-do: assigned to that connection; a dead connection falls to the person', async () => {
    const p = await h.makeDocPage(ws.id, A.id, 'Checklist', [para('x')])
    await syncDocMentions(p.id, [], [], { userId: A.id, via: null }) // baseline
    await syncDocMentions(p.id, [], [{ userId: B.id, connection: bClaude.key, blockId: 't1', top: 0, text: 'Ship it @Bob · Claude Code', inTask: true }], { userId: A.id, via: null })
    await engine.flushNotifications()
    const t = await bClaude.mcp.tool('inbox', { kinds: ['assigned'] })
    assert.match(t.text, /assigned → this connection \| page \S+ "Checklist"/)
    // a chip naming Bob with Alice's connection is Bob's chip (person), never the connection's
    await syncDocMentions(p.id, [], [{ userId: B.id, connection: aClaude.key, blockId: 't2', top: 0, text: 'x', inTask: true }], { userId: A.id, via: null })
    await engine.flushNotifications()
    const [n] = (await db.execute(sql`SELECT connection FROM notifications WHERE page_id = ${p.id} AND user_id = ${B.id} ORDER BY seq DESC LIMIT 1`)) as unknown as { connection: string | null }[]
    assert.equal(n.connection, null)
  })

  it('board: claims, open suggestions and activity by person; titles of pages the viewer cannot see are hidden', async () => {
    const priv = await h.makeDocPage(ws.id, B.id, 'Bob secret', [{ type: 'heading', props: { level: 2 }, content: [{ type: 'text', text: 'Plan', styles: {} }] } as never, para('x')], { scope: 'private' })
    const pub = await h.makeDocPage(ws.id, A.id, 'Shared roadmap', [{ type: 'heading', props: { level: 2 }, content: [{ type: 'text', text: 'Q4', styles: {} }] } as never, para('x')])
    await db.execute(sql`INSERT INTO section_leases (page_id, anchor, workspace_id, user_id, connection, via, expires_at)
      VALUES (${priv.id}, 'plan', ${ws.id}, ${B.id}, ${bClaude.key}, 'Claude Code', now() + interval '10 minutes'),
             (${pub.id}, 'q4', ${ws.id}, ${B.id}, ${bClaude.key}, 'Claude Code', now() + interval '5 minutes')`)
    await db.execute(sql`INSERT INTO page_changes (workspace_id, page_id, anchor, kind, scope, actor_id, via_client)
      VALUES (${ws.id}, ${priv.id}, 'plan', 'modified', 'private', ${B.id}, 'Claude Code'),
             (${ws.id}, ${pub.id}, 'q4', 'modified', 'shared', ${B.id}, 'Claude Code'),
             (${ws.id}, ${pub.id}, NULL, 'page_added', 'shared', ${B.id}, 'Claude Code')`)
    const forA = await readTeamAgents(ws.id, A.id, Date.now() - 3_600_000)
    const bob = forA.people.find((x) => x.userId === B.id)!
    const hidden = bob.claims.find((c) => c.pageId === priv.id)!
    assert.equal(hidden.hidden, true)
    assert.equal(hidden.pageTitle, null)
    assert.equal(hidden.anchor, null)
    const shown = bob.claims.find((c) => c.pageId === pub.id)!
    assert.equal(shown.pageTitle, 'Shared roadmap')
    assert.equal(shown.anchor, 'q4')
    assert.ok(shown.ttlSeconds > 200 && shown.ttlSeconds <= 300)
    const agent = bob.agents.find((a) => a.client === 'Claude Code')!
    assert.ok(agent.edits >= 2 && agent.created >= 1)
    assert.ok(agent.recentPages.some((rp) => rp.pageId === priv.id && rp.hidden && rp.title === null))
    assert.ok(!JSON.stringify(forA).includes('Bob secret'), 'the private title never reaches Alice')
    // Bob sees his own page
    const forB = await readTeamAgents(ws.id, B.id, Date.now() - 3_600_000)
    assert.equal(forB.people.find((x) => x.userId === B.id)!.claims.find((c) => c.pageId === priv.id)!.pageTitle, 'Bob secret')
    // the route: members only
    assert.equal((await req(A, 'GET', `/workspaces/${ws.id}/team-agents`)).statusCode, 200)
    assert.equal((await req(C, 'GET', `/workspaces/${ws.id}/team-agents`)).statusCode, 403)
  })

  it('catch_up: unchanged without team; team=true adds the group (others only, hidden titles), token cost measured', async () => {
    const plain = await aClaude.mcp.tool('catch_up', { workspaceId: ws.id, peek: true, since: '2020-01-01T00:00Z' })
    assert.doesNotMatch(plain.text, /Team agents/)
    const team = await aClaude.mcp.tool('catch_up', { workspaceId: ws.id, peek: true, since: '2020-01-01T00:00Z', team: true })
    assert.match(team.text, /## Team agents/)
    assert.match(team.text, /- claim §q4 · "Shared roadmap" [0-9a-f]{8} · Bob via Claude Code \(g:[0-9a-f]{8}\) · until /)
    assert.match(team.text, /- claim \(hidden\) [0-9a-f]{8} · Bob via Claude Code/)
    assert.doesNotMatch(team.text, /Bob secret/)
    assert.match(team.text, /- Bob via Claude Code \(g:[0-9a-f]{8}\): \d+ edits?, 1 new/)
    const extra = estimateTokens(team.text) - estimateTokens(plain.text)
    console.log(`[team] catch_up team=true adds ~${extra} tokens (plain ${estimateTokens(plain.text)}, team ${estimateTokens(team.text)})`)
    assert.ok(extra > 0 && extra < 400)
  })
})
