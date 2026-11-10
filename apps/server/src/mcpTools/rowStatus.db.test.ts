// Member status next to row assignments (docs/adr/1846-*, 1864-*, 1870-*): update_row / create_row
// that put a person (or a person's agent connection) in a person cell end with one `status:` line for
// those people; query_rows ends with one line for the people in the shown person cells. No line, no
// tokens and no statement when nobody involved has a status; the caller's own person is left out.
// Also: the members list (statuses, P) and the agent connections list (Q) that the mention menu reads
// both serve the same person.
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'

const HAS_DB = !!process.env.DATABASE_URL

describe('[db] member status after row assignments and in query_rows', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const h = await import('./testHarness')
  const { closeDb, db } = await import('../db/index')
  const schema = await import('../db/schema')
  const { eq } = await import('drizzle-orm')
  const { estimateTokens } = await import('../context/tokens')
  const app = await h.buildTestApp()

  const alice = await h.makeUser('alice') // owner; her agent writes the rows
  const bob = await h.makeUser('bob') // has a status and an agent connection
  const carol = await h.makeUser('carol') // no status
  const ws = await h.makeWorkspace(alice, [bob, carol])
  const tokenA = await h.mintToken(alice, 'notes', 'Row Agent')
  const A = await h.connectMcp(app, alice, tokenA, { user: { ...alice, via: 'Row Agent' } })
  await h.mintToken(bob, 'notes', 'Bob Agent')
  const [bobGrant] = await db.select({ id: schema.oauthGrants.id }).from(schema.oauthGrants).where(eq(schema.oauthGrants.userId, bob.id))
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

  const clearAt = new Date(Date.now() + 3 * 86_400_000).toISOString()
  assert.equal((await as(bob, 'PUT', '/me/status', { emoji: '🎓', text: 'Exam week', clearAt })).statusCode, 200)
  assert.equal((await as(alice, 'PUT', '/me/status', { emoji: '🌴', text: 'Off Friday' })).statusCode, 200)

  const mk = await as(alice, 'POST', '/pages', { workspaceId: ws.id, kind: 'collection', title: 'Tasks' })
  assert.equal(mk.statusCode, 200, mk.body)
  const coll = mk.json().page.id as string
  const put = await as(alice, 'PUT', `/pages/${coll}/collection/fields`, {
    fields: [
      { id: 'ow', name: 'Owner', type: 'person' },
      { id: 'st', name: 'Stage', type: 'text' },
    ],
  })
  assert.equal(put.statusCode, 200, put.body)

  const BOB_LINE = /\nstatus: bob[^\n"]* "🎓 Exam week" until \d{4}-\d{2}-\d{2}$/
  const rowOf = (t: string) => /Created row ([0-9a-f-]{36})[^\n]*Version: (\S+)/.exec(t)!
  const tokens: Record<string, number> = {}

  it('create_row: a person with a status → one line at the end; without one → no line', async () => {
    const withBob = await A.tool('create_row', { collectionId: coll, title: 'Write intro', template: 'none', properties: { Owner: bob.id, Stage: 'draft' } })
    assert.equal(withBob.isError, false, withBob.text)
    assert.match(withBob.text, BOB_LINE)
    const withCarol = await A.tool('create_row', { collectionId: coll, title: 'Edit intro', template: 'none', properties: { Owner: carol.id } })
    assert.equal(withCarol.isError, false, withCarol.text)
    assert.doesNotMatch(withCarol.text, /status:/)
    tokens.create = estimateTokens(withBob.text) - estimateTokens(withBob.text.replace(BOB_LINE, ''))
  })

  it('update_row: assigning a person or that person\'s agent connection names the person once; "me" and other fields add nothing', async () => {
    const made = await A.tool('create_row', { collectionId: coll, title: 'Review', template: 'none', properties: { Stage: 'new' } })
    assert.equal(made.isError, false, made.text)
    assert.doesNotMatch(made.text, /status:/)
    let [, rowId, version] = rowOf(made.text)
    const next = (t: string) => {
      version = /New version: (\S+)/.exec(t)![1]
    }

    const toBob = await A.tool('update_row', { rowId, properties: { Owner: 'bob' }, baseVersion: version })
    assert.equal(toBob.isError, false, toBob.text)
    assert.match(toBob.text, BOB_LINE)
    next(toBob.text)
    tokens.update = estimateTokens(toBob.text) - estimateTokens(toBob.text.replace(BOB_LINE, ''))

    // only the Stage changes: the person cell was not written, no line
    const stage = await A.tool('update_row', { rowId, properties: { Stage: 'done' }, baseVersion: version })
    assert.equal(stage.isError, false, stage.text)
    assert.doesNotMatch(stage.text, /status:/)
    next(stage.text)

    // the caller's own person ("me") is left out even with a status
    const me = await A.tool('update_row', { rowId, properties: { Owner: 'me' }, baseVersion: version })
    assert.equal(me.isError, false, me.text)
    assert.doesNotMatch(me.text, /status:/)
    next(me.text)

    // bob's agent connection: the cell holds bob, the line names bob
    const toAgent = await A.tool('update_row', { rowId, properties: { Owner: `grant:${bobGrant.id}` }, baseVersion: version })
    assert.equal(toAgent.isError, false, toAgent.text)
    assert.match(toAgent.text, BOB_LINE)
  })

  it('query_rows: one line for the people in the shown person cells, after the footer; none when the column is not shown', async () => {
    const q = await A.tool('query_rows', { collectionId: coll, fields: ['Owner', 'Stage'], sort: 'Title' })
    assert.equal(q.isError, false, q.text)
    // bob owns two rows (one through his agent), carol one: bob is named once, carol has no status
    assert.equal((q.text.match(/^status:/gm) ?? []).length, 1, q.text)
    assert.match(q.text, /\(end of results\)\nstatus: bob[^\n"]* "🎓 Exam week" until \d{4}-\d{2}-\d{2}$/)
    tokens.query = estimateTokens(q.text) - estimateTokens(q.text.replace(/\nstatus: [^\n]*$/, ''))
    // same call twice: the same text (deterministic)
    assert.equal((await A.tool('query_rows', { collectionId: coll, fields: ['Owner', 'Stage'], sort: 'Title' })).text, q.text)

    const noPerson = await A.tool('query_rows', { collectionId: coll, fields: ['Stage'], sort: 'Title' })
    assert.equal(noPerson.isError, false, noPerson.text)
    assert.doesNotMatch(noPerson.text, /status:/)
    assert.match(noPerson.text, /\(end of results\)$/)

    // the REST answer lists the person ids only when a person column is shown
    const rest = (await as(alice, 'GET', `/pages/${coll}/collection/query?fields=${encodeURIComponent('["Owner"]')}`)).json() as { people?: string[] }
    assert.deepEqual(rest.people, [bob.id, carol.id].sort())
    const restNo = (await as(alice, 'GET', `/pages/${coll}/collection/query?fields=${encodeURIComponent('["Stage"]')}`)).json() as { people?: string[] }
    assert.equal('people' in restNo, false)
  })

  it('a to-do with a person\'s agent chip counts as that person for the status line', async () => {
    const { mentionedUserIds } = await import('../memberStatus')
    const md = `- [ ] Draft @[bob · Bob Agent](agent:${bob.id}/grant:${bobGrant.id}) and ask @[carol](user:${carol.id})`
    assert.deepEqual(mentionedUserIds(md), [bob.id, carol.id])
    assert.deepEqual(mentionedUserIds('@[x](page:abc)'), [])
  })

  it('mention menu sources: the members list carries the status, the agent connections list the same person', async () => {
    const members = (await as(carol, 'GET', `/workspaces/${ws.id}/members`)).json().members as { id: string; status: { text: string } | null }[]
    assert.equal(members.find((m) => m.id === bob.id)?.status?.text, 'Exam week')
    assert.equal(members.find((m) => m.id === carol.id)?.status, null)
    const conns = (await as(carol, 'GET', `/workspaces/${ws.id}/agent-connections`)).json().connections as { ref: string; userId: string; userName: string }[]
    const bobs = conns.filter((c) => c.userId === bob.id)
    assert.equal(bobs.length, 1, JSON.stringify(conns))
    assert.equal(bobs[0].ref, `${bob.id}/grant:${bobGrant.id}`)
    assert.equal(bobs[0].userName, bob.name)
    if (process.env.TOKENS === '1') console.log(`[tokens] status line: create_row +${tokens.create}, update_row +${tokens.update}, query_rows +${tokens.query}`)
  })
})
