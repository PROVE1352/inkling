// Zip export teardown on a client abort (KNOWN-ISSUES B-M1, docs/adr/1241-*) and the heavy-job
// cap on the export and import routes (B-M9, docs/adr/1240-*), against a real database.
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.DATA_DIR ||= `${process.env.TMPDIR || '/tmp'}/inkling-exportzip-${process.pid}`
// One slot, a short wait: the 503 path is reached quickly (read when heavyJobs.ts loads).
process.env.HEAVY_JOBS_MAX = '1'
process.env.HEAVY_JOBS_WAIT_MS = '300'

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'

const HAS_DB = !!process.env.DATABASE_URL

/** Open file descriptors of this process (macOS and Linux). */
const openFds = () => readdirSync('/dev/fd').length
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms))

describe('[db] zip export teardown and the heavy-job cap', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const H = await import('../mcpTools/testHarness')
  const { db, closeDb } = await import('../db/index')
  const schema = await import('../db/schema')
  const { eq } = await import('drizzle-orm')
  const { exportZip } = await import('./exporter')
  const { blocksToStateBuffer } = await import('./convert')
  const { heavyJobs, heavyJobStatus } = await import('../heavyJobs')
  const JSZip = (await import('jszip')).default
  const app = await H.buildTestApp()
  await app.listen({ port: 0, host: '127.0.0.1' })
  const port = (app.server.address() as AddressInfo).port
  const dataDir = process.env.DATA_DIR!
  const tmpExports = () =>
    existsSync(path.join(dataDir, 'tmp')) ? readdirSync(path.join(dataDir, 'tmp')).filter((f) => f.startsWith('export-')) : []

  after(async () => {
    await app.close()
    await closeDb()
  })

  const owner = await H.makeUser('exporter')
  const other = await H.makeUser('other')
  const ws = await H.makeWorkspace(owner, [other])
  const ATTACHMENTS = 6
  let rootId: string

  before(async () => {
    // A folder with three docs; each doc shows two 1 MiB random (incompressible) attachments, so
    // the zip stream is several MiB and a client that stops reading leaves JSZip mid-entry.
    const folder = (await db.insert(schema.pages).values({ workspaceId: ws.id, title: 'Export me', createdBy: owner.id, kind: 'folder' }).returning())[0]
    rootId = folder.id
    await mkdir(path.join(dataDir, 'uploads'), { recursive: true })
    for (let d = 0; d < 3; d++) {
      const blocks: unknown[] = [{ type: 'paragraph', content: [{ type: 'text', text: `doc ${d}`, styles: {} }] }]
      const pg = await H.makeDocPage(ws.id, owner.id, `Doc ${d}`, [] as never, { parentId: folder.id })
      for (let a = 0; a < ATTACHMENTS / 3; a++) {
        const [f] = await db
          .insert(schema.files)
          .values({ workspaceId: ws.id, pageId: pg.id, name: `blob-${d}-${a}.bin`, mime: 'image/png', size: 1 << 20, createdBy: owner.id })
          .returning()
        await writeFile(path.join(dataDir, 'uploads', f.id), randomBytes(1 << 20))
        blocks.push({ type: 'image', props: { url: `/files/${f.id}` } })
      }
      await db.update(schema.pageDocs).set({ state: blocksToStateBuffer(blocks as never) }).where(eq(schema.pageDocs.pageId, pg.id))
    }
  })

  /** GET the subtree export over a real socket; `abortAfter` bytes, or read it all. */
  function download(abortAfter: number | null): Promise<{ status: number; bytes: number; aborted: boolean; body: Buffer }> {
    return new Promise((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port, path: `/api/pages/${rootId}/export?format=zip`, headers: { cookie: owner.cookie } },
        (res) => {
          const chunks: Buffer[] = []
          let bytes = 0
          res.on('data', (c: Buffer) => {
            bytes += c.length
            if (abortAfter === null) chunks.push(c)
            else if (bytes >= abortAfter) {
              req.destroy()
              resolve({ status: res.statusCode ?? 0, bytes, aborted: true, body: Buffer.alloc(0) })
            }
          })
          res.on('end', () => resolve({ status: res.statusCode ?? 0, bytes, aborted: false, body: Buffer.concat(chunks) }))
          res.on('error', () => {})
        },
      )
      req.on('error', (e) => (abortAfter === null ? reject(e) : undefined))
      req.end()
    })
  }

  /** Until `cond` holds, at most 5 s: teardown (fd close, temp dir rm) finishes after the response. */
  async function until(cond: () => boolean): Promise<void> {
    for (let i = 0; i < 250 && !cond(); i++) await tick()
  }
  const settle = () => until(() => heavyJobStatus().running === 0 && tmpExports().length === 0)

  it('a full download releases the slot and removes its temp dir', async () => {
    const r = await download(null)
    assert.equal(r.status, 200)
    const zip = await JSZip.loadAsync(r.body)
    const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir)
    assert.equal(names.filter((n) => n.startsWith('assets/')).length, ATTACHMENTS)
    assert.equal(names.filter((n) => n.endsWith('.md')).length, 3)
    await settle()
    assert.equal(heavyJobStatus().running, 0)
    assert.deepEqual(tmpExports(), [])
  })

  it('a client that disconnects mid-download leaks no fd, temp dir or slot', async () => {
    await download(null) // warm: database connections and lazy modules are open before the baseline
    await settle()
    const base = openFds()
    for (let i = 0; i < 5; i++) {
      const r = await download(256 * 1024)
      assert.equal(r.aborted, true)
    }
    await settle()
    assert.equal(heavyJobStatus().running, 0, 'the slot is released when fastify destroys the stream')
    assert.deepEqual(tmpExports(), [], 'spilled pages are removed')
    await until(() => openFds() <= base) // fs.close of a destroyed stream completes asynchronously
    const leaked = openFds() - base
    assert.ok(leaked <= 0, `fds after 5 aborted exports: ${leaked} more than before`)
  })

  it('a client that leaves while queued never starts an export', async () => {
    await settle()
    const hold = await heavyJobs.acquire(other.id, 'import')
    const abandoned = heavyJobStatus().totals.abandoned
    const started = heavyJobStatus().totals.started
    const req = request({ host: '127.0.0.1', port, path: `/api/pages/${rootId}/export?format=zip`, headers: { cookie: owner.cookie } })
    req.on('error', () => {})
    req.end()
    await until(() => heavyJobStatus().queued === 1)
    assert.equal(heavyJobStatus().queued, 1)
    req.destroy()
    await until(() => heavyJobStatus().queued === 0)
    assert.equal(heavyJobStatus().totals.abandoned, abandoned + 1)
    hold()
    await settle()
    assert.equal(heavyJobStatus().totals.started, started, 'no export ran for the departed client')
    assert.deepEqual(tmpExports(), [])
  })

  it('exportZip: destroying the stream mid-entry closes the entry stream and calls onFinish once', async () => {
    await settle()
    const base = openFds()
    let finished = 0
    const { stream } = await exportZip({ workspaceId: ws.id, rootPageId: rootId, zipBaseName: 'x', userId: owner.id, onFinish: () => finished++ })
    // read until an attachment is being streamed (> the rendered markdown), then stop and destroy
    await new Promise<void>((resolve) => {
      let n = 0
      stream.on('data', (c: Buffer) => {
        n += c.length
        if (n > 1.5 * (1 << 20)) {
          stream.pause()
          resolve()
        }
      })
    })
    const mid = openFds()
    assert.ok(mid > base, 'an entry file is open while the zip is mid-entry')
    stream.destroy()
    await until(() => openFds() < mid && tmpExports().length === 0)
    assert.equal(finished, 1)
    // the entry fd is closed; compared with `mid`, not `base`: the database pool may have opened
    // a connection during the render
    assert.ok(openFds() < mid, `fds: ${base} before, ${mid} mid-entry, ${openFds()} after destroy`)
    assert.deepEqual(tmpExports(), [])
    stream.destroy()
    assert.equal(finished, 1, 'idempotent')
  })

  it('a busy server answers 503 with Retry-After; a person over the per-user cap gets 429', async () => {
    await settle()
    // other holds the only slot: owner's export waits HEAVY_JOBS_WAIT_MS, then 503
    const hold = await heavyJobs.acquire(other.id, 'import')
    try {
      const busy = await app.inject({ method: 'GET', url: `/api/pages/${rootId}/export?format=zip`, headers: { cookie: owner.cookie } })
      assert.equal(busy.statusCode, 503)
      assert.equal(busy.json().error.code, 'HEAVY_JOBS_BUSY')
      assert.equal(busy.headers['retry-after'], '1')
      // other already has one running and one waiting (HEAVY_JOBS_PER_USER = 2): a third is refused at once
      const queued = heavyJobs.acquire(other.id, 'import').then((r) => r, () => null)
      const t0 = Date.now()
      const dup = await app.inject({ method: 'POST', url: `/api/pages/${rootId}/duplicate`, headers: { cookie: other.cookie } })
      assert.equal(dup.statusCode, 429)
      assert.equal(dup.json().error.code, 'HEAVY_JOBS_PER_USER')
      assert.ok(dup.headers['retry-after'])
      assert.ok(Date.now() - t0 < 250, 'refused without waiting')
      assert.equal(heavyJobStatus().totals.perUser >= 1, true)
      ;(await queued)?.()
    } finally {
      hold()
    }
    await settle()
    // free again: the copy goes through
    const ok = await app.inject({ method: 'POST', url: `/api/pages/${rootId}/duplicate`, headers: { cookie: owner.cookie } })
    assert.equal(ok.statusCode, 200, ok.body)
    assert.equal(heavyJobStatus().running, 0)
  })

  it('an upload waits for a slot after it has been spooled, and the import runs once it gets one', async () => {
    await settle()
    const hold = await heavyJobs.acquire(other.id, 'export-zip')
    const boundary = '----inkling-test'
    const md = '# Imported\n\nhello\n'
    const payload = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="note.md"\r\nContent-Type: text/markdown\r\n\r\n${md}\r\n--${boundary}--\r\n`,
    )
    const pending = app.inject({
      method: 'POST',
      url: `/api/workspaces/${ws.id}/import`,
      headers: { cookie: owner.cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    })
    // spooled first, then queued (under load the spooling alone can take a while)
    await until(() => heavyJobStatus().byKind.import.queued === 1)
    assert.equal(heavyJobStatus().byKind.import.queued, 1, 'the import waits in the queue')
    hold()
    const r = await pending
    assert.equal(r.statusCode, 200, r.body)
    assert.equal(r.json().pages.length, 1)
    const tmp = readdirSync(path.join(dataDir, 'tmp')).filter((f) => f.startsWith('import-'))
    assert.deepEqual(tmp, [], 'the spooled upload is removed')
  })
})
