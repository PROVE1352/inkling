// Vault sync revisions and deletions (docs/adr/1920-*), against a real database and the real
// `inklingctl sync` (spawned through tsx against a listening test server):
//  - a pure deletion on the server (an agent's patch_section mode=delete) changes the revision, so
//    the next sync of a vault note edited elsewhere merges instead of bringing the section back;
//  - the revision reads the same from the live document and from page_docs (V1 and V2 rows);
//  - a vault last synced by an older server (revisions without the deletion half) upgrades without
//    conflict copies or overwrites.
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.DATA_DIR ||= `${process.env.TMPDIR || '/tmp'}/inkling-vsync-${process.pid}`

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, describe, it } from 'node:test'

const HAS_DB = !!process.env.DATABASE_URL

describe('[db] vault sync revisions see deletions', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const h = await import('../mcpTools/testHarness')
  const { db, closeDb } = await import('../db/index')
  const schema = await import('../db/schema')
  const { eq, sql } = await import('drizzle-orm')
  const Y = await import('yjs')
  const collab = await import('../collab')
  const { blocksToStateBuffer } = await import('../md/convert')
  const { encodeStoredState } = await import('../yState')
  const { revisionFromDoc, revisionFromState } = await import('../md/syncMd')
  const Fastify = (await import('fastify')).default
  const { AppError } = await import('../errors')
  const { ZodError } = await import('zod')

  const app = Fastify()
  await app.register(import('@fastify/cookie'))
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.code(err.status).send({ error: { ...(err.details ?? {}), code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.code(400).send({ error: { code: 'VALIDATION', message: err.issues[0]?.message ?? 'invalid' } })
    console.error(err)
    return reply.code(500).send({ error: { code: 'INTERNAL', message: String(err) } })
  })
  await app.register(
    async (api) => {
      await (await import('./workspaces')).registerWorkspaceRoutes(api)
      await (await import('./context')).registerContextRoutes(api)
      await (await import('./sync')).registerSyncRoutes(api)
    },
    { prefix: '/api' },
  )
  await app.listen({ port: 0, host: '127.0.0.1' })
  const addr = app.server.address()
  const server = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`

  const require = createRequire(import.meta.url)
  const tsxCli = require.resolve('tsx/cli')
  const here = path.dirname(fileURLToPath(import.meta.url))
  const cliEntry = path.resolve(here, '../../../cli/src/index.ts')

  type U = Awaited<ReturnType<typeof h.makeUser>>
  const para = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text, styles: {} }] })
  const heading = (text: string) => ({ type: 'heading', props: { level: 2 }, content: [{ type: 'text', text, styles: {} }] })
  let alice: U
  let wsId: string
  let home: string
  const scratch: string[] = []

  before(async () => {
    alice = await h.makeUser('Alice')
    wsId = (await h.makeWorkspace(alice)).id
    home = await mkdtemp(path.join(tmpdir(), 'inkling-vsync-home-'))
    scratch.push(home)
  })

  after(async () => {
    await collab.destroyCollab()
    await app.close()
    await closeDb()
    for (const d of scratch) await rm(d, { recursive: true, force: true })
  })

  /** Runs the real CLI: `inklingctl sync <vault> --server … --workspace …`. */
  function sync(vault: string): Promise<{ code: number; out: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [tsxCli, cliEntry, 'sync', vault, '--server', server, '--workspace', wsId], {
        env: { ...process.env, HOME: home, INKLING_TOKEN: alice.cookie },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let out = ''
      child.stdout.on('data', (b) => (out += String(b)))
      child.stderr.on('data', (b) => (out += String(b)))
      child.on('error', reject)
      child.on('close', (code) => resolve({ code: code ?? -1, out }))
    })
  }

  const req = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
    app.inject({ method, url: `/api${url}`, headers: { cookie: alice.cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) })

  async function serverMarkdown(pageId: string): Promise<{ markdown: string; revision: string }> {
    const r = await req('POST', `/workspaces/${wsId}/sync/read`, { ids: [pageId] })
    assert.equal(r.statusCode, 200, r.body)
    return r.json().pages[0]
  }

  async function newVault(): Promise<string> {
    const v = await mkdtemp(path.join(tmpdir(), 'inkling-vsync-vault-'))
    scratch.push(v)
    return v
  }

  async function noteFile(vault: string, title: string): Promise<string> {
    const files = await readdir(vault)
    const f = files.find((x) => x === `${title}.md`)
    assert.ok(f, `vault holds ${title}.md (has: ${files.join(', ')})`)
    return path.join(vault, f)
  }

  it('a section an agent deleted stays deleted when the vault note was edited elsewhere', async () => {
    const title = `Deletes ${Date.now()}`
    const page = await h.makeDocPage(wsId, alice.id, title, [
      heading('Keep'),
      para('kept line'),
      heading('Drop'),
      para('secret section body'),
      heading('Tail'),
      para('tail line'),
    ] as never)
    const vault = await newVault()
    const first = await sync(vault)
    assert.equal(first.code, 0, first.out)
    const file = await noteFile(vault, title)
    assert.match(await readFile(file, 'utf8'), /secret section body/)

    // the agent deletes the section (a pure Yjs deletion)
    const del = await req('POST', `/pages/${page.id}/section`, { ref: 'Drop', mode: 'delete' })
    assert.equal(del.statusCode, 200, del.body)
    assert.doesNotMatch((await serverMarkdown(page.id)).markdown, /secret section body/)

    // meanwhile the vault note is edited on another line, then synced
    const text = await readFile(file, 'utf8')
    await writeFile(file, text.replace('tail line', 'tail line edited in the vault'))
    const second = await sync(vault)
    assert.equal(second.code, 0, second.out)

    const after = (await serverMarkdown(page.id)).markdown
    assert.match(after, /tail line edited in the vault/, 'the vault edit arrived')
    assert.doesNotMatch(after, /secret section body/, 'the deleted section did not come back on the server')
    assert.doesNotMatch(await readFile(file, 'utf8'), /secret section body/, 'nor in the vault')
    assert.doesNotMatch(second.out, /conflict/, second.out)
  })

  it('a vault last synced with pre-0.15.1 revisions upgrades without conflicts, overwrites or resurrections', async () => {
    const stamp = Date.now()
    const t = { same: `Up same ${stamp}`, local: `Up local ${stamp}`, both: `Up both ${stamp}`, gone: `Up gone ${stamp}` }
    const pages: Record<keyof typeof t, string> = { same: '', local: '', both: '', gone: '' }
    for (const k of Object.keys(t) as (keyof typeof t)[]) {
      pages[k] = (await h.makeDocPage(wsId, alice.id, t[k], [heading('Keep'), para(`${k} kept`), heading('Drop'), para(`${k} dropped body`), heading('Tail'), para(`${k} tail`)] as never)).id
    }
    const vault = await newVault()
    const first = await sync(vault)
    assert.equal(first.code, 0, first.out)

    // What a 0.15.0 server would have left in the vault state: revisions without the deletion half.
    const statePath = path.join(vault, '.inkling', 'sync-state.json')
    const state = JSON.parse(await readFile(statePath, 'utf8')) as { cursor: string | null; files: Record<string, { revision: string }> }
    for (const f of Object.values(state.files)) {
      const [doc, meta] = f.revision.split('.')
      f.revision = `${doc.split('-')[0]}.${meta}`
    }
    // A cursor taken after the pages were created (database clock): unchanged pages come back
    // with `revision: null`, so the CLI keeps and sends its legacy tokens, as after a real upgrade.
    const [{ now }] = (await db.execute(sql`SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now`)) as unknown as { now: string }[]
    state.cursor = now
    await writeFile(statePath, JSON.stringify(state))

    // server side, "before the upgrade": a pure deletion on `both`
    assert.equal((await req('POST', `/pages/${pages.both}/section`, { ref: 'Drop', mode: 'delete' })).statusCode, 200)
    // vault side: edits on `local` and `both`, `gone` deleted
    for (const k of ['local', 'both'] as const) {
      const f = await noteFile(vault, t[k])
      await writeFile(f, (await readFile(f, 'utf8')).replace(`${k} tail`, `${k} tail edited`))
    }
    await rm(await noteFile(vault, t.gone))
    const sameBefore = await readFile(await noteFile(vault, t.same), 'utf8')

    const second = await sync(vault)
    assert.equal(second.code, 0, second.out)
    assert.doesNotMatch(second.out, /conflict/i, second.out)
    assert.match(second.out, new RegExp(`merge\\s+${t.local}\\.md`), 'the local edit went through the 412 + merge path')
    assert.match(second.out, new RegExp(`trash-server\\s+${t.gone}\\.md`), 'the legacy DELETE was accepted')
    assert.equal(await readFile(await noteFile(vault, t.same), 'utf8'), sameBefore, 'untouched note unchanged')
    assert.match((await serverMarkdown(pages.local)).markdown, /local tail edited/)
    assert.match((await serverMarkdown(pages.local)).markdown, /local dropped body/, 'nothing lost on the local-only page')
    const both = (await serverMarkdown(pages.both)).markdown
    assert.match(both, /both tail edited/)
    assert.doesNotMatch(both, /both dropped body/, 'the deletion made before the upgrade stays')
    const [gone] = await db.select({ deletedAt: schema.pages.deletedAt }).from(schema.pages).where(eq(schema.pages.id, pages.gone))
    assert.ok(gone.deletedAt, 'the note deleted in the vault is trashed on the server (legacy token, nothing inserted since)')
    // the pages that were written now carry a current revision; an untouched page may keep its legacy
    // token until it changes (then the revisions differ and the CLI reads it, as for any change)
    const after = JSON.parse(await readFile(statePath, 'utf8')) as { files: Record<string, { revision: string }> }
    for (const pid of [pages.local, pages.both]) assert.match(after.files[pid].revision, /^[0-9a-f]{20}-[0-9a-f]{12}\./, `${pid} upgraded`)
    // a third run has nothing to do
    const third = await sync(vault)
    assert.equal(third.code, 0, third.out)
    assert.match(third.out, /sync done: nothing to do/, third.out)
  })

  it('a vault write keeps typing that was still on its way from a browser, in blocks the note left alone', async () => {
    const title = `In flight ${Date.now()}`
    const page = await h.makeDocPage(wsId, alice.id, title, [para('alpha block'), para('beta block'), para('gamma block')] as never)
    const conn = await collab.hocuspocus.openDirectConnection(page.id)
    try {
      const live = collab.hocuspocus.documents.get(page.id)!
      const { markdown, revision } = await serverMarkdown(page.id)
      // a browser holding the same state types into the first block; its update is still in transit
      const browser = new Y.Doc()
      Y.applyUpdate(browser, Y.encodeStateAsUpdate(live))
      const firstText = (function find(n: unknown): InstanceType<typeof Y.XmlText> | null {
        if (n instanceof Y.XmlText) return n
        if (n instanceof Y.XmlElement || n instanceof Y.XmlFragment) {
          for (const c of n.toArray()) {
            const f = find(c)
            if (f) return f
          }
        }
        return null
      })(browser.getXmlFragment('document'))!
      assert.equal(firstText.toString(), 'alpha block')
      const sv = Y.encodeStateVector(browser)
      firstText.insert('alpha block'.length, ' typed in the browser')
      const inFlight = Y.encodeStateAsUpdate(browser, sv)
      // the vault changes only the last block
      const put = await req('PUT', `/pages/${page.id}/sync/md`, { markdown: markdown.replace('gamma block', 'gamma edited in the vault'), expectedRevision: revision })
      assert.equal(put.statusCode, 200, put.body)
      Y.applyUpdate(live, inFlight) // the browser's update arrives
      const after = (await serverMarkdown(page.id)).markdown
      assert.match(after, /gamma edited in the vault/)
      assert.match(after, /alpha block typed in the browser/, 'the in-flight typing survived the vault write')
    } finally {
      await conn.disconnect()
    }
  })

  it('legacy tokens over REST: PUT gets 412, DELETE passes only when nothing was inserted since', async () => {
    const legacyOf = (rev: string) => `${rev.split('.')[0].split('-')[0]}.${rev.split('.')[1]}`
    const a = await h.makeDocPage(wsId, alice.id, `Legacy A ${Date.now()}`, [para('one')] as never)
    const ra = await serverMarkdown(a.id)
    const put = await req('PUT', `/pages/${a.id}/sync/md`, { markdown: ra.markdown.replace('one', 'two'), expectedRevision: legacyOf(ra.revision) })
    assert.equal(put.statusCode, 412, put.body)
    assert.equal(put.json().error.code, 'REVISION_MISMATCH')
    assert.equal((await req('DELETE', `/pages/${a.id}/sync?expectedRevision=${encodeURIComponent(legacyOf(ra.revision))}`)).statusCode, 204)

    const b = await h.makeDocPage(wsId, alice.id, `Legacy B ${Date.now()}`, [heading('H'), para('one')] as never)
    const rb = await serverMarkdown(b.id)
    assert.equal((await req('POST', `/pages/${b.id}/section`, { ref: 'H', mode: 'append', markdown: 'inserted later' })).statusCode, 200)
    const del = await req('DELETE', `/pages/${b.id}/sync?expectedRevision=${encodeURIComponent(legacyOf(rb.revision))}`)
    assert.equal(del.statusCode, 412, 'an insertion since the token: not trashed')
  })

  it('the revision is the same from the live document and from page_docs (V1 and V2 rows)', async () => {
    const page = await h.makeDocPage(wsId, alice.id, `Rev ${Date.now()}`, [heading('A'), para('one two three'), para('four')] as never)
    const conn = await collab.hocuspocus.openDirectConnection(page.id)
    try {
      await conn.transact((doc) => {
        const group = doc.getXmlFragment('document').get(0) as InstanceType<typeof Y.XmlElement>
        group.delete(group.length - 1, 1) // a pure deletion
      })
      const live = collab.hocuspocus.documents.get(page.id)!
      const fromLive = revisionFromDoc(live, 'm')
      const v2 = encodeStoredState(live)
      const v1 = Y.encodeStateAsUpdate(live)
      assert.equal(revisionFromState(v2, 'm'), fromLive, 'V2 bytes')
      assert.equal(revisionFromState(v1, 'm'), fromLive, 'V1 bytes')
      // after a reload into a fresh document (struct merging and GC may differ)
      const reloaded = new Y.Doc()
      Y.applyUpdateV2(reloaded, v2)
      assert.equal(revisionFromDoc(reloaded, 'm'), fromLive, 'reloaded document')
    } finally {
      await conn.disconnect()
    }
    // the stored row, once the store ran
    const [row] = await db.select({ state: schema.pageDocs.state }).from(schema.pageDocs).where(eq(schema.pageDocs.pageId, page.id))
    const stored = revisionFromState(row.state, 'm')
    const doc = new Y.Doc()
    Y.applyUpdateV2(doc, row.state)
    assert.equal(stored, revisionFromDoc(doc, 'm'))
    // a deletion changes the revision; nothing else does
    const before = revisionFromDoc(doc, 'm')
    doc.transact(() => (doc.getXmlFragment('document').get(0) as InstanceType<typeof Y.XmlElement>).delete(0, 1))
    assert.notEqual(revisionFromDoc(doc, 'm'), before, 'a pure deletion changes the revision')
    const v1Row = blocksToStateBuffer([para('x')] as never)
    assert.equal(revisionFromState(v1Row, 'm'), revisionFromDoc((() => { const d = new Y.Doc(); Y.applyUpdate(d, v1Row); return d })(), 'm'))
  })
})
