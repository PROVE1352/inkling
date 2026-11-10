// Onboarding (docs/adr/2380-*, 2381-*): new vs existing accounts, checklist items ticked by what people
// actually do, isolation between people, browser sessions only, guests left out, the sample page in a
// member's private pages by button only, and ONBOARDING=off.
// The first admin's automatic sample needs an empty server: onboardingFirstAdmin.db.test.ts.
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.DATA_DIR ||= `${process.env.TMPDIR || '/tmp'}/inkling-onboarding-${process.pid}`
delete process.env.ONBOARDING

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, describe, it } from 'node:test'

const HAS_DB = !!process.env.DATABASE_URL

describe('[db] onboarding', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const h = await import('../mcpTools/testHarness')
  const { db, closeDb } = await import('../db/index')
  const schema = await import('../db/schema')
  const { and, eq, inArray, sql } = await import('drizzle-orm')
  const collab = await import('../collab')
  const { reindexPageLinks } = await import('../md/linkIndex')
  const { stateToBlocks } = await import('../md/convert')
  const app = await h.buildTestApp()

  after(async () => {
    await collab.destroyCollab()
    await app.close()
    await closeDb()
  })

  type U = Awaited<ReturnType<typeof h.makeUser>>
  type DTO = import('@inkling/shared').OnboardingDTO
  const call = (u: U | null, method: 'GET' | 'PATCH' | 'POST' | 'DELETE', url: string, payload?: object, headers: Record<string, string> = {}) =>
    app.inject({ method, url, headers: { ...(u ? { cookie: u.cookie } : {}), ...headers }, ...(payload ? { payload } : {}) })
  const get = async (u: U, headers: Record<string, string> = {}): Promise<DTO> => {
    const r = await call(u, 'GET', '/api/me/onboarding', undefined, headers)
    assert.equal(r.statusCode, 200, r.body)
    return r.json() as DTO
  }
  const patch = async (u: U, body: object): Promise<DTO> => {
    const r = await call(u, 'PATCH', '/api/me/onboarding', body)
    assert.equal(r.statusCode, 200, r.body)
    return r.json() as DTO
  }
  const done = (d: DTO) => d.checklist.items.filter((i) => i.done).map((i) => i.id).sort()
  const stored = async (u: U) =>
    (await db.select().from(schema.userOnboarding).where(eq(schema.userOnboarding.userId, u.id)))[0]?.state as Record<string, unknown> | undefined

  it('a new account: the intro plays once, the checklist shows with nothing done', async () => {
    const u = await h.makeUser('fresh')
    await h.makeWorkspace(u)
    assert.equal(await stored(u), undefined, 'no row before the first read')
    const d = await get(u)
    assert.equal(d.enabled, true)
    assert.equal(d.audience, 'owner')
    assert.equal(d.intro, true)
    assert.equal(d.checklist.show, true)
    assert.deepEqual(d.checklist.items.map((i) => i.id), ['page', 'slash', 'link', 'database', 'share', 'ai', 'install'])
    assert.deepEqual(done(d), [])
    assert.deepEqual(d.samples, {}, 'not the first admin of the server: no sample by itself')
    assert.equal((await stored(u))?.autoSample, 'none')
    // Still on until it is closed; closed once = closed on every device.
    assert.equal((await get(u)).intro, true)
    assert.equal((await patch(u, { introSeen: true })).intro, false)
    assert.equal((await get(u)).intro, false)
  })

  it('an account from before the feature (row from migration 0060): no intro, no checklist until turned on', async () => {
    const u = await h.makeUser('legacy')
    await h.makeWorkspace(u)
    // The statement migration 0060 runs on upgrade gives every account without a row `{legacy: true}`.
    const file = readFileSync(new URL('../../drizzle/0060_onboarding.sql', import.meta.url), 'utf8')
    const backfill = file.split('--> statement-breakpoint').map((s) => s.trim()).find((s) => /INSERT INTO "user_onboarding"/.test(s))
    assert.ok(backfill, 'the migration backfills existing accounts')
    await db.execute(sql.raw(backfill!.replace(/^--.*\n/gm, '').replace(/;\s*$/, '')))
    assert.deepEqual(await stored(u), { legacy: true })

    const d = await get(u)
    assert.equal(d.intro, false)
    assert.equal(d.checklist.show, false)
    assert.equal(d.checklist.dismissed, true)
    // Settings › "Show the Getting started checklist"
    const on = await patch(u, { dismissed: false })
    assert.equal(on.checklist.show, true)
    assert.equal(on.intro, false, 'turning the checklist on never plays the intro by itself')
    assert.equal((await patch(u, { dismissed: true })).checklist.show, false)
  })

  it('items are ticked by what the person does, and stay ticked', async () => {
    const u = await h.makeUser('doer')
    const other = await h.makeUser('joiner')
    const ws = await h.makeWorkspace(u)
    await get(u)

    // a page
    const pg = await call(u, 'POST', '/api/pages', { workspaceId: ws.id, title: 'First' })
    assert.equal(pg.statusCode, 200, pg.body)
    const pageId = (pg.json() as { id?: string; page?: { id: string } }).page?.id ?? (pg.json() as { id: string }).id
    assert.deepEqual(done(await get(u)), ['page'])

    // a database
    const coll = await call(u, 'POST', '/api/pages', { workspaceId: ws.id, title: 'Tasks', kind: 'collection' })
    assert.equal(coll.statusCode, 200, coll.body)
    assert.deepEqual(done(await get(u)), ['database', 'page'])

    // a link from a page they wrote
    const linkBlocks = [{ type: 'paragraph', content: [{ type: 'link', href: `/w/${ws.id}/p/${pageId}`, content: [{ type: 'text', text: 'First', styles: {} }] }] }]
    const src = await h.makeDocPage(ws.id, u.id, 'Linker', linkBlocks as never)
    await reindexPageLinks(src.id, linkBlocks as never)
    assert.ok(done(await get(u)).includes('link'))

    // sharing: a public link
    const share = await call(u, 'POST', `/api/pages/${pageId}/share`, {})
    assert.ok(share.statusCode < 300, share.body)
    assert.ok(done(await get(u)).includes('share'))

    // an agent connection
    await h.mintToken(u)
    assert.ok(done(await get(u)).includes('ai'))

    // browser-only events
    const ev = await patch(u, { event: 'slash' })
    assert.ok(done(ev).includes('slash'))
    assert.equal(ev.checklist.complete, true, 'install is optional')
    assert.equal(ev.checklist.show, false, 'a finished checklist goes away by itself')

    // sticky: the page in the trash does not take the tick back
    assert.equal((await call(u, 'DELETE', `/api/pages/${pageId}`)).statusCode < 300, true)
    assert.ok(done(await get(u)).includes('page'))

    // Settings can bring a finished one back
    assert.equal((await patch(u, { dismissed: false })).checklist.show, true)

    // a second person who joins one's workspace also counts as sharing for its maker
    const u2 = await h.makeUser('inviter')
    const ws2 = await h.makeWorkspace(u2, [other])
    assert.ok(ws2.id)
    assert.ok(done(await get(u2)).includes('share'))
  })

  it('a member of someone else’s workspace gets the member list; no sample by itself, one by button in private pages', async () => {
    const owner = await h.makeUser('teamowner')
    const m = await h.makeUser('member')
    const team = await h.makeWorkspace(owner, [m])
    await h.makeWorkspace(m) // the personal workspace every sign-up gets
    const ko = { 'accept-language': 'ko-KR,ko;q=0.9' }
    const d = await get(m, ko)
    assert.equal(d.audience, 'member')
    assert.deepEqual(d.checklist.items.map((i) => i.id), ['explore', 'page', 'slash', 'link', 'comment', 'ai', 'install'])
    assert.deepEqual(d.samples, {})
    const before = await db.select({ id: schema.pages.id }).from(schema.pages).where(eq(schema.pages.workspaceId, team.id))
    assert.equal(before.length, 0, 'nothing was made in the team workspace')

    const r = await call(m, 'POST', '/api/me/onboarding/sample', { workspaceId: team.id }, ko)
    assert.equal(r.statusCode, 200, r.body)
    const res = r.json() as { pageId: string; created: boolean }
    assert.equal(res.created, true)
    const made = await db.select().from(schema.pages).where(eq(schema.pages.workspaceId, team.id))
    const root = made.find((p) => p.id === res.pageId)!
    assert.equal(root.title, 'Inkling 시작하기 (샘플)', 'in the person’s language')
    assert.equal(root.scope, 'private')
    assert.ok(made.every((p) => p.scope === 'private' && p.createdBy === m.id))
    const coll = made.find((p) => p.kind === 'collection')!
    assert.ok(coll, 'a small database')
    assert.equal((await db.select().from(schema.collectionViews).where(eq(schema.collectionViews.pageId, coll.id))).length, 3)
    // the document's database view points at this copy's database (template embed remap)
    const [docRow] = await db.select().from(schema.pageDocs).where(eq(schema.pageDocs.pageId, root.id))
    const blocks = stateToBlocks(docRow.state)
    const embed = blocks.find((b) => b.type === 'pageEmbed') as { props: { pageId: string } } | undefined
    assert.equal(embed?.props.pageId, coll.id)
    assert.ok(blocks.some((b) => b.type === 'codeBlock' && (b.props as { language?: string }).language === 'mermaid'))
    assert.ok(blocks.some((b) => b.type === 'callout'))
    assert.ok(blocks.some((b) => b.type === 'checkListItem'))

    // the owner cannot see it (private), and it does not tick the member's own items
    const ownerTree = await call(owner, 'GET', `/api/workspaces/${team.id}/pages`)
    assert.equal(ownerTree.statusCode, 200)
    assert.ok(!ownerTree.body.includes(root.id))
    const after1 = await get(m)
    assert.deepEqual(after1.samples, { [team.id]: root.id })
    assert.deepEqual(done(after1), [], 'the sample’s own pages, links and database do not count')

    // once per workspace: a second click returns the same page
    const again = (await call(m, 'POST', '/api/me/onboarding/sample', { workspaceId: team.id })).json() as { pageId: string; created: boolean }
    assert.deepEqual(again, { pageId: root.id, workspaceId: team.id, created: false })

    // deleted: not made again by itself; the button makes a new one
    assert.ok((await call(m, 'DELETE', `/api/pages/${root.id}`)).statusCode < 300)
    assert.deepEqual((await get(m)).samples, {})
    const live = await db
      .select({ id: schema.pages.id })
      .from(schema.pages)
      .where(and(eq(schema.pages.workspaceId, team.id), sql`${schema.pages.deletedAt} IS NULL`))
    assert.equal(live.length, 0)
    const third = (await call(m, 'POST', '/api/me/onboarding/sample', { workspaceId: team.id })).json() as { pageId: string; created: boolean }
    assert.equal(third.created, true)
    assert.notEqual(third.pageId, root.id)
    // English when the person reads English
    const en = await call(m, 'POST', '/api/me/onboarding/sample', { workspaceId: (await h.makeWorkspace(m)).id }, { 'accept-language': 'en-US' })
    const enRoot = (await db.select().from(schema.pages).where(eq(schema.pages.id, (en.json() as { pageId: string }).pageId)))[0]
    assert.equal(enRoot.title, 'Getting started with Inkling (sample)')
  })

  it('is per person: nobody reads or changes another person’s state or makes a sample where they are not a member', async () => {
    const a = await h.makeUser('alice')
    const b = await h.makeUser('bob')
    const wsA = await h.makeWorkspace(a)
    await get(a)
    await get(b)
    await patch(a, { introSeen: true, collapsed: false, event: 'slash' })
    const db2 = await get(b)
    assert.equal(db2.intro, true)
    assert.equal(db2.checklist.collapsed, true, 'folded by default')
    assert.ok(!done(db2).includes('slash'))
    // Unknown fields (such as a user id) are refused, not ignored.
    assert.equal((await call(b, 'PATCH', '/api/me/onboarding', { userId: a.id, introSeen: true })).statusCode, 400)
    assert.equal((await call(b, 'PATCH', '/api/me/onboarding', {})).statusCode, 400)
    assert.equal((await call(b, 'PATCH', '/api/me/onboarding', { event: 'page' })).statusCode, 400, 'server-known items are not events')
    assert.equal((await call(b, 'POST', '/api/me/onboarding/sample', { workspaceId: wsA.id })).statusCode, 403)
    assert.equal((await get(a)).intro, false)
  })

  it('browser sessions only: no cookie 401, an agent token 403 on every route', async () => {
    const u = await h.makeUser('agentless')
    const ws = await h.makeWorkspace(u)
    assert.equal((await call(null, 'GET', '/api/me/onboarding')).statusCode, 401)
    const { MCP_INTERNAL_HEADER, MCP_INTERNAL_SECRET } = await import('../oauth')
    const token = await h.mintToken(u)
    const auth = { authorization: `Bearer ${token}`, [MCP_INTERNAL_HEADER]: MCP_INTERNAL_SECRET }
    assert.equal((await call(null, 'GET', '/api/me/onboarding', undefined, auth)).statusCode, 403)
    assert.equal((await call(null, 'PATCH', '/api/me/onboarding', { introSeen: true }, auth)).statusCode, 403)
    assert.equal((await call(null, 'POST', '/api/me/onboarding/sample', { workspaceId: ws.id }, auth)).statusCode, 403)
    assert.equal(await stored(u), undefined)
    assert.equal((await db.select().from(schema.pages).where(eq(schema.pages.workspaceId, ws.id))).length, 0)
  })

  it('guests (pages shared with them, no team workspace) get no onboarding and cannot make a sample there', async () => {
    const o = await h.makeUser('host')
    const g = await h.makeUser('guest')
    const ws = await h.makeWorkspace(o)
    await h.makeWorkspace(g)
    const pg = await h.makeDocPage(ws.id, o.id, 'Shared', [{ type: 'paragraph', content: [] }] as never)
    await db.insert(schema.pageGrants).values({ pageId: pg.id, userId: g.id, level: 'edit', createdBy: o.id })
    const d = await get(g)
    assert.equal(d.audience, 'guest')
    assert.equal(d.intro, false)
    assert.equal(d.checklist.show, false)
    assert.deepEqual(d.checklist.items, [])
    assert.equal((await call(g, 'POST', '/api/me/onboarding/sample', { workspaceId: ws.id })).statusCode, 403)
    const made = await db.select().from(schema.pages).where(and(eq(schema.pages.workspaceId, ws.id), eq(schema.pages.createdBy, g.id)))
    assert.equal(made.length, 0)
  })

  it('ONBOARDING=off: nothing shows, nothing is made, and accounts first seen then count as existing later', async () => {
    const u = await h.makeUser('offline-op')
    const ws = await h.makeWorkspace(u)
    process.env.ONBOARDING = 'off'
    try {
      const d = await get(u)
      assert.equal(d.enabled, false)
      assert.equal(d.intro, false)
      assert.equal(d.checklist.show, false)
      assert.equal((await patch(u, { introSeen: true })).enabled, false)
      assert.equal((await call(u, 'POST', '/api/me/onboarding/sample', { workspaceId: ws.id })).statusCode, 404)
      assert.equal((await db.select().from(schema.pages).where(eq(schema.pages.workspaceId, ws.id))).length, 0)
    } finally {
      delete process.env.ONBOARDING
    }
    const later = await get(u)
    assert.equal(later.enabled, true)
    assert.equal(later.intro, false, 'not new any more when the operator turns it on')
    assert.equal(later.checklist.show, false)
    assert.ok(inArray)
  })
})
