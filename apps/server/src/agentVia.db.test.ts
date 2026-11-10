// run-tests: db-exclusive
// Public form answers are people's input, not AI edits (docs/adr/1870-*): rows sent through a public
// form carry via = "public form" for the feed's "<publisher> via public form", but the activity AI
// and human filters, the AI clients list, the "Written by AI" provenance, the daily AI summary, the
// team agents board and the agent quiet rule for mentions all treat them as a person's change. An
// agent's own edit next to it stays an AI edit (control). The OAuth client name is reserved.
// db-exclusive: runAgentSummaries(force) walks every subscription in the shared database.
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.APP_URL ||= 'https://notes.example.com'
process.env.APP_SECRET_KEY ||= 'test-app-secret-key-0123456789-abcdefghij'

import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'
import type { ActivityPageDTO, CollectionViewDTO, PageProvenanceDTO } from '@inkling/shared'

const HAS_DB = !!process.env.DATABASE_URL

describe('[db] public form answers are not AI edits', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const h = await import('./mcpTools/testHarness')
  const { closeDb, db } = await import('./db/index')
  const schema = await import('./db/schema')
  const { and, eq } = await import('drizzle-orm')
  const { drainChangeLog } = await import('./context/changeLog')
  const { runAgentSummaries } = await import('./notify/digest')
  const { flushNotifications, notify } = await import('./notify/engine')
  const { PUBLIC_FORM_VIA, isAgentVia } = await import('./agentVia')
  const { reservedClientName } = await import('./clientName')
  const app = await h.buildTestApp()

  const alice = await h.makeUser('alice') // owner, publishes the form
  const bob = await h.makeUser('bob')
  const ws = await h.makeWorkspace(alice, [bob])
  const tokenA = await h.mintToken(alice, 'notes', 'Note Agent')
  const A = await h.connectMcp(app, alice, tokenA, { user: { ...alice, via: 'Note Agent' } })
  after(async () => {
    await A.close()
    await app.close()
    await closeDb()
  })

  const as = (u: { cookie: string }, method: string, url: string, payload?: unknown) =>
    app.inject({
      method: method as 'GET',
      url: `/api${url}`,
      headers: { cookie: u.cookie, ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) },
      payload: payload === undefined ? undefined : JSON.stringify(payload),
    })

  // a collection with a published form and one public answer ("Dana")
  const mk = await as(alice, 'POST', '/pages', { workspaceId: ws.id, kind: 'collection', title: 'Signups' })
  assert.equal(mk.statusCode, 200, mk.body)
  const coll = mk.json().page.id as string
  assert.equal((await as(alice, 'PUT', `/pages/${coll}/collection/fields`, { fields: [{ id: 'em', name: 'Email', type: 'text' }] })).statusCode, 200)
  const v = await as(alice, 'POST', `/pages/${coll}/collection/views`, {
    name: 'Form',
    type: 'form',
    config: { form: { title: 'Signup', fields: [{ fieldId: 'title', required: true }, { fieldId: 'em' }] } },
  })
  assert.equal(v.statusCode, 200, v.body)
  const view = v.json().view as CollectionViewDTO
  const on = await as(alice, 'POST', `/collection-views/${view.id}/form-link`, {})
  assert.equal(on.statusCode, 200, on.body)
  const token = on.json().token as string
  const sent = await app.inject({
    method: 'POST',
    url: `/api/public/forms/${token}`,
    remoteAddress: '10.9.0.1',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ values: { title: 'Dana', em: 'dana@example.test' } }),
  })
  assert.equal(sent.statusCode, 200, sent.body)
  const [dana] = await db
    .select({ id: schema.pages.id, createdVia: schema.pages.createdVia })
    .from(schema.pages)
    .where(and(eq(schema.pages.parentId, coll), eq(schema.pages.title, 'Dana')))
  assert.equal(dana.createdVia, PUBLIC_FORM_VIA)

  // control: an agent's page next to it
  const made = await A.tool('create_page', { workspaceId: ws.id, title: 'Agent note', markdown: 'Written by the agent.' })
  assert.equal(made.isError, false, made.text)
  await drainChangeLog()

  const activity = async (query: string) => {
    const res = await as(bob, 'GET', `/workspaces/${ws.id}/activity?${query}`)
    assert.equal(res.statusCode, 200, res.body)
    return res.json() as ActivityPageDTO
  }

  it('the predicate: only agent connections are agents; the name is reserved for OAuth clients', () => {
    assert.equal(isAgentVia(PUBLIC_FORM_VIA), false)
    assert.equal(isAgentVia(null), false)
    assert.equal(isAgentVia('Claude'), true)
    assert.ok(reservedClientName('Public Form'))
    assert.ok(reservedClientName('public-form'))
    assert.equal(reservedClientName('Public Forms Helper'), null)
  })

  it('activity: the AI filter leaves the form row out, the people filter keeps it, the AI clients list lacks the marker', async () => {
    const ai = await activity('actor=ai&limit=100')
    assert.ok(!ai.items.some((i) => i.pageId === dana.id), 'form row listed as an AI edit')
    assert.ok(ai.items.some((i) => i.via === 'Note Agent'), 'agent edit missing from the AI filter')
    const human = await activity('actor=human&limit=100')
    const row = human.items.find((i) => i.pageId === dana.id)
    assert.ok(row, 'form row missing from the people filter')
    // the label stays: "<publisher> via public form"
    assert.equal(row.via, PUBLIC_FORM_VIA)
    assert.equal(row.pageCreatedVia, null, 'form row marked as written by AI')
    assert.ok(!human.items.some((i) => i.via === 'Note Agent'))
    assert.deepEqual(ai.clients, ['Note Agent'])
    const aiPages = await activity('aiPagesOnly=1&limit=100')
    assert.ok(!aiPages.items.some((i) => i.pageId === dana.id))
    assert.ok(aiPages.items.some((i) => i.via === 'Note Agent'))
  })

  it('provenance: no "Written by AI" badge on a form row; the agent page keeps its badge', async () => {
    const p = (await as(bob, 'GET', `/pages/${dana.id}/provenance`)).json() as PageProvenanceDTO
    assert.equal(p.createdVia, null)
    assert.equal(p.lastAgentEdit, null)
    const agentPage = /"id":\s*"([0-9a-f-]{36})"/.exec(made.text)?.[1] ?? /([0-9a-f-]{36})/.exec(made.text)![1]
    const q = (await as(bob, 'GET', `/pages/${agentPage}/provenance`)).json() as PageProvenanceDTO
    assert.equal(q.createdVia, 'Note Agent')
  })

  it('the daily AI summary names the agent page, never the form row', async () => {
    await db.insert(schema.notificationPrefs).values({ userId: bob.id, workspaceId: ws.id, rootPageId: null, level: 'mentions', agentDigest: true })
    await runAgentSummaries(new Date(), { force: true })
    await flushNotifications()
    const items = await db
      .select({ excerpt: schema.notifications.excerpt })
      .from(schema.notifications)
      .where(and(eq(schema.notifications.userId, bob.id), eq(schema.notifications.type, 'agent_digest')))
    assert.equal(items.length, 1)
    assert.match(items[0].excerpt ?? '', /Agent note/)
    assert.doesNotMatch(items[0].excerpt ?? '', /Dana|Signups/)
    assert.match(items[0].excerpt ?? '', /^1 page\(s\)/)
  })

  it('team agents board: the publisher has no "public form" agent', async () => {
    const res = await as(bob, 'GET', `/workspaces/${ws.id}/team-agents`)
    assert.equal(res.statusCode, 200, res.body)
    const dto = res.json() as { people: { userId: string; agents: { client: string; created: number }[] }[] }
    const clients = dto.people.flatMap((p) => p.agents.map((a) => a.client))
    assert.ok(!clients.includes(PUBLIC_FORM_VIA), JSON.stringify(clients))
    assert.ok(clients.includes('Note Agent'), JSON.stringify(clients))
  })

  it('a mention made through a public form is not quieted like an agent mention', async () => {
    const page = await h.makeDocPage(ws.id, alice.id, 'Mentions here', [])
    notify({ workspaceId: ws.id, pageId: page.id, actorId: alice.id, via: PUBLIC_FORM_VIA, recipients: [{ userId: bob.id, kind: 'doc_mention', reason: 'direct' }] })
    await flushNotifications()
    const page2 = await h.makeDocPage(ws.id, alice.id, 'Agent mentions here', [])
    notify({ workspaceId: ws.id, pageId: page2.id, actorId: alice.id, via: 'Note Agent', recipients: [{ userId: bob.id, kind: 'doc_mention', reason: 'direct' }] })
    await flushNotifications()
    const rows = await db
      .select({ pageId: schema.notifications.pageId, delivery: schema.notifications.delivery })
      .from(schema.notifications)
      .where(and(eq(schema.notifications.userId, bob.id), eq(schema.notifications.type, 'doc_mention')))
    assert.equal(rows.find((r) => r.pageId === page.id)?.delivery, 'now')
    assert.equal(rows.find((r) => r.pageId === page2.id)?.delivery, 'quiet')
  })
})
