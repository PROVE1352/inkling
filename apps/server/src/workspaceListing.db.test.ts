// A person's own workspace list (docs/adr/2300-* .. 2305-*): groups, order and archive through the
// /api/me routes; archived workspaces out of the default scope of find_context, search and catch_up
// (and named in one closing line), in again with workspaceId; mentions still reach the person; other
// members, range-limited connections and guests; cleanup on leave, purge and account deletion.
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.DATA_DIR ||= `${process.env.TMPDIR || '/tmp'}/inkling-wslisting-${process.pid}`

import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { after, before, describe, it } from 'node:test'

const HAS_DB = !!process.env.DATABASE_URL

describe('[db] workspace list: groups, archive and the default search scope', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const h = await import('./mcpTools/testHarness')
  const { db, closeDb } = await import('./db/index')
  const schema = await import('./db/schema')
  const { and, eq } = await import('drizzle-orm')
  const collab = await import('./collab')
  const { reindexPageChunks } = await import('./context/chunkIndex')
  const { drainChangeLog } = await import('./context/changeLog')
  const { getBearerUser } = await import('./oauth')
  const app = await h.buildTestApp()
  after(async () => {
    await collab.destroyCollab()
    await app.close()
    await closeDb()
  })

  type U = Awaited<ReturnType<typeof h.makeUser>>
  const asCookie = (u: U, method: string, url: string, payload?: unknown) =>
    app.inject({ method: method as 'GET', url: `/api${url}`, headers: { cookie: u.cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) })
  const sha = (s: string) => createHash('sha256').update(s).digest('hex')

  // a word no other test writes, so every hit is one of these pages
  const W = `zq${randomBytes(4).toString('hex')}`
  let me: U, mate: U, stranger: U
  let alpha: { id: string }, beta: { id: string }, gamma: { id: string }
  const page: Record<string, string> = {}
  type Blocks = Parameters<typeof h.makeDocPage>[3]
  const doc = (heading: string, body: string): Blocks =>
    [
      { type: 'heading', props: { level: 2 }, content: [{ type: 'text', text: heading, styles: {} }] },
      { type: 'paragraph', content: [{ type: 'text', text: body, styles: {} }] },
    ] as Blocks
  async function newPage(wsId: string, by: { id: string }, title: string, body: string) {
    const blocks = doc(title, body)
    const pg = await h.makeDocPage(wsId, by.id, title, blocks)
    await reindexPageChunks(pg.id, blocks as never)
    await drainChangeLog()
    return pg.id
  }
  let mcp: Awaited<ReturnType<typeof h.connectMcp>>
  let mateMcp: Awaited<ReturnType<typeof h.connectMcp>>

  before(async () => {
    me = await h.makeUser('Lister')
    mate = await h.makeUser('Mate')
    stranger = await h.makeUser('Stranger')
    alpha = await h.makeWorkspace(me, [mate], 'Alpha Cup')
    beta = await h.makeWorkspace(me, [mate], 'Beta Class')
    gamma = await h.makeWorkspace(me, [mate], 'Gamma Old Contest')
    page.alpha = await newPage(alpha.id, me, `Alpha notes ${W}`, `${W} harness plan for alpha`)
    page.beta = await newPage(beta.id, me, `Beta notes ${W}`, `${W} harness plan for beta`)
    page.gamma = await newPage(gamma.id, me, `Gamma notes ${W}`, `${W} harness plan for gamma`)
    mcp = await h.connectMcp(app, me, await h.mintToken(me))
    mateMcp = await h.connectMcp(app, mate, await h.mintToken(mate))
  })

  const archive = async (u: U, wsId: string, archived: boolean) => {
    const r = await asCookie(u, 'PATCH', `/me/workspaces/${wsId}/listing`, { archived })
    assert.equal(r.statusCode, 200, r.body)
    return r.json() as { listing: { archived?: true } }
  }
  const NOTE = /^Not searched: 1 archived workspace \([0-9a-f]{8} "Gamma Old Contest"\); pass workspaceId=<id or name> to include one\.$/m

  describe('the default scope', () => {
    it('find_context: an archived workspace is left out and named in one closing line; by name it is searched', async () => {
      const before = (await mcp.tool('find_context', { query: `${W} harness` })).text
      assert.match(before, /for gamma/)
      assert.doesNotMatch(before, /Not searched/)
      assert.equal((await archive(me, gamma.id, true)).listing.archived, true)
      // the result cache keys on the searched workspaces: the change shows at once
      const after = (await mcp.tool('find_context', { query: `${W} harness` })).text
      assert.doesNotMatch(after, /for gamma/)
      assert.match(after, /for alpha/)
      assert.match(after, NOTE)
      assert.ok(after.trimEnd().endsWith('to include one.'), after)
      // deterministic: the same call, the same bytes
      assert.equal((await mcp.tool('find_context', { query: `${W} harness` })).text, after)
      for (const ref of ['Gamma Old', gamma.id.slice(0, 8), gamma.id]) {
        const one = (await mcp.tool('find_context', { query: `${W} harness`, workspaceId: ref })).text
        assert.match(one, /for gamma/, ref)
        assert.doesNotMatch(one, /Not searched/)
      }
      // nothing found: the line is still there
      const none = (await mcp.tool('find_context', { query: `${W}nothing${W}` })).text
      assert.match(none, /^No sections match/)
      assert.match(none, NOTE)
    })

    it('another member of the same workspace is not affected', async () => {
      const t = (await mateMcp.tool('find_context', { query: `${W} harness` })).text
      assert.match(t, /for gamma/)
      assert.doesNotMatch(t, /Not searched/)
      const s = (await mateMcp.tool('search', { query: W, format: 'lines' })).text
      assert.match(s, /Gamma notes/)
    })

    it('search: left out with the line (text, no results, json); by name included', async () => {
      const t = (await mcp.tool('search', { query: W })).text
      assert.match(t, /Alpha notes/)
      assert.doesNotMatch(t, /Gamma notes/)
      assert.match(t, NOTE)
      const json = JSON.parse((await mcp.tool('search', { query: W, format: 'json' })).text) as { archivedNotSearched?: { workspaceId: string; workspace: string }[]; results: { title: string }[] }
      assert.deepEqual(json.archivedNotSearched, [{ workspaceId: gamma.id, workspace: 'Gamma Old Contest' }])
      assert.ok(!json.results.some((r) => r.title.startsWith('Gamma')))
      const none = (await mcp.tool('search', { query: `${W}nothing` })).text
      assert.match(none, /^No pages match/)
      assert.match(none, NOTE)
      const one = (await mcp.tool('search', { query: W, workspaceId: 'Gamma Old Contest' })).text
      assert.match(one, /Gamma notes/)
      assert.doesNotMatch(one, /Not searched/)
      // the REST route says the same to the web app and the API
      const rest = await asCookie(me, 'GET', `/search?q=${W}`)
      assert.deepEqual((rest.json() as { archived: unknown }).archived, [{ id: gamma.id, name: 'Gamma Old Contest' }])
    })

    it('list_workspaces keeps listing it, marked archived', async () => {
      const list = (await mcp.tool('list_workspaces')).text
      assert.match(list, new RegExp(`"id":\\s*"${gamma.id}"[^}]*"archived":\\s*true`))
      assert.doesNotMatch(list.split(alpha.id)[1].split('}')[0], /archived/)
    })

    it('catch_up: changes and comments of an archived workspace are left out; a mention there still is "for you"', async () => {
      const cursor = /cursor: (\S+)\s*$/.exec((await mcp.tool('changes_since')).text)![1]
      const g2 = await newPage(gamma.id, mate, `Gamma later ${W}`, 'mate wrote this')
      const a2 = await newPage(alpha.id, mate, `Alpha later ${W}`, 'mate wrote this too')
      await db.insert(schema.notifications).values({ userId: me.id, actorId: mate.id, type: 'doc_mention', workspaceId: gamma.id, pageId: g2, excerpt: `mention in gamma ${W}` } as never)
      const r = (await mcp.tool('catch_up', { since: '2000-01-01T00:00Z', peek: true, budget: 12000 })).text
      assert.match(r, /Alpha later/)
      assert.doesNotMatch(r, /Gamma later "|page added "Gamma later/)
      assert.match(r, /mention in gamma/)
      assert.match(r, /^Not included: changes, comments and due tasks of 1 archived workspace \([0-9a-f]{8} "Gamma Old Contest"\); items for you from them are\. Pass workspaceId=<id or name> for one\.$/m)
      // the two moving lines stay last
      assert.match(r, /\ndue window: up to \S+\nnext since: \S+ \(up to \S+\)$/)
      const one = (await mcp.tool('catch_up', { workspaceId: 'Gamma Old', since: '2000-01-01T00:00Z', peek: true, budget: 12000 })).text
      assert.match(one, /Gamma later/)
      assert.doesNotMatch(one, /Not included/)
      // inbox is not narrowed: what calls the person always arrives
      assert.match((await mcp.tool('inbox')).text, /mention in gamma/)
      // changes_since (a sync cursor) is not narrowed either
      assert.match((await mcp.tool('changes_since', { cursor })).text, /Gamma later/)
      void a2
    })

    it('a connection limited to some workspaces: its range decides, archive or not', async () => {
      const token = await h.mintToken(me)
      await db
        .update(schema.oauthGrants)
        .set({ rangeKind: 'workspaces', rangeWorkspaceIds: [gamma.id, alpha.id] })
        .where(eq(schema.oauthGrants.accessHash, sha(token)))
      const user = (await getBearerUser(token))!
      assert.equal(user.range?.kind, 'workspaces')
      const ranged = await h.connectMcp(app, user, token)
      try {
        const t = (await ranged.tool('find_context', { query: `${W} harness` })).text
        assert.match(t, /for gamma/)
        assert.doesNotMatch(t, /for beta|Not searched/)
        const s = (await ranged.tool('search', { query: W })).text
        assert.match(s, /Gamma notes/)
        assert.doesNotMatch(s, /Not searched/)
      } finally {
        await ranged.close()
      }
    })

    it('unarchived: back in the default scope at once, line gone', async () => {
      await archive(me, gamma.id, false)
      const t = (await mcp.tool('find_context', { query: `${W} harness` })).text
      assert.match(t, /for gamma/)
      assert.doesNotMatch(t, /Not searched/)
      assert.doesNotMatch((await mcp.tool('search', { query: W })).text, /Not searched/)
    })
  })

  describe('groups and order (browser sessions only)', () => {
    let contests: string
    let classes: string

    it('create, rename, fold, order; workspaces move in and keep their order', async () => {
      const c = await asCookie(me, 'POST', '/me/workspace-groups', { name: '  Contests ' })
      assert.equal(c.statusCode, 200, c.body)
      contests = (c.json() as { group: { id: string; name: string } }).group.id
      assert.equal((c.json() as { group: { name: string } }).group.name, 'Contests')
      classes = ((await asCookie(me, 'POST', '/me/workspace-groups', { name: 'Classes' })).json() as { group: { id: string } }).group.id
      assert.equal((await asCookie(me, 'PATCH', `/me/workspace-groups/${classes}`, { name: 'Lectures', collapsed: true })).statusCode, 200)
      assert.equal((await asCookie(me, 'PUT', '/me/workspace-groups/order', { ids: [classes] })).statusCode, 200)
      const groups = ((await asCookie(me, 'GET', '/me/workspace-groups')).json() as { groups: { id: string; name: string; collapsed: boolean }[] }).groups
      assert.deepEqual(groups, [
        { id: classes, name: 'Lectures', collapsed: true },
        { id: contests, name: 'Contests', collapsed: false },
      ])
      assert.equal((await asCookie(me, 'PUT', '/me/workspace-order', { groupId: contests, ids: [gamma.id, alpha.id] })).statusCode, 204)
      assert.equal((await asCookie(me, 'PATCH', `/me/workspaces/${beta.id}/listing`, { groupId: classes })).statusCode, 200)
      const ws = ((await asCookie(me, 'GET', '/workspaces')).json() as { workspaces: { id: string; listing?: Record<string, unknown> }[] }).workspaces
      const of = (id: string) => ws.find((w) => w.id === id)!.listing
      assert.deepEqual(of(gamma.id), { groupId: contests, group: 'Contests', position: 0 })
      assert.deepEqual(of(alpha.id), { groupId: contests, group: 'Contests', position: 1 })
      assert.deepEqual(of(beta.id), { groupId: classes, group: 'Lectures', position: 0 })
      // the list order itself is unchanged (search and list_workspaces print in it)
      assert.deepEqual(ws.filter((w) => [alpha.id, beta.id, gamma.id].includes(w.id)).map((w) => w.id), [alpha.id, beta.id, gamma.id])
      // the other member's list knows nothing of it
      const theirs = ((await asCookie(mate, 'GET', '/workspaces')).json() as { workspaces: { listing?: unknown }[] }).workspaces
      assert.ok(theirs.every((w) => w.listing === undefined))
      const lw = (await mcp.tool('list_workspaces')).text
      assert.match(lw, new RegExp(`"id":\\s*"${alpha.id}"[^}]*"group":\\s*"Contests"`))
    })

    it('archive a whole group, then bring it back; deleting a group keeps its workspaces (ungrouped, still archived)', async () => {
      const a = await asCookie(me, 'POST', `/me/workspace-groups/${contests}/archive`, { archived: true })
      assert.deepEqual(a.json(), { count: 2 })
      const t = (await mcp.tool('find_context', { query: `${W} harness` })).text
      assert.match(t, /^Not searched: 2 archived workspaces \([0-9a-f]{8} "Alpha Cup", [0-9a-f]{8} "Gamma Old Contest"\); /m)
      assert.match(t, /for beta/)
      assert.equal((await asCookie(me, 'POST', `/me/workspace-groups/${contests}/archive`, { archived: false })).statusCode, 200)
      assert.doesNotMatch((await mcp.tool('find_context', { query: `${W} harness` })).text, /Not searched/)
      await archive(me, gamma.id, true)
      assert.equal((await asCookie(me, 'DELETE', `/me/workspace-groups/${contests}`)).statusCode, 204)
      const ws = ((await asCookie(me, 'GET', '/workspaces')).json() as { workspaces: { id: string; listing?: Record<string, unknown> }[] }).workspaces
      const g = ws.find((w) => w.id === gamma.id)!.listing!
      assert.equal(g.archived, true)
      assert.equal(g.groupId, undefined)
      await archive(me, gamma.id, false)
    })

    it("another person's groups do not exist for you; tokens cannot change the list; bad input is refused", async () => {
      const theirs = ((await asCookie(mate, 'POST', '/me/workspace-groups', { name: 'Mine' })).json() as { group: { id: string } }).group.id
      assert.equal((await asCookie(me, 'PATCH', `/me/workspace-groups/${theirs}`, { name: 'Taken' })).statusCode, 404)
      assert.equal((await asCookie(me, 'DELETE', `/me/workspace-groups/${theirs}`)).statusCode, 404)
      assert.equal((await asCookie(me, 'POST', `/me/workspace-groups/${theirs}/archive`, { archived: true })).statusCode, 404)
      assert.equal((await asCookie(me, 'PATCH', `/me/workspaces/${alpha.id}/listing`, { groupId: theirs })).statusCode, 404)
      assert.equal((await asCookie(me, 'PUT', '/me/workspace-order', { groupId: theirs, ids: [alpha.id] })).statusCode, 404)
      assert.equal((await asCookie(me, 'PUT', '/me/workspace-groups/order', { ids: [theirs] })).statusCode, 404)
      // still theirs, unchanged
      const [g] = await db.select().from(schema.workspaceListGroups).where(eq(schema.workspaceListGroups.id, theirs))
      assert.equal(g.name, 'Mine')
      // a workspace the caller cannot open is "not found"
      const foreign = await h.makeWorkspace(stranger, [], 'Stranger Space')
      assert.equal((await asCookie(me, 'PATCH', `/me/workspaces/${foreign.id}/listing`, { archived: true })).statusCode, 404)
      assert.equal((await asCookie(me, 'PUT', '/me/workspace-order', { groupId: null, ids: [foreign.id] })).statusCode, 404)
      // tokens: read the effect, never change the list
      const pat = await asCookie(me, 'POST', '/tokens', { name: 'list', expiresInDays: 30, access: 'write', range: { kind: 'all' } })
      assert.equal(pat.statusCode, 201, pat.body)
      const token = (pat.json() as { secret: string }).secret
      for (const [method, url, payload] of [
        ['GET', '/me/workspace-groups', undefined],
        ['POST', '/me/workspace-groups', { name: 'x' }],
        ['PATCH', `/me/workspaces/${alpha.id}/listing`, { archived: true }],
      ] as const) {
        const r = await app.inject({ method, url: `/api${url}`, headers: { authorization: `Bearer ${token}` }, ...(payload ? { payload } : {}) })
        assert.equal(r.statusCode, 403, `${method} ${url}`)
      }
      assert.equal((await asCookie(me, 'POST', '/me/workspace-groups', { name: '   ' })).statusCode, 400)
      assert.equal((await asCookie(me, 'POST', '/me/workspace-groups', { name: 'x'.repeat(41) })).statusCode, 400)
      assert.equal((await asCookie(me, 'PATCH', `/me/workspaces/${alpha.id}/listing`, {})).statusCode, 400)
    })
  })

  describe('guests and cleanup', () => {
    it('a guest arranges the workspace they were shared into; a stranger cannot', async () => {
      const owner = await h.makeUser('GuestOwner')
      const guest = await h.makeUser('Guest')
      const ws = await h.makeWorkspace(owner, [], 'Shared Into')
      const pg = await h.makeDocPage(ws.id, owner.id, 'Shared page', [] as never)
      await db.insert(schema.pageGrants).values({ pageId: pg.id, userId: guest.id, level: 'view', createdBy: owner.id })
      const r = await asCookie(guest, 'PATCH', `/me/workspaces/${ws.id}/listing`, { archived: true })
      assert.equal(r.statusCode, 200, r.body)
      const list = ((await asCookie(guest, 'GET', '/workspaces')).json() as { workspaces: { id: string; role: string; listing?: { archived?: true } }[] }).workspaces
      const mine = list.find((w) => w.id === ws.id)!
      assert.equal(mine.role, 'guest')
      assert.equal(mine.listing?.archived, true)
      // still a guest: workspace-wide routes stay closed
      assert.equal((await asCookie(guest, 'GET', `/workspaces/${ws.id}/members`)).statusCode, 403)
      assert.equal((await asCookie(stranger, 'PATCH', `/me/workspaces/${ws.id}/listing`, { archived: true })).statusCode, 404)
    })

    it('leaving or being removed drops the rows; soft delete keeps them, the purge and account deletion drop them', async () => {
      const owner = await h.makeUser('CleanOwner')
      const leaver = await h.makeUser('Leaver')
      const ws1 = await h.makeWorkspace(owner, [leaver], 'Leave Me')
      const ws2 = await h.makeWorkspace(owner, [leaver], 'Remove Me')
      const ws3 = await h.makeWorkspace(owner, [leaver], 'Delete Me')
      for (const w of [ws1, ws2, ws3]) await archive(leaver, w.id, true)
      const rows = async (u: { id: string }, wsId: string) =>
        (await db.select().from(schema.workspaceListings).where(and(eq(schema.workspaceListings.userId, u.id), eq(schema.workspaceListings.workspaceId, wsId)))).length
      assert.equal((await asCookie(leaver, 'DELETE', `/workspaces/${ws1.id}/members/${leaver.id}`)).statusCode, 204)
      assert.equal(await rows(leaver, ws1.id), 0)
      assert.equal((await asCookie(owner, 'DELETE', `/workspaces/${ws2.id}/members/${leaver.id}`)).statusCode, 204)
      assert.equal(await rows(leaver, ws2.id), 0)
      // soft delete: the arrangement waits for a restore
      const del = await asCookie(owner, 'DELETE', `/workspaces/${ws3.id}`, { name: 'Delete Me' })
      assert.equal(del.statusCode, 204, del.body)
      assert.equal(await rows(leaver, ws3.id), 1)
      const { purgeWorkspacesTx } = await import('./workspaceDeletion')
      await db.update(schema.workspaces).set({ deletedAt: new Date(Date.now() - 40 * 86_400_000) }).where(eq(schema.workspaces.id, ws3.id))
      await db.transaction((tx) => purgeWorkspacesTx(tx as never, [ws3.id]))
      assert.equal(await rows(leaver, ws3.id), 0)
      // account deletion: groups and listings go with it
      const gone = await h.makeUser('Gone')
      const ws4 = await h.makeWorkspace(gone, [], 'Gone WS')
      await asCookie(gone, 'POST', '/me/workspace-groups', { name: 'G' })
      await archive(gone, ws4.id, true)
      await db.delete(schema.workspaceMembers).where(eq(schema.workspaceMembers.userId, gone.id))
      await db.delete(schema.users).where(eq(schema.users.id, gone.id))
      assert.equal((await db.select().from(schema.workspaceListGroups).where(eq(schema.workspaceListGroups.userId, gone.id))).length, 0)
      assert.equal(await rows(gone, ws4.id), 0)
    })
  })
})
