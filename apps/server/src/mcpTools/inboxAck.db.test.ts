// Inbox acknowledgement follows the listing (docs/adr/1922-*), against a real database through the
// MCP tools: an agent that lists `inbox(workspaceId=A)` (or `kinds=[…]`) and then does what the
// footer says — `ack(cursor)` — acknowledges only what that listing could show. Items of another
// workspace or kind, items it could not see, and items handed to another connection stay.
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.DATA_DIR ||= `${process.env.TMPDIR || '/tmp'}/inkling-inboxack-${process.pid}`

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

const HAS_DB = !!process.env.DATABASE_URL

describe('[db] inbox ack follows the listing filter', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const h = await import('./testHarness')
  const { db, closeDb } = await import('../db/index')
  const schema = await import('../db/schema')
  const { sql } = await import('drizzle-orm')
  const app = await h.buildTestApp()

  type U = Awaited<ReturnType<typeof h.makeUser>>
  type Mcp = Awaited<ReturnType<typeof h.connectMcp>>
  let O: U, M: U
  let wsA: string, wsB: string
  let pA: string, pB: string, pPrivate: string
  let mcp: Mcp

  before(async () => {
    O = await h.makeUser('Owner')
    M = await h.makeUser('Mate')
    wsA = (await h.makeWorkspace(O, [M], 'Inbox A')).id
    wsB = (await h.makeWorkspace(O, [M], 'Inbox B')).id
    pA = (await h.makeDocPage(wsA, O.id, 'Page in A', [] as never)).id
    pB = (await h.makeDocPage(wsB, O.id, 'Page in B', [] as never)).id
    // M's private page: O's inbox can never list a notification on it
    pPrivate = (await h.makeDocPage(wsA, M.id, 'M private', [] as never, { scope: 'private' })).id
    mcp = await h.connectMcp(app, O, await h.mintToken(O))
  })

  after(async () => {
    await mcp.close()
    await app.close()
    await closeDb()
  })

  async function notify(rows: { type: string; workspaceId: string; pageId: string; excerpt: string }[]): Promise<string[]> {
    const out = (await db.insert(schema.notifications).values(rows.map((r) => ({ userId: O.id, actorId: M.id, ...r })) as never).returning({ seq: schema.notifications.seq })) as { seq: string | number | bigint }[]
    return out.map((r) => String(r.seq))
  }
  const acked = async (seqs: string[]) =>
    (
      (await db.execute(sql`SELECT seq::text AS seq, acked_at IS NOT NULL AS acked FROM notifications WHERE seq = ANY(${`{${seqs.join(',')}}`}::bigint[]) ORDER BY seq`)) as unknown as { seq: string; acked: boolean }[]
    ).map((r) => r.acked)
  const cursorOf = (text: string) => /cursor: (\S+)\s*$/.exec(text)?.[1] ?? ''

  it('inbox(workspaceId=A) then ack(cursor) leaves workspace B untouched', async () => {
    // B's item is older (lower seq) than A's: the cursor of the A listing lies after it
    const [b] = await notify([{ type: 'doc_mention', workspaceId: wsB, pageId: pB, excerpt: 'mention in B' }])
    const [a] = await notify([{ type: 'doc_mention', workspaceId: wsA, pageId: pA, excerpt: 'mention in A' }])
    const list = await mcp.tool('inbox', { workspaceId: wsA })
    assert.match(list.text, /mention in A/)
    assert.doesNotMatch(list.text, /mention in B/)
    const res = await mcp.tool('ack', { cursor: cursorOf(list.text) })
    assert.equal(res.isError, false, res.text)
    assert.deepEqual(await acked([b, a]), [false, true], 'the older B mention the agent never saw stays unacknowledged (rows in seq order)')
    assert.match((await mcp.tool('inbox')).text, /mention in B/)
  })

  it('inbox(kinds=[reply]) then ack(cursor) leaves mentions untouched', async () => {
    const [m, r] = await notify([
      { type: 'doc_mention', workspaceId: wsA, pageId: pA, excerpt: 'a mention' },
      { type: 'comment_reply', workspaceId: wsA, pageId: pA, excerpt: 'a reply' },
    ])
    const list = await mcp.tool('inbox', { kinds: ['reply'] })
    assert.match(list.text, /a reply/)
    assert.doesNotMatch(list.text, /a mention/)
    await mcp.tool('ack', { cursor: cursorOf(list.text) })
    assert.deepEqual(await acked([m, r]), [false, true])
  })

  it('a filtered cursor keeps paging with the same filter', async () => {
    const [b2] = await notify([{ type: 'doc_mention', workspaceId: wsB, pageId: pB, excerpt: 'later in B' }])
    const [a2] = await notify([{ type: 'doc_mention', workspaceId: wsA, pageId: pA, excerpt: 'later in A' }])
    const first = await mcp.tool('inbox', { workspaceId: wsA })
    const next = await mcp.tool('inbox', { cursor: cursorOf(first.text) })
    assert.doesNotMatch(next.text, /later in B/, 'the cursor carries the workspace filter')
    await mcp.tool('ack', { cursor: cursorOf(first.text) })
    assert.deepEqual(await acked([b2, a2]), [false, true])
  })

  it('an unfiltered ack(cursor) acknowledges only what the listing could show', async () => {
    const [hidden, shown] = await notify([
      { type: 'doc_mention', workspaceId: wsA, pageId: pPrivate, excerpt: 'on a page O cannot see' },
      { type: 'doc_mention', workspaceId: wsB, pageId: pB, excerpt: 'visible' },
    ])
    const list = await mcp.tool('inbox')
    assert.doesNotMatch(list.text, /cannot see/)
    await mcp.tool('ack', { cursor: cursorOf(list.text) })
    assert.deepEqual(await acked([hidden, shown]), [false, true])
  })

  it('REST: ack by cursor with the same workspaceId/kinds as the listing', async () => {
    const [a, b] = await notify([
      { type: 'doc_mention', workspaceId: wsA, pageId: pA, excerpt: 'rest A' },
      { type: 'doc_mention', workspaceId: wsB, pageId: pB, excerpt: 'rest B' },
    ])
    const r = await app.inject({ method: 'POST', url: '/api/inbox/ack', headers: { cookie: O.cookie }, payload: { cursor: b, workspaceId: wsB, kinds: ['mention'] } })
    assert.equal(r.statusCode, 200, r.body)
    assert.deepEqual(await acked([a, b]), [false, true])
  })
})
