// import_zip and the daily budget of uploads through connections, per attachment (0.25.4, C-mcp I2
// follow-up): the budget was checked once before the first attachment, so one zip could store all of
// its attachments past it. Now it is asked again before each one; once it is passed the remaining
// attachments are skipped and reported, and the pages still import.
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
import { mkdirSync } from 'node:fs'
import path from 'node:path'

const DATA = `${process.env.TMPDIR || '/tmp'}/inkling-importzip-budget-${process.pid}`
process.env.DATA_DIR ||= DATA
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.APP_URL ||= 'https://notes.example.com'

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

const HAS_DB = !!process.env.DATABASE_URL

describe('[db] import_zip: the daily upload budget per attachment', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  mkdirSync(path.join(process.env.DATA_DIR!, 'uploads'), { recursive: true })
  const h = await import('./testHarness')
  const { db, closeDb } = await import('../db/index')
  const schema = await import('../db/schema')
  const { and, eq, isNotNull } = await import('drizzle-orm')
  const collab = await import('../collab')
  const { encodePng } = await import('../ink/png')
  const { agentUploadEnv } = await import('../agentUploads')
  const JSZip = (await import('jszip')).default
  const app = await h.buildTestApp()

  type U = Awaited<ReturnType<typeof h.makeUser>>
  let alice: U, bob: U
  let wsId: string
  let B: Awaited<ReturnType<typeof h.connectMcp>>
  const png = (shade: number) => Buffer.from(encodePng(new Uint8Array(4 * 3 * 3).fill(shade), 4, 3))

  before(async () => {
    alice = await h.makeUser('Alice')
    bob = await h.makeUser('Bob')
    wsId = (await h.makeWorkspace(alice, [bob])).id
    B = await h.connectMcp(app, { ...bob, via: 'Zipper' }, await h.mintToken(bob, 'notes', 'Zipper'))
  })
  after(async () => {
    await B.close()
    await collab.destroyCollab()
    await app.close()
    await closeDb()
  })

  it('a zip whose attachments cross the budget stores one past it at most; the rest are skipped and reported', async () => {
    const daily = agentUploadEnv.dailyBytes
    assert.ok(daily, 'the default daily budget is on')
    // one byte left before the budget
    await db
      .insert(schema.files)
      .values({ workspaceId: wsId, name: 'old.bin', mime: 'application/octet-stream', size: daily - 1, createdBy: bob.id, uploadedVia: 'grant:x' })
    const z = new JSZip()
    z.file('Many/a.md', '![1](assets/1.png) ![2](assets/2.png) ![3](assets/3.png)')
    z.file('assets/1.png', png(10))
    z.file('assets/2.png', png(20))
    z.file('assets/3.png', png(30))
    const zip = await z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
    const r = await B.tool('import_zip', { base64: zip.toString('base64') })
    assert.equal(r.isError, false, r.text)
    const stored = await db
      .select({ id: schema.files.id })
      .from(schema.files)
      .where(and(eq(schema.files.createdBy, bob.id), isNotNull(schema.files.uploadedVia), eq(schema.files.mime, 'image/png')))
    assert.equal(stored.length, 1, r.text)
    assert.equal((r.text.match(/past the daily budget/g) ?? []).length, 2, r.text)
    const pages = await db.select().from(schema.pages).where(and(eq(schema.pages.workspaceId, wsId), eq(schema.pages.title, 'Many')))
    assert.equal(pages.length, 1, 'the pages still import')
  })
})
