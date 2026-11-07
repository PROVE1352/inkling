// [db] Former page titles (docs/adr/1121-*): [[old title]] after renames, name taken back, name
// reused by another page (current title wins), private pages, and an end-to-end write through
// PATCH /pages/:id + POST /pages/:id/content.
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.DATA_DIR ||= `${process.env.TMPDIR || '/tmp'}/inkling-former-${process.pid}`

import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'
import { UnionFind } from '@inkling/shared'

const HAS_DB = !!process.env.DATABASE_URL

describe('[db] former titles: [[old name]] after a rename', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const h = await import('./mcpTools/testHarness')
  const { db, closeDb } = await import('./db/index')
  const schema = await import('./db/schema')
  const { eq } = await import('drizzle-orm')
  const collab = await import('./collab')
  const { buildTitleResolver } = await import('./md/importer')
  const { stateToBlocks } = await import('./md/convert')
  const app = await h.buildTestApp()

  after(async () => {
    await collab.destroyCollab()
    await app.close()
    await closeDb()
  })

  type U = Awaited<ReturnType<typeof h.makeUser>>
  const rename = async (u: U, id: string, title: string) => {
    const r = await app.inject({ method: 'PATCH', url: `/api/pages/${id}`, headers: { cookie: u.cookie }, payload: { title } })
    assert.equal(r.statusCode, 200, r.body)
  }
  const newPage = async (u: U, ws: string, title: string, scope: 'shared' | 'private' = 'shared') => {
    const r = await app.inject({ method: 'POST', url: '/api/pages', headers: { cookie: u.cookie }, payload: { workspaceId: ws, title, scope } })
    assert.equal(r.statusCode, 200, r.body)
    return (r.json() as { page: { id: string } }).page.id
  }
  /** Page id [[title]] resolves to for `u`, or null. */
  const resolve = async (u: U, ws: string, title: string) => {
    const url = (await buildTitleResolver(ws, new Map(), u.id))(title)
    return url ? url.split('/p/')[1] : null
  }

  it('A → B → C: [[A]] and [[B]] reach the page in one hop; [[C]] by its title', async () => {
    const u = await h.makeUser('chain')
    const ws = (await h.makeWorkspace(u)).id
    const p = await newPage(u, ws, 'Alpha')
    await rename(u, p, 'Beta')
    await rename(u, p, 'Gamma')
    assert.equal(await resolve(u, ws, 'Alpha'), p)
    assert.equal(await resolve(u, ws, 'alpha'), p, 'case-insensitive like current titles')
    assert.equal(await resolve(u, ws, 'Beta'), p)
    assert.equal(await resolve(u, ws, 'Gamma'), p)
    // Stored flat: every former name points at the page id, none at another name.
    const rows = await db.select().from(schema.pageFormerTitles).where(eq(schema.pageFormerTitles.workspaceId, ws))
    assert.deepEqual(rows.map((r) => [r.titleKey, r.pageId]).sort(), [['alpha', p], ['beta', p]])
  })

  it('renamed back to A: the row for A is dropped and A is the current title again', async () => {
    const u = await h.makeUser('back')
    const ws = (await h.makeWorkspace(u)).id
    const p = await newPage(u, ws, 'Alpha')
    await rename(u, p, 'Beta')
    await rename(u, p, 'Alpha')
    const rows = await db.select().from(schema.pageFormerTitles).where(eq(schema.pageFormerTitles.workspaceId, ws))
    assert.deepEqual(rows.map((r) => r.titleKey), ['beta'])
    assert.equal(await resolve(u, ws, 'Alpha'), p)
    assert.equal(await resolve(u, ws, 'Beta'), p)
  })

  it('another page takes the name A: its current title wins; when it lets A go, the newest holder wins', async () => {
    const u = await h.makeUser('reuse')
    const ws = (await h.makeWorkspace(u)).id
    const p1 = await newPage(u, ws, 'Alpha')
    await rename(u, p1, 'Beta') // A → p1 (former)
    const p2 = await newPage(u, ws, 'Alpha') // A is p2's current title
    assert.equal(await resolve(u, ws, 'Alpha'), p2, 'current title beats a former title')
    assert.equal(await resolve(u, ws, 'Beta'), p1)
    await rename(u, p2, 'Delta') // p2 gives A up: A → p2 replaces A → p1
    assert.equal(await resolve(u, ws, 'Alpha'), p2)
    // p1 is still reachable by its own names
    assert.equal(await resolve(u, ws, 'Beta'), p1)
  })

  it("a private page that once held a shared page's old name does not take it away from others", async () => {
    const owner = await h.makeUser('pub')
    const x = await h.makeUser('prv')
    const ws = (await h.makeWorkspace(owner, [x])).id
    const shared = await newPage(owner, ws, 'Alpha')
    await rename(owner, shared, 'Beta') // Alpha → shared page
    const secret = await newPage(x, ws, 'Alpha', 'private')
    await rename(x, secret, 'Delta') // Alpha → x's private page, renamed later
    assert.equal(await resolve(owner, ws, 'Alpha'), shared, 'unchanged for everyone who cannot see the private page')
    assert.equal(await resolve(x, ws, 'Alpha'), secret, 'its author gets the newest holder they can see')
    const rows = await db.select().from(schema.pageFormerTitles).where(eq(schema.pageFormerTitles.workspaceId, ws))
    assert.equal(rows.filter((r) => r.titleKey === 'alpha').length, 2, 'one row per page that held the name')
  })

  it('a name-level union-find would merge the two pages (why the table is keyed by page id)', () => {
    // Names as elements, a rename = union(old, new). Same history as the test above:
    // p1: Alpha → Beta, then p2: Alpha → Delta.
    const names = ['Alpha', 'Beta', 'Delta']
    const ix = (n: string) => names.indexOf(n)
    const uf = new UnionFind(names.length)
    uf.union(ix('Alpha'), ix('Beta'))
    uf.union(ix('Alpha'), ix('Delta'))
    // p1's name and p2's name end up in one set: nothing in the structure can split them again.
    assert.equal(uf.same(ix('Beta'), ix('Delta')), true)
  })

  it('an alias beats a former title; a trashed page no longer answers to its old name', async () => {
    const u = await h.makeUser('alias')
    const ws = (await h.makeWorkspace(u)).id
    const p1 = await newPage(u, ws, 'Alpha')
    await rename(u, p1, 'Beta')
    const p2 = await newPage(u, ws, 'Other')
    const r = await app.inject({ method: 'PATCH', url: `/api/pages/${p2}`, headers: { cookie: u.cookie }, payload: { aliases: ['alpha'] } })
    assert.equal(r.statusCode, 200, r.body)
    assert.equal(await resolve(u, ws, 'Alpha'), p2)
    await app.inject({ method: 'PATCH', url: `/api/pages/${p2}`, headers: { cookie: u.cookie }, payload: { aliases: [] } })
    assert.equal(await resolve(u, ws, 'Alpha'), p1)
    const del = await app.inject({ method: 'DELETE', url: `/api/pages/${p1}`, headers: { cookie: u.cookie } })
    assert.ok(del.statusCode < 300, del.body)
    assert.equal(await resolve(u, ws, 'Alpha'), null)
  })

  it("a private page's old name resolves only for its author", async () => {
    const owner = await h.makeUser('own')
    const other = await h.makeUser('oth')
    const ws = (await h.makeWorkspace(owner, [other])).id
    const p = await newPage(owner, ws, 'Secret plan', 'private')
    await rename(owner, p, 'Plan v2')
    assert.equal(await resolve(owner, ws, 'Secret plan'), p)
    assert.equal(await resolve(other, ws, 'Secret plan'), null, 'no leak of a private page through its former name')
  })

  it('end to end: a Markdown file written with the old names imports with links to the renamed page', async () => {
    const u = await h.makeUser('e2e')
    const ws = (await h.makeWorkspace(u)).id
    const target = await newPage(u, ws, 'Meeting notes')
    await rename(u, target, 'Meeting notes 2026')
    await rename(u, target, 'Weekly sync')
    const md = Buffer.from('See [[Meeting notes]] and [[Meeting notes 2026]].\n')
    const boundary = '----former1121'
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="Index.md"\r\nContent-Type: text/markdown\r\n\r\n`),
      md,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ])
    const r = await app.inject({
      method: 'POST',
      url: `/api/workspaces/${ws}/import`,
      headers: { cookie: u.cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    })
    assert.equal(r.statusCode, 200, r.body)
    const src = (r.json() as { pages: { id: string }[] }).pages[0].id
    const links = await db.select().from(schema.pageLinks).where(eq(schema.pageLinks.sourcePageId, src))
    assert.deepEqual(links.map((l) => l.targetPageId), [target])
    const [d] = await db.select().from(schema.pageDocs).where(eq(schema.pageDocs.pageId, src))
    const hrefs = [...JSON.stringify(stateToBlocks(d.state)).matchAll(/"href":"([^"]+)"/g)].map((m) => m[1])
    assert.equal(hrefs.length, 2)
    for (const href of hrefs) assert.ok(href.endsWith(`/p/${target}`), href)
  })
})
