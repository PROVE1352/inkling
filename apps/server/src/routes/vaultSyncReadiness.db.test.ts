// Vault sync readiness (Z-3, 0.17): the conditions for taking `vault-sync` out of the experimental
// flag, end to end with the real `inklingctl sync` (spawned through tsx) against a listening test
// server and a real database. Each condition R1–R12 of the checklist has its own test; R13 is in
// vaultSyncSecurity.db.test.ts, R14 in vaultSyncScale.db.test.ts. Every scenario uses its own
// workspace and vault folder.
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.DATA_DIR ||= `${process.env.TMPDIR || '/tmp'}/inkling-vready-${process.pid}`

import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'

const HAS_DB = !!process.env.DATABASE_URL
mkdirSync(path.join(process.env.DATA_DIR!, 'uploads'), { recursive: true })

describe('[db] vault sync readiness (R1–R12)', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const h = await import('../mcpTools/testHarness')
  const kit = await import('./vaultSyncTestKit')
  const { db, closeDb } = await import('../db/index')
  const schema = await import('../db/schema')
  const { and, eq, isNull, sql } = await import('drizzle-orm')
  const collab = await import('../collab')
  const { currentBlocks } = await import('../context/sectionSource')
  const { reindexPageChunks } = await import('../context/chunkIndex')

  const s = await kit.buildSyncApp()
  type U = Awaited<ReturnType<typeof h.makeUser>>
  type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  let alice: U
  let home: string
  const scratch: string[] = []

  before(async () => {
    alice = await h.makeUser('Alice')
    home = await mkdtemp(path.join(tmpdir(), 'inkling-vready-home-'))
    scratch.push(home)
  })
  after(async () => {
    await collab.destroyCollab()
    await s.close()
    await closeDb()
    for (const d of scratch) await rm(d, { recursive: true, force: true })
  })

  const para = (text: string, id?: string, props?: Record<string, unknown>) => ({ ...(id ? { id } : {}), type: 'paragraph', ...(props ? { props } : {}), content: [{ type: 'text', text, styles: {} }] })
  const heading = (text: string, id?: string) => ({ ...(id ? { id } : {}), type: 'heading', props: { level: 2 }, content: [{ type: 'text', text, styles: {} }] })
  const req = (method: Method, url: string, payload?: unknown) =>
    s.app.inject({ method, url: `/api${url}`, headers: { cookie: alice.cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) })

  interface Ctx {
    ws: string
    vault: string
  }
  async function setup(): Promise<Ctx> {
    const ws = (await h.makeWorkspace(alice)).id
    const vault = await mkdtemp(path.join(tmpdir(), 'inkling-vready-vault-'))
    scratch.push(vault)
    return { ws, vault }
  }
  async function sync(c: Ctx, args: string[] = []) {
    return kit.runSync(s, c.vault, { workspaceId: c.ws, auth: alice.cookie, home, args })
  }
  async function syncOk(c: Ctx, args: string[] = []) {
    const r = await sync(c, args)
    assert.equal(r.code, 0, r.out)
    return r.out
  }
  const fp = (c: Ctx, rel: string) => path.join(c.vault, ...rel.split('/'))
  const read = (c: Ctx, rel: string) => readFile(fp(c, rel), 'utf8')
  const exists = async (c: Ctx, rel: string) => !!(await stat(fp(c, rel)).catch(() => null))
  async function put(c: Ctx, rel: string, text: string) {
    await mkdir(path.dirname(fp(c, rel)), { recursive: true })
    await writeFile(fp(c, rel), text)
  }
  async function edit(c: Ctx, rel: string, from: string, to: string) {
    const t = await read(c, rel)
    assert.ok(t.includes(from), `${rel} contains ${from}: ${t}`)
    await writeFile(fp(c, rel), t.replace(from, to))
  }
  /** vault files (posix, sorted), without .inkling/ */
  async function files(c: Ctx, dir = ''): Promise<string[]> {
    const out: string[] = []
    for (const e of await readdir(path.join(c.vault, dir), { withFileTypes: true })) {
      if (e.name === '.inkling') continue
      const rel = dir ? `${dir}/${e.name}` : e.name
      if (e.isDirectory()) {
        out.push(`${rel}/`)
        out.push(...(await files(c, rel)))
      } else out.push(rel)
    }
    return out.sort()
  }
  async function serverMd(pageId: string): Promise<string> {
    const p = (await db.select({ ws: schema.pages.workspaceId }).from(schema.pages).where(eq(schema.pages.id, pageId)))[0]
    const r = await req('POST', `/workspaces/${p.ws}/sync/read`, { ids: [pageId] })
    assert.equal(r.statusCode, 200, r.body)
    return r.json().pages[0]?.markdown ?? ''
  }
  const live = (ws: string) =>
    db
      .select({ id: schema.pages.id, title: schema.pages.title, parentId: schema.pages.parentId, kind: schema.pages.kind })
      .from(schema.pages)
      .where(and(eq(schema.pages.workspaceId, ws), isNull(schema.pages.deletedAt)))
  const byTitle = async (ws: string, title: string) => (await live(ws)).filter((p) => p.title === title)
  const one = async (ws: string, title: string) => {
    const l = await byTitle(ws, title)
    assert.equal(l.length, 1, `exactly one live page "${title}" (got ${l.length})`)
    return l[0]
  }

  // -------------------------------------------------------------------------
  it('R1 R2: creates and edits travel both ways; a third run has nothing to do', async () => {
    const c = await setup()
    const a = await h.makeDocPage(c.ws, alice.id, 'Alpha', [heading('Intro'), para('alpha from the server')] as never)
    await syncOk(c)
    assert.match(await read(c, 'Alpha.md'), /alpha from the server/)
    assert.match(await read(c, 'Alpha.md'), new RegExp(`inkling-id: ${a.id}`))

    await put(c, 'Beta.md', '# Beta\n\nbeta from the vault\n')
    await put(c, 'Gamma.md', 'gamma links to [[Alpha]]\n')
    await put(c, 'Sub/Delta.md', 'delta in a folder\n')
    await syncOk(c)
    const beta = await one(c.ws, 'Beta')
    assert.match(await serverMd(beta.id), /beta from the vault/)
    const gamma = await one(c.ws, 'Gamma')
    const [link] = await db.select().from(schema.pageLinks).where(eq(schema.pageLinks.sourcePageId, gamma.id))
    assert.equal(link?.targetPageId, a.id, 'the wiki link resolved to the page')
    const sub = await one(c.ws, 'Sub')
    assert.equal(sub.kind, 'folder')
    assert.equal((await one(c.ws, 'Delta')).parentId, sub.id)

    // edits both ways
    assert.equal((await req('POST', `/pages/${a.id}/section`, { ref: 'Intro', mode: 'append', markdown: 'appended on the server' })).statusCode, 200)
    await edit(c, 'Beta.md', 'beta from the vault', 'beta edited in the vault')
    await syncOk(c)
    assert.match(await read(c, 'Alpha.md'), /appended on the server/)
    assert.match(await serverMd(beta.id), /beta edited in the vault/)
    assert.match(await syncOk(c), /sync done: nothing to do/)
  })

  // -------------------------------------------------------------------------
  it('R3: deletes travel both ways and nothing comes back on later runs', async () => {
    const c = await setup()
    const d = await h.makeDocPage(c.ws, alice.id, 'Dserver', [para('trashed on the server')] as never)
    const e = await h.makeDocPage(c.ws, alice.id, 'Elocal', [para('deleted in the vault')] as never)
    await syncOk(c)
    assert.equal((await req('DELETE', `/pages/${d.id}`)).statusCode, 204)
    await rm(fp(c, 'Elocal.md'))
    await syncOk(c)
    assert.equal(await exists(c, 'Dserver.md'), false)
    assert.ok((await readdir(path.join(c.vault, '.inkling', 'trash'), { recursive: true })).some((f) => String(f).endsWith('Dserver.md')), 'kept in .inkling/trash')
    assert.equal((await byTitle(c.ws, 'Elocal')).length, 0)
    for (let i = 0; i < 2; i++) await syncOk(c)
    assert.equal(await exists(c, 'Dserver.md'), false, 'not resurrected locally')
    assert.equal((await byTitle(c.ws, 'Elocal')).length, 0, 'not resurrected on the server')
    assert.equal((await byTitle(c.ws, 'Dserver')).length, 0)
    void e
  })

  it('R3: a page deleted in the vault together with its sub-pages folder stays deleted', async () => {
    const c = await setup()
    const p = await h.makeDocPage(c.ws, alice.id, 'Parent', [para('parent body')] as never)
    await h.makeDocPage(c.ws, alice.id, 'Child', [para('child body')] as never, { parentId: p.id })
    await syncOk(c)
    assert.ok(await exists(c, 'Parent.md'))
    assert.ok(await exists(c, 'Parent/Child.md'))
    await rm(fp(c, 'Parent.md'))
    await rm(fp(c, 'Parent'), { recursive: true })
    await syncOk(c)
    await syncOk(c)
    assert.equal((await byTitle(c.ws, 'Parent')).length + (await byTitle(c.ws, 'Child')).length, 0, 'both trashed on the server')
    assert.deepEqual(await files(c), [], 'nothing came back in the vault')
  })

  it('R3: a folder deleted in the vault stays deleted (server folder page and local directory)', async () => {
    const c = await setup()
    const f = (await req('POST', `/workspaces/${c.ws}/sync/pages`, { title: 'Box', kind: 'folder' })).json().page.id as string
    await h.makeDocPage(c.ws, alice.id, 'Inside', [para('inside the box')] as never, { parentId: f })
    await syncOk(c)
    assert.ok(await exists(c, 'Box/Inside.md'))
    await rm(fp(c, 'Box'), { recursive: true })
    await syncOk(c)
    await syncOk(c)
    assert.equal((await byTitle(c.ws, 'Inside')).length, 0)
    assert.deepEqual(await files(c), [], 'the deleted directory is not re-created')
    assert.equal((await byTitle(c.ws, 'Box')).length, 0, 'the emptied folder page went to the trash too')
  })

  it('R3: an empty folder whose directory is missing (a vault copied by git or zip) is not trashed; neither on the first run of a pre-0.17 state', async () => {
    const c = await setup()
    const empty = (await req('POST', `/workspaces/${c.ws}/sync/pages`, { title: 'Empty', kind: 'folder' })).json().page.id as string
    const full = (await req('POST', `/workspaces/${c.ws}/sync/pages`, { title: 'Full', kind: 'folder' })).json().page.id as string
    await h.makeDocPage(c.ws, alice.id, 'In full', [para('x')] as never, { parentId: full })
    await syncOk(c)
    await rm(fp(c, 'Empty'), { recursive: true })
    await syncOk(c)
    assert.equal((await db.select().from(schema.pages).where(eq(schema.pages.id, empty)))[0].deletedAt, null, 'the empty folder stays')
    assert.ok(await exists(c, 'Empty'), 'and its directory is made again')
    // a state written by an older CLI (no `dirs`): its first run trashes no folder
    const sp = path.join(c.vault, '.inkling', 'sync-state.json')
    const st = JSON.parse(await readFile(sp, 'utf8'))
    delete st.dirs
    await writeFile(sp, JSON.stringify(st))
    await rm(fp(c, 'Full'), { recursive: true })
    await syncOk(c)
    assert.equal((await db.select().from(schema.pages).where(eq(schema.pages.id, full)))[0].deletedAt, null, 'not on the first run after the upgrade')
    assert.equal((await byTitle(c.ws, 'In full')).length, 0, 'the deleted note itself is trashed')
  })

  it('--dry-run sends no write and changes nothing in the vault', async () => {
    const c = await setup()
    await h.makeDocPage(c.ws, alice.id, 'Dry A', [para('a')] as never)
    const b = await h.makeDocPage(c.ws, alice.id, 'Dry B', [para('b')] as never)
    const box = (await req('POST', `/workspaces/${c.ws}/sync/pages`, { title: 'DryBox', kind: 'folder' })).json().page.id as string
    await h.makeDocPage(c.ws, alice.id, 'Dry C', [para('c')] as never, { parentId: box })
    await syncOk(c)
    await edit(c, 'Dry A.md', 'a', 'a edited')
    await rm(fp(c, 'Dry B.md'))
    await rename(fp(c, 'DryBox'), fp(c, 'DryBox2'))
    await put(c, 'New dir/Dry new.md', 'new [[Dry A]]\n')
    assert.equal((await req('PATCH', `/pages/${b.id}`, { title: 'Dry B renamed' })).statusCode, 200)
    const snapshot = async () => {
      const out: Record<string, string> = {}
      for (const f of (await readdir(c.vault, { recursive: true })).map(String).sort()) {
        const st = await stat(path.join(c.vault, f))
        out[f] = st.isDirectory() ? 'dir' : await readFile(path.join(c.vault, f), 'utf8')
      }
      return out
    }
    const before = await snapshot()
    const mark = s.seen.length
    const out = await syncOk(c, ['--dry-run'])
    assert.match(out, /\[dry run\]/)
    const writes = s.seen.slice(mark).filter((r) => r.method !== 'GET' && !(r.method === 'POST' && r.url.endsWith('/sync/read')))
    assert.deepEqual(writes, [], 'only reads')
    assert.deepEqual(await snapshot(), before, 'vault and .inkling/ unchanged')
  })

  // -------------------------------------------------------------------------
  it('R4 R5: renames and moves travel both ways, for notes and folders', async () => {
    const c = await setup()
    const folder = (await req('POST', `/workspaces/${c.ws}/sync/pages`, { title: 'Shelf', kind: 'folder' })).json().page.id as string
    const r1 = await h.makeDocPage(c.ws, alice.id, 'Rserver', [para('renamed on the server')] as never)
    const r2 = await h.makeDocPage(c.ws, alice.id, 'Rlocal', [para('renamed in the vault')] as never)
    const m1 = await h.makeDocPage(c.ws, alice.id, 'Mserver', [para('moved on the server')] as never)
    const m2 = await h.makeDocPage(c.ws, alice.id, 'Mlocal', [para('moved in the vault')] as never)
    await syncOk(c)

    assert.equal((await req('PATCH', `/pages/${r1.id}`, { title: 'Rserver2' })).statusCode, 200)
    assert.equal((await req('PATCH', `/pages/${m1.id}`, { parentId: folder })).statusCode, 200)
    await rename(fp(c, 'Rlocal.md'), fp(c, 'Rlocal2.md'))
    await rename(fp(c, 'Mlocal.md'), fp(c, 'Shelf/Mlocal.md'))
    await syncOk(c)
    assert.ok(await exists(c, 'Rserver2.md'))
    assert.ok(await exists(c, 'Shelf/Mserver.md'))
    const [p2] = await db.select().from(schema.pages).where(eq(schema.pages.id, r2.id))
    assert.equal(p2.title, 'Rlocal2')
    const [pm2] = await db.select().from(schema.pages).where(eq(schema.pages.id, m2.id))
    assert.equal(pm2.parentId, folder)
    assert.deepEqual(await files(c), ['Rlocal2.md', 'Rserver2.md', 'Shelf/', 'Shelf/Mlocal.md', 'Shelf/Mserver.md'])
    assert.match(await syncOk(c), /sync done: nothing to do/)
  })

  it('R4 R5: a folder renamed or moved in the vault renames/moves its folder page (same id, nothing left behind)', async () => {
    const c = await setup()
    const box = (await req('POST', `/workspaces/${c.ws}/sync/pages`, { title: 'Box', kind: 'folder' })).json().page.id as string
    const n = await h.makeDocPage(c.ws, alice.id, 'Note', [para('in the box')] as never, { parentId: box })
    await syncOk(c)
    await rename(fp(c, 'Box'), fp(c, 'Crate'))
    await syncOk(c)
    await syncOk(c)
    const [bx] = await db.select().from(schema.pages).where(eq(schema.pages.id, box))
    assert.equal(bx.title, 'Crate', 'the folder page was renamed')
    assert.equal(bx.deletedAt, null)
    assert.equal((await db.select().from(schema.pages).where(eq(schema.pages.id, n.id)))[0].parentId, box)
    assert.equal((await live(c.ws)).filter((p) => p.kind === 'folder').length, 1, 'no second folder page')
    assert.deepEqual(await files(c), ['Crate/', 'Crate/Note.md'])
  })

  it('R4 R5: a note with sub-pages renamed in the vault (Page.md + Page/) keeps its sub-pages', async () => {
    const c = await setup()
    const p = await h.makeDocPage(c.ws, alice.id, 'Topic', [para('topic body')] as never)
    const ch = await h.makeDocPage(c.ws, alice.id, 'Detail', [para('detail body')] as never, { parentId: p.id })
    await syncOk(c)
    await rename(fp(c, 'Topic.md'), fp(c, 'Subject.md'))
    await rename(fp(c, 'Topic'), fp(c, 'Subject'))
    await syncOk(c)
    await syncOk(c)
    assert.equal((await db.select().from(schema.pages).where(eq(schema.pages.id, p.id)))[0].title, 'Subject')
    assert.equal((await db.select().from(schema.pages).where(eq(schema.pages.id, ch.id)))[0].parentId, p.id, 'the sub-page stays under its page')
    assert.equal((await live(c.ws)).filter((x) => x.kind === 'folder').length, 0, 'no folder page was made for the directory')
    assert.deepEqual(await files(c), ['Subject.md', 'Subject/', 'Subject/Detail.md'])
  })

  // -------------------------------------------------------------------------
  it('R6: concurrent edits merge (different lines) or give a conflict copy (same line); nothing is lost', async () => {
    const c = await setup()
    const p = await h.makeDocPage(c.ws, alice.id, 'Both', [para('line one'), para('line two'), para('line three')] as never)
    await syncOk(c)
    // different lines
    const r = await req('POST', `/workspaces/${c.ws}/sync/read`, { ids: [p.id] })
    const cur = r.json().pages[0]
    assert.equal((await req('PUT', `/pages/${p.id}/sync/md`, { markdown: cur.markdown.replace('line one', 'line one (server)'), expectedRevision: cur.revision })).statusCode, 200)
    await edit(c, 'Both.md', 'line three', 'line three (vault)')
    await syncOk(c)
    const merged = await serverMd(p.id)
    assert.match(merged, /line one \(server\)/)
    assert.match(merged, /line three \(vault\)/)
    assert.match(await read(c, 'Both.md'), /line one \(server\)/)

    // same line
    const cur2 = (await req('POST', `/workspaces/${c.ws}/sync/read`, { ids: [p.id] })).json().pages[0]
    assert.equal((await req('PUT', `/pages/${p.id}/sync/md`, { markdown: cur2.markdown.replace('line two', 'line two SERVER'), expectedRevision: cur2.revision })).statusCode, 200)
    await edit(c, 'Both.md', 'line two', 'line two VAULT')
    const out = await syncOk(c)
    assert.match(out, /conflict/)
    const copy = (await files(c)).find((f) => / \(conflict \d{4}-\d{2}-\d{2}\)\.md$/.test(f))
    assert.ok(copy, 'a conflict copy exists')
    const copyText = await read(c, copy!)
    assert.match(copyText, /line two SERVER/)
    assert.match(copyText, /line two VAULT/)
    assert.match(await read(c, 'Both.md'), /line two VAULT/, 'the note is left as it was')
    assert.match(await serverMd(p.id), /line two SERVER/, 'the server keeps its version')
    // resolve: keep both, delete the copy
    await edit(c, 'Both.md', 'line two VAULT', 'line two VAULT and SERVER')
    await rm(fp(c, copy!))
    await syncOk(c)
    assert.match(await serverMd(p.id), /line two VAULT and SERVER/)

    // edit vs delete, both directions: the edit wins
    const q = await h.makeDocPage(c.ws, alice.id, 'EditDel', [para('edit vs delete')] as never)
    const q2 = await h.makeDocPage(c.ws, alice.id, 'DelEdit', [para('delete vs edit')] as never)
    await syncOk(c)
    assert.equal((await req('DELETE', `/pages/${q.id}`)).statusCode, 204)
    await edit(c, 'EditDel.md', 'edit vs delete', 'edit vs delete, edited in the vault')
    const cur3 = (await req('POST', `/workspaces/${c.ws}/sync/read`, { ids: [q2.id] })).json().pages[0]
    assert.equal((await req('PUT', `/pages/${q2.id}/sync/md`, { markdown: cur3.markdown.replace('delete vs edit', 'delete vs edit, edited on the server'), expectedRevision: cur3.revision })).statusCode, 200)
    await rm(fp(c, 'DelEdit.md'))
    await syncOk(c)
    const recreated = await one(c.ws, 'EditDel')
    assert.match(await serverMd(recreated.id), /edited in the vault/, 'the vault edit re-created the page')
    assert.match(await read(c, 'DelEdit.md'), /edited on the server/, 'the server edit restored the note')
  })

  // -------------------------------------------------------------------------
  it('R7: block ids survive a round trip (comment anchors, section anchors, ink)', async () => {
    const c = await setup()
    const target = await h.makeDocPage(c.ws, alice.id, 'Target', [para('target')] as never)
    const blocks = [
      heading('Keep', 'h-keep'),
      para('kept paragraph', 'p-keep'),
      para('coloured paragraph', 'p-colour', { textColor: 'red' }),
      { id: 'l-1', type: 'bulletListItem', content: [{ type: 'text', text: 'bullet one', styles: {} }], children: [{ id: 'l-1a', type: 'bulletListItem', content: [{ type: 'text', text: 'nested', styles: {} }] }] },
      { id: 'c-1', type: 'checkListItem', props: { checked: true }, content: [{ type: 'text', text: 'done task', styles: {} }] },
      { id: 'link-1', type: 'paragraph', content: [{ type: 'text', text: 'see ', styles: {} }, { type: 'link', href: `/w/${c.ws}/p/${target.id}`, content: [{ type: 'text', text: 'Target', styles: {} }] }] },
      { id: 'code-1', type: 'codeBlock', props: { language: 'ts' }, content: [{ type: 'text', text: 'const x = 1', styles: {} }] },
      { id: 'tbl-1', type: 'table', content: { type: 'tableContent', rows: [{ cells: [[{ type: 'text', text: 'a', styles: {} }], [{ type: 'text', text: 'b', styles: {} }]] }] } },
      heading('Edit', 'h-edit'),
      para('this line changes', 'p-edit'),
      heading('Tail', 'h-tail'),
      para('tail paragraph', 'p-tail'),
    ]
    const p = await h.makeDocPage(c.ws, alice.id, 'Anchors', blocks as never)
    await reindexPageChunks(p.id, (await currentBlocks(p.id)) as never)
    const ids = async () => {
      const out = new Set<string>()
      const walk = (bs: { id?: string; children?: unknown[] }[]) => bs.forEach((b) => (b.id && out.add(b.id), walk((b.children ?? []) as never)))
      walk((await currentBlocks(p.id)) as never)
      return out
    }
    const before = await ids()
    for (const id of ['h-keep', 'p-keep', 'p-colour', 'l-1a', 'c-1', 'link-1', 'tbl-1', 'h-tail', 'p-tail']) assert.ok(before.has(id), `${id} stored`)
    // a comment thread on a kept block and one on the tail heading; ink on the page
    for (const blockId of ['p-keep', 'h-tail', 'tbl-1']) {
      const tid = crypto.randomUUID()
      await db.insert(schema.comments).values({ id: tid, threadId: tid, pageId: p.id, blockId, authorId: alice.id, body: `on ${blockId}` })
    }
    const strokes = [{ id: 's1', color: '#000', size: 2, points: [1, 2, 0.5, 3, 4, 0.5] }]
    await db.insert(schema.pageInk).values({ pageId: p.id, strokes, updatedBy: alice.id })
    const chunksBefore = await db.select({ anchor: schema.pageChunks.anchor, blockId: schema.pageChunks.blockId }).from(schema.pageChunks).where(eq(schema.pageChunks.pageId, p.id))

    await syncOk(c)
    // (a) untouched round trip: re-saving the same text through the vault writes nothing
    assert.match(await syncOk(c), /sync done: nothing to do/)
    // (b) only another section changes in the vault
    await edit(c, 'Anchors.md', 'this line changes', 'this line changed in the vault')
    await syncOk(c)
    assert.match(await serverMd(p.id), /changed in the vault/)
    // (c) the 412-then-merge path: the server changes the Tail section while the vault changes Edit again
    assert.equal((await req('POST', `/pages/${p.id}/section`, { ref: 'Tail', mode: 'append', markdown: 'server addition' })).statusCode, 200)
    await edit(c, 'Anchors.md', 'changed in the vault', 'changed in the vault twice')
    await syncOk(c)
    const md = await serverMd(p.id)
    assert.match(md, /twice/)
    assert.match(md, /server addition/)

    const afterIds = await ids()
    const lost = [...before].filter((id) => id !== 'p-edit' && !afterIds.has(id))
    assert.deepEqual(lost, [], 'every block the vault left alone keeps its id')
    const threads = await db.select({ blockId: schema.comments.blockId }).from(schema.comments).where(eq(schema.comments.pageId, p.id))
    for (const t of threads) assert.ok(afterIds.has(t.blockId), `comment anchor ${t.blockId} still in the document`)
    // section index, once the store hook re-indexed the page
    let chunksAfter: typeof chunksBefore = []
    for (let i = 0; i < 100; i++) {
      const text = (await db.execute(sql`SELECT string_agg(text, ' ') AS t FROM page_chunks WHERE page_id = ${p.id}`)) as unknown as { t: string }[]
      if (text[0]?.t?.includes('twice')) {
        chunksAfter = await db.select({ anchor: schema.pageChunks.anchor, blockId: schema.pageChunks.blockId }).from(schema.pageChunks).where(eq(schema.pageChunks.pageId, p.id))
        break
      }
      await new Promise((r) => setTimeout(r, 100))
    }
    assert.ok(chunksAfter.length, 'the section index caught up')
    const key = (x: { anchor: string; blockId: string | null }) => `${x.anchor}=${x.blockId}`
    assert.deepEqual([...new Set(chunksAfter.map(key))].sort(), [...new Set(chunksBefore.map(key))].sort(), 'section anchors and heading block ids unchanged')
    const [ink] = await db.select().from(schema.pageInk).where(eq(schema.pageInk.pageId, p.id))
    assert.deepEqual(ink.strokes, strokes, 'the ink layer of the page is untouched')
  })

  it('R7 (and R2): blocks Markdown cannot carry (embeds, plugin, chart, mention, callout) survive a vault edit of another block', async () => {
    const c = await setup()
    const other = await h.makeDocPage(c.ws, alice.id, 'Other', [para('other')] as never)
    const blocks = [
      heading('Edit', 'h-edit'),
      para('this line changes', 'p-edit'),
      heading('Rich', 'h-rich'),
      { id: 'b-callout', type: 'callout', props: { type: 'tip' }, content: [{ type: 'text', text: 'a tip', styles: {} }] },
      { id: 'b-pembed', type: 'pageEmbed', props: { pageId: other.id } },
      { id: 'b-lembed', type: 'linkEmbed', props: { url: 'https://example.com/video', display: 'card' } },
      { id: 'b-plugin', type: 'pluginBlock', props: { pluginId: 'demo', blockType: 'counter', data: '{"n":3}' } },
      { id: 'b-chart', type: 'chart', props: { config: '' } },
      { id: 'b-mention', type: 'paragraph', content: [{ type: 'text', text: 'ask ', styles: {} }, { type: 'mention', props: { kind: 'user', id: alice.id, label: 'Alice' } }] },
    ]
    const p = await h.makeDocPage(c.ws, alice.id, 'Rich', blocks as never)
    const types = async () => {
      const out = new Map<string, string>()
      const walk = (bs: { id?: string; type?: string; children?: unknown[] }[]) => bs.forEach((b) => (b.id && out.set(b.id, b.type ?? ''), walk((b.children ?? []) as never)))
      walk((await currentBlocks(p.id)) as never)
      return out
    }
    const before = await types()
    const mentionBefore = JSON.stringify((await currentBlocks(p.id)).find((b) => b.id === 'b-mention'))
    assert.match(mentionBefore, /"mention"/)
    await syncOk(c)
    await edit(c, 'Rich.md', 'this line changes', 'this line changed in the vault')
    await syncOk(c)
    assert.match(await serverMd(p.id), /changed in the vault/)
    const after = await types()
    const lost = [...before].filter(([id, t]) => id !== 'p-edit' && after.get(id) !== t).map(([id, t]) => `${id}:${t}`)
    assert.deepEqual(lost, [], 'every block the note left alone is still there with its type')
    assert.equal(JSON.stringify((await currentBlocks(p.id)).find((b) => b.id === 'b-mention')), mentionBefore, 'the mention chip is still a chip')
  })

  // -------------------------------------------------------------------------
  it('R8: frontmatter and tags round-trip; a body-only vault edit leaves every property as it was', async () => {
    const c = await setup()
    const properties = [
      { id: 'tags', name: 'tags', type: 'tags', value: ['alpha', 'beta-2'] },
      { id: 'pt', name: 'Owner', type: 'text', value: 'Kim' },
      { id: 'pz', name: 'Code', type: 'text', value: '007' },
      { id: 'pv', name: 'Version', type: 'text', value: '1.10' },
      { id: 'pn', name: 'Score', type: 'number', value: 4.5 },
      { id: 'date', name: 'date', type: 'date', value: '2026-11-10' },
      { id: 'done', name: 'done', type: 'checkbox', value: true },
      { id: 'ps', name: 'Status', type: 'select', value: 'Doing' },
      { id: 'pu', name: 'Link', type: 'url', value: 'https://example.com/x' },
      { id: 'pe', name: 'Empty', type: 'text' },
    ]
    const p = await h.makeDocPage(c.ws, alice.id, 'Props', [para('body line')] as never, { properties, aliases: ['Other name'] } as never)
    await syncOk(c)
    const text = await read(c, 'Props.md')
    assert.match(text, /tags:\n {2}- alpha\n {2}- beta-2/)
    assert.match(text, /aliases:\n {2}- Other name/)
    await edit(c, 'Props.md', 'body line', 'body line edited')
    await syncOk(c)
    const [row] = await db.select({ properties: schema.pages.properties, aliases: schema.pages.aliases }).from(schema.pages).where(eq(schema.pages.id, p.id))
    assert.deepEqual(row.aliases, ['Other name'])
    assert.deepEqual(row.properties, properties, 'every property keeps id, type and value')
    // edits of frontmatter in the vault reach the server
    await edit(c, 'Props.md', '  - beta-2', '  - beta-2\n  - gamma')
    await syncOk(c)
    const [row2] = await db.select({ properties: schema.pages.properties }).from(schema.pages).where(eq(schema.pages.id, p.id))
    assert.deepEqual((row2.properties as { id: string; value: unknown }[]).find((x) => x.id === 'tags')?.value, ['alpha', 'beta-2', 'gamma'])
    // and server changes reach the file
    await db.update(schema.pages).set({ properties: [...(row2.properties as object[]).filter((x) => (x as { id: string }).id !== 'pt'), { id: 'pt', name: 'Owner', type: 'text', value: 'Lee' }], updatedAt: new Date() }).where(eq(schema.pages.id, p.id))
    await syncOk(c)
    assert.match(await read(c, 'Props.md'), /Owner: Lee/)

    // frontmatter the server cannot store is not silently removed from the note
    await put(c, 'Rich.md', '---\ntags: [x]\nnested:\n  a: 1\n  b: 2\nsummary: |\n  line one\n  line two\n---\nrich body\n')
    const out = await syncOk(c)
    const rich = await read(c, 'Rich.md')
    assert.match(out, /nested|summary/, 'the run reports the keys it could not store')
    assert.match(rich, /nested:/, 'the note keeps what the server could not store')
    assert.match(rich, /summary:/)
  })

  it('R8 (and R2): a collection row edited in the vault keeps its field values', async () => {
    const c = await setup()
    const [coll] = await db.insert(schema.pages).values({ workspaceId: c.ws, title: 'Tasks', kind: 'collection', createdBy: alice.id }).returning()
    await db.insert(schema.collections).values({ pageId: coll.id, fields: [{ id: 'f1', name: 'Status', type: 'text' }, { id: 'f2', name: 'Points', type: 'number' }] } as never)
    const props = { f1: 'Doing', f2: 3 }
    const row = await h.makeDocPage(c.ws, alice.id, 'Row one', [para('row body')] as never, { parentId: coll.id, props } as never)
    await syncOk(c)
    assert.ok(await exists(c, 'Tasks/Row one.md'))
    await edit(c, 'Tasks/Row one.md', 'row body', 'row body edited in the vault')
    await syncOk(c)
    assert.match(await serverMd(row.id), /edited in the vault/)
    const [r] = await db.select({ props: schema.pages.props, parentId: schema.pages.parentId }).from(schema.pages).where(eq(schema.pages.id, row.id))
    assert.deepEqual(r.props, props, 'field values unchanged')
    assert.equal(r.parentId, coll.id)
  })

  // -------------------------------------------------------------------------
  it('R10: a vault from an older CLI/server (no folders/assets keys, pre-0.15.1 revisions) syncs without loss', async () => {
    const c = await setup()
    const a = await h.makeDocPage(c.ws, alice.id, 'Old A', [para('old a')] as never)
    await h.makeDocPage(c.ws, alice.id, 'Old B', [para('old b')] as never)
    await syncOk(c)
    const sp = path.join(c.vault, '.inkling', 'sync-state.json')
    const st = JSON.parse(await readFile(sp, 'utf8'))
    delete st.folders
    delete st.assets
    for (const f of Object.values(st.files) as { revision: string }[]) {
      const [d, m] = f.revision.split('.')
      f.revision = `${d.split('-')[0]}.${m}`
    }
    st.cursor = null
    await writeFile(sp, JSON.stringify(st))
    await edit(c, 'Old A.md', 'old a', 'old a edited')
    await syncOk(c)
    assert.match(await serverMd(a.id), /old a edited/)
    assert.match(await read(c, 'Old B.md'), /old b/)
    assert.equal((await live(c.ws)).length, 2, 'no duplicates')
    assert.match(await syncOk(c), /sync done: nothing to do/)
  })

  it('R10: a vault from 0.16 (notes without block tokens, revisions without the format marker) keeps embeds on the next edit; an old-token delete goes through', async () => {
    const c = await setup()
    const { metaHash, contentHashOf } = await import('../md/syncMd')
    const other = await h.makeDocPage(c.ws, alice.id, 'Target page', [para('t')] as never)
    const p = await h.makeDocPage(c.ws, alice.id, 'Embeds', [para('first line', 'e-1'), { id: 'e-embed', type: 'pageEmbed', props: { pageId: other.id } }, para('middle line', 'e-m'), para('more text', 'e-n'), para('last line', 'e-2')] as never)
    const gone = await h.makeDocPage(c.ws, alice.id, 'Gone', [para('to delete')] as never)
    await syncOk(c)
    assert.match(await read(c, 'Embeds.md'), /<!-- inkling:pageEmbed /)
    // what 0.16 left: the plain note (no token line) and revisions whose metadata half has no marker
    const sp = path.join(c.vault, '.inkling', 'sync-state.json')
    const st = JSON.parse(await readFile(sp, 'utf8'))
    for (const [pid, f] of Object.entries(st.files) as [string, { revision: string }][]) {
      const [row] = await db.select({ properties: schema.pages.properties, aliases: schema.pages.aliases }).from(schema.pages).where(eq(schema.pages.id, pid))
      f.revision = `${f.revision.split('.')[0]}.${metaHash(row.properties, row.aliases, '')}`
    }
    await writeFile(sp, JSON.stringify(st))
    const plain = (await read(c, 'Embeds.md')).replace(/^<!-- inkling:pageEmbed .*-->\n\n?/m, '')
    await writeFile(fp(c, 'Embeds.md'), plain)
    await writeFile(path.join(c.vault, '.inkling', 'base', `${p.id}.md`), plain)
    st.files[p.id].localHash = (await import('node:crypto')).createHash('sha256').update(plain).digest('hex')
    st.files[p.id].serverHash = contentHashOf(plain) // 0.16 hashed the note without the token
    await writeFile(sp, JSON.stringify(st))
    await edit(c, 'Embeds.md', 'last line', 'last line edited in the vault')
    await rm(fp(c, 'Gone.md'))
    const out = await syncOk(c)
    // (an edit right next to the embed's position gives a conflict copy once instead: nothing is lost)
    assert.doesNotMatch(out, /conflict/)
    assert.ok((await currentBlocks(p.id)).some((b) => b.id === 'e-embed' && b.type === 'pageEmbed'), `the embed is still on the page\n${out}\n${JSON.stringify(await currentBlocks(p.id))}\n${await read(c, 'Embeds.md')}`)
    assert.match(await serverMd(p.id), /last line edited in the vault/)
    assert.match(await read(c, 'Embeds.md'), /<!-- inkling:pageEmbed /, 'the note now carries the token')
    const [g] = await db.select({ deletedAt: schema.pages.deletedAt }).from(schema.pages).where(eq(schema.pages.id, gone.id))
    assert.ok(g.deletedAt, 'the delete with a 0.16 token was accepted')
    assert.match(await syncOk(c), /sync done: nothing to do/)
  })

  // -------------------------------------------------------------------------
  it('R11: attachments keep their links, local files are never removed or overwritten, unsupported ones are skipped and reported', async () => {
    const c = await setup()
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4d40000000049454e44ae426082', 'hex')
    const p = await h.makeDocPage(c.ws, alice.id, 'Pics', [para('placeholder')] as never)
    const up = async (name: string, mime: string, data: Buffer) => {
      const form = new FormData()
      form.set('file', new Blob([new Uint8Array(data)], { type: mime }), name)
      const res = await fetch(`${s.url}/api/files?workspaceId=${c.ws}&pageId=${p.id}`, { method: 'POST', headers: { cookie: alice.cookie }, body: form })
      assert.equal(res.status, 200, await res.clone().text())
      return ((await res.json()) as { file: { id: string } }).file.id
    }
    const img = await up('pic.png', 'image/png', png)
    const pdf = await up('doc.pdf', 'application/pdf', Buffer.from('%PDF-1.4\n%%EOF\n'))
    const mp3 = await up('a.mp3', 'audio/mpeg', Buffer.from('ID3\u0003\u0000\u0000\u0000'))
    const cur = (await req('POST', `/workspaces/${c.ws}/sync/read`, { ids: [p.id] })).json().pages[0]
    const body = `${cur.markdown.replace('placeholder', 'intro line')}\n![pic](/files/${img})\n\n[doc.pdf](/files/${pdf})\n\n[a.mp3](/files/${mp3})\n`
    assert.equal((await req('PUT', `/pages/${p.id}/sync/md`, { markdown: body, expectedRevision: cur.revision })).statusCode, 200)
    const serverBefore = await serverMd(p.id)
    for (const id of [img, pdf, mp3]) assert.ok(serverBefore.includes(`/files/${id}`), `server page links ${id}`)

    await syncOk(c)
    const note = await read(c, 'Pics.md')
    assert.match(note, new RegExp(`assets/${img}\\.png`))
    assert.deepEqual(await readFile(fp(c, `assets/${img}.png`)), png)
    await edit(c, 'Pics.md', 'intro line', 'intro line edited')
    await syncOk(c)
    const serverAfter = await serverMd(p.id)
    for (const id of [img, pdf, mp3]) assert.ok(serverAfter.includes(`/files/${id}`), `server page still links ${id} after the round trip`)

    // local attachments: a supported image (link and embed), an unsupported type, one that is too large
    await put(c, 'img/local.png', '')
    await writeFile(fp(c, 'img/local.png'), png)
    await writeFile(fp(c, 'img/drawing.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
    const big = Buffer.alloc(26 * 1024 * 1024, 1)
    await writeFile(fp(c, 'img/huge.mp4'), big)
    await put(c, 'Local pics.md', 'local pics\n\n![one](img/local.png)\n\n![[local.png]]\n\n![svg](img/drawing.svg)\n\n![huge](img/huge.mp4)\n\nlast line\n')
    const out = await syncOk(c)
    assert.match(out, /drawing\.svg/, 'the unsupported attachment is reported')
    assert.match(out, /huge\.mp4/, 'the oversized attachment is reported')
    const lp = await one(c.ws, 'Local pics')
    const md = await serverMd(lp.id)
    assert.match(md, /\/files\/[0-9a-f-]{36}/, 'the png was uploaded')
    assert.match(md, /last line/)
    assert.deepEqual(await readFile(fp(c, 'img/local.png')), png, 'the local image is untouched')
    assert.equal((await stat(fp(c, 'img/huge.mp4'))).size, big.length)
    assert.equal(await readFile(fp(c, 'img/drawing.svg'), 'utf8'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
    const after2 = await read(c, 'Local pics.md')
    assert.match(after2, /img\/drawing\.svg/, 'the skipped link stays in the note')
    assert.match(after2, /img\/huge\.mp4/)
    await syncOk(c)
    assert.equal((await stat(fp(c, 'img/huge.mp4'))).size, big.length)

    // the same picture in two new notes, inside a line of text: each page gets its own file (a purge of
    // one keeps the other's), and the inline image is kept (on its own line) instead of dropped
    await writeFile(fp(c, 'img/my pic.png'), png)
    await put(c, 'Spaced.md', 'spaced name\n\n![sp](<img/my pic.png>)\n')
    await syncOk(c)
    assert.match(await serverMd((await one(c.ws, 'Spaced')).id), /\/files\/[0-9a-f-]{36}/, 'an angle-bracket link to a file with a space is uploaded')
    assert.deepEqual(await readFile(fp(c, 'img/my pic.png')), png)
    await put(c, 'Twin one.md', 'twin one ![x](img/local.png)\n')
    await put(c, 'Twin two.md', 'twin two ![x](img/local.png)\n')
    await syncOk(c)
    const twins = [await one(c.ws, 'Twin one'), await one(c.ws, 'Twin two')]
    const fileIds = await Promise.all(twins.map(async (t) => /\/files\/([0-9a-f-]{36})/.exec(await serverMd(t.id))?.[1]))
    assert.ok(fileIds[0] && fileIds[1] && fileIds[0] !== fileIds[1], `two files: ${fileIds.join(' ')}`)
    const rows = await db.select({ id: schema.files.id, pageId: schema.files.pageId }).from(schema.files).where(sql`${schema.files.id} IN (${sql.join(fileIds.map((x) => sql`${x}::uuid`), sql`, `)})`)
    assert.deepEqual(rows.map((r) => r.pageId).sort(), twins.map((t) => t.id).sort(), 'each file belongs to its own page')
  })

  // -------------------------------------------------------------------------
  it('R12: canvases are neither damaged nor lost: skipped both ways and reported', async () => {
    const c = await setup()
    const [cv] = await db.insert(schema.pages).values({ workspaceId: c.ws, title: 'Board', kind: 'canvas', createdBy: alice.id }).returning()
    const canvasJson = '{"nodes":[{"id":"n1","type":"text","text":"hello","x":0,"y":0,"width":100,"height":50}],"edges":[]}\n'
    await put(c, 'Plan.canvas', canvasJson)
    await put(c, 'Box/Inner.canvas', canvasJson)
    const out = await syncOk(c)
    assert.match(out, /Board/, 'the server canvas is reported as not synced')
    assert.match(out, /Plan\.canvas/, 'the local canvas is reported as not synced')
    await syncOk(c)
    assert.equal(await read(c, 'Plan.canvas'), canvasJson)
    assert.equal(await read(c, 'Box/Inner.canvas'), canvasJson)
    const [still] = await db.select().from(schema.pages).where(eq(schema.pages.id, cv.id))
    assert.equal(still.deletedAt, null)
    assert.equal((await byTitle(c.ws, 'Plan')).length, 0, 'no page made from the canvas file')
  })
})
