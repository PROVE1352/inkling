// Vault sync readiness R9 (Z-3, 0.17): a sync cut off part-way and run again ends in the same state
// as an uninterrupted run, without duplicates or losses. One mixed scenario (edits both ways, new
// notes with and without links, a new folder, a local delete and rename, a server rename, a folder
// renamed and one deleted in the vault) is run
// once without faults to count its requests, then once per request index and fault mode:
//   before — the connection is cut before the server handles the request;
//   after  — the server commits, the response is lost (the CLI sees a network error);
//   kill   — the server commits, then the CLI is killed with SIGKILL (no state save at all).
// After the faulted run, two clean runs follow; the end state must equal the uninterrupted one.
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.DATA_DIR ||= `${process.env.TMPDIR || '/tmp'}/inkling-vresume-${process.pid}`

import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'

const HAS_DB = !!process.env.DATABASE_URL
mkdirSync(path.join(process.env.DATA_DIR!, 'uploads'), { recursive: true })

describe('[db] vault sync readiness: interrupted runs resume without duplicates or losses (R9)', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const h = await import('../mcpTools/testHarness')
  const kit = await import('./vaultSyncTestKit')
  const { db, closeDb } = await import('../db/index')
  const schema = await import('../db/schema')
  const { and, eq, isNull } = await import('drizzle-orm')
  const collab = await import('../collab')

  const s = await kit.buildSyncApp()
  type U = Awaited<ReturnType<typeof h.makeUser>>
  let alice: U
  let home: string
  const scratch: string[] = []
  before(async () => {
    alice = await h.makeUser('Alice')
    home = await mkdtemp(path.join(tmpdir(), 'inkling-vresume-home-'))
    scratch.push(home)
  })
  after(async () => {
    await collab.destroyCollab()
    await s.close()
    await closeDb()
    for (const d of scratch) await rm(d, { recursive: true, force: true })
  })

  const para = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text, styles: {} }] })
  const heading = (text: string) => ({ type: 'heading', props: { level: 2 }, content: [{ type: 'text', text, styles: {} }] })
  const req = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
    s.app.inject({ method, url: `/api${url}`, headers: { cookie: alice.cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) })

  interface Ctx {
    ws: string
    vault: string
    ids: Record<string, string>
  }
  const sync = (c: Ctx) => kit.runSync(s, c.vault, { workspaceId: c.ws, auth: alice.cookie, home })
  const fp = (c: Ctx, rel: string) => path.join(c.vault, ...rel.split('/'))

  /** Builds the scenario up to the run under test: a synced vault plus changes on both sides. */
  async function scenario(): Promise<Ctx> {
    const ws = (await h.makeWorkspace(alice)).id
    const vault = await mkdtemp(path.join(tmpdir(), 'inkling-vresume-vault-'))
    scratch.push(vault)
    const ids: Record<string, string> = {}
    for (const t of ['Sedit', 'Sren', 'Ledit', 'Ldel', 'Lren']) {
      ids[t] = (await h.makeDocPage(ws, alice.id, t, [heading('Body'), para(`${t} original`)] as never)).id
    }
    for (const f of ['Fold', 'Gone']) {
      const [row] = await db.insert(schema.pages).values({ workspaceId: ws, title: f, kind: 'folder', createdBy: alice.id }).returning()
      ids[f] = row.id
      ids[`${f}Note`] = (await h.makeDocPage(ws, alice.id, `${f} note`, [para(`${f} note body`)] as never, { parentId: row.id })).id
    }
    const c = { ws, vault, ids }
    const first = await sync(c)
    assert.equal(first.code, 0, first.out)
    // server side
    assert.equal((await req('POST', `/pages/${ids.Sedit}/section`, { ref: 'Body', mode: 'append', markdown: 'Sedit server addition' })).statusCode, 200)
    assert.equal((await req('PATCH', `/pages/${ids.Sren}`, { title: 'Sren2' })).statusCode, 200)
    // vault side
    const le = await readFile(fp(c, 'Ledit.md'), 'utf8')
    // (not in Inkling's canonical Markdown form: '-' bullets, so a lost response cannot be detected by comparing texts)
    await writeFile(fp(c, 'Ledit.md'), le.replace('Ledit original', 'Ledit vault edit\n\n- added bullet'))
    await rm(fp(c, 'Ldel.md'))
    await rename(fp(c, 'Lren.md'), fp(c, 'Lren2.md'))
    await rename(fp(c, 'Fold'), fp(c, 'Fold2'))
    await rm(fp(c, 'Gone'), { recursive: true })
    await writeFile(fp(c, 'Nplain.md'), 'Nplain new note\n\n- first\n- second\n')
    await writeFile(fp(c, 'Nlink.md'), 'Nlink links to [[Sedit]]\n')
    await mkdir(fp(c, 'Fnew'), { recursive: true })
    await writeFile(fp(c, 'Fnew/Nfolder.md'), 'Nfolder in a new folder\n')
    return c
  }

  async function vaultFiles(c: Ctx, dir = ''): Promise<string[]> {
    const out: string[] = []
    for (const e of await readdir(path.join(c.vault, dir), { withFileTypes: true })) {
      if (e.name === '.inkling') continue
      const rel = dir ? `${dir}/${e.name}` : e.name
      if (e.isDirectory()) out.push(...(await vaultFiles(c, rel)))
      else out.push(rel)
    }
    return out.sort()
  }

  /** What the uninterrupted run leaves, as comparable facts. */
  async function endState(c: Ctx) {
    const pages = await db
      .select({ id: schema.pages.id, title: schema.pages.title, kind: schema.pages.kind, parentId: schema.pages.parentId })
      .from(schema.pages)
      .where(and(eq(schema.pages.workspaceId, c.ws), isNull(schema.pages.deletedAt)))
    const titles = pages.map((p) => `${p.kind}:${p.title}`).sort()
    const r = await req('POST', `/workspaces/${c.ws}/sync/read`, { ids: pages.filter((p) => p.kind === 'doc').map((p) => p.id) })
    const bodies = new Map<string, string>()
    for (const p of r.json().pages as { id: string; markdown: string }[]) {
      const title = pages.find((x) => x.id === p.id)!.title
      bodies.set(title, p.markdown.replace(/^---\n[\s\S]*?\n---\n/, '').trim())
    }
    const files = await vaultFiles(c)
    const texts = new Map<string, string>()
    for (const f of files) texts.set(f, (await readFile(fp(c, f), 'utf8')).replace(/^---\n[\s\S]*?\n---\n/, '').trim())
    const folder = pages.find((p) => p.title === 'Fnew')
    const nf = pages.find((p) => p.title === 'Nfolder')
    const fold = pages.find((p) => p.id === c.ids.Fold)
    const foldOk = fold?.title === 'Fold2' && pages.find((p) => p.id === c.ids.FoldNote)?.parentId === c.ids.Fold
    return { titles, bodies: Object.fromEntries([...bodies].sort()), files, texts: Object.fromEntries([...texts].sort()), nestedOk: !!folder && nf?.parentId === folder.id, foldOk }
  }

  let reference: Awaited<ReturnType<typeof endState>>
  let requests = 0

  it('uninterrupted reference run', async () => {
    const c = await scenario()
    const start = s.seen.length
    const r = await sync(c)
    assert.equal(r.code, 0, r.out)
    requests = s.seen.length - start
    console.log(`[R9] scenario: ${requests} requests per run, each one faulted in three modes`)
    const again = await sync(c)
    assert.match(again.out, /sync done: nothing to do/, again.out)
    reference = await endState(c)
    assert.ok(reference.nestedOk)
    assert.ok(reference.foldOk, 'the renamed folder kept its page')
    assert.deepEqual(reference.titles, ['doc:Fold note', 'doc:Ledit', 'doc:Lren2', 'doc:Nfolder', 'doc:Nlink', 'doc:Nplain', 'doc:Sedit', 'doc:Sren2', 'folder:Fnew', 'folder:Fold2'])
    assert.deepEqual(reference.files, ['Fnew/Nfolder.md', 'Fold2/Fold note.md', 'Ledit.md', 'Lren2.md', 'Nlink.md', 'Nplain.md', 'Sedit.md', 'Sren2.md'])
    assert.ok(requests >= 10, `${requests} requests`)
  })

  it('a first sync (no state yet) killed at every request index, then two clean runs: no duplicates or losses', async () => {
    const first = async () => {
      const ws = (await h.makeWorkspace(alice)).id
      const vault = await mkdtemp(path.join(tmpdir(), 'inkling-vresume-first-'))
      scratch.push(vault)
      await h.makeDocPage(ws, alice.id, 'Server one', [para('server one body')] as never)
      await writeFile(path.join(vault, 'Local one.md'), 'local one\n\n- a\n- b\n')
      await writeFile(path.join(vault, 'Local two.md'), 'links [[Server one]]\n')
      await mkdir(path.join(vault, 'Dir'), { recursive: true })
      await writeFile(path.join(vault, 'Dir', 'Local three.md'), 'in a dir\n')
      return { ws, vault, ids: {} } as Ctx
    }
    const ref = await first()
    const mark = s.seen.length
    assert.equal((await sync(ref)).code, 0)
    const n = s.seen.length - mark
    const want = await endState(ref)
    const failures: string[] = []
    for (let nth = 1; nth <= n; nth++) {
      const c = await first()
      s.arm({ mode: 'kill', nth })
      await sync(c)
      s.arm(null)
      await sync(c)
      const r2 = await sync(c)
      const got = await endState(c)
      if (!/sync done: nothing to do/.test(r2.out)) failures.push(`#${nth}: third run not idle: ${r2.out.trim().split('\n').join(' | ')}`)
      if (JSON.stringify(got.titles) !== JSON.stringify(want.titles) || JSON.stringify(got.files) !== JSON.stringify(want.files) || JSON.stringify(got.bodies) !== JSON.stringify(want.bodies)) {
        failures.push(`#${nth}: titles=${JSON.stringify(got.titles)} files=${JSON.stringify(got.files)}`)
      }
    }
    console.log(`[R9] first sync: ${n} requests, each one killed`)
    assert.deepEqual(failures, [], failures.join('\n'))
  })

  for (const mode of ['before', 'after', 'kill'] as const) {
    it(`a fault (${mode}) at every request index, then two clean runs: same end state as uninterrupted`, async () => {
      assert.ok(requests > 0, 'reference ran')
      const failures: string[] = []
      for (let nth = 1; nth <= requests; nth++) {
        const c = await scenario()
        const mark = s.seen.length
        s.arm({ mode, nth })
        const faulted = await sync(c)
        const hitReq = s.seen[mark + nth - 1]
        const label = hitReq ? `${hitReq.method} ${hitReq.url.replace(/[0-9a-f-]{36}/g, ':id')}` : '?'
        const fired = s.fired()
        const leaked = s.leaked()
        s.arm(null)
        const r1 = await sync(c)
        const r2 = await sync(c)
        const got = await endState(c)
        const problems: string[] = []
        if (!fired) problems.push('fault did not fire')
        if (leaked) problems.push('harness: a request cut before its handler still ran')
        if (r1.code !== 0) problems.push(`rerun failed: ${r1.out.slice(-300)}`)
        if (!/sync done: nothing to do/.test(r2.out)) problems.push(`third run not idle: ${r2.out.trim().split('\n').join(' | ')}`)
        try {
          assert.deepEqual(got, reference)
        } catch (err) {
          problems.push(`end state differs: titles=${JSON.stringify(got.titles)} files=${JSON.stringify(got.files)} nested=${got.nestedOk} fold=${got.foldOk}`)
          for (const [k, v] of Object.entries(reference.bodies)) if (got.bodies[k] !== v) problems.push(`body ${k}: ${JSON.stringify(got.bodies[k])}`)
          for (const [k, v] of Object.entries(reference.texts)) if (got.texts[k] !== v) problems.push(`file ${k}: ${JSON.stringify(got.texts[k])}`)
          void err
        }
        if (problems.length) failures.push(`#${nth} ${label} (faulted run exit ${faulted.code ?? faulted.signal}): ${problems.join('; ')}`)
      }
      assert.deepEqual(failures, [], failures.join('\n'))
    })
  }
})
