// Small files and the instance fuse (0.22.1, contract §15, review N2, docs/adr/2545-*). Ported from the
// review's w22-reports/sec2/re/tiny.db.test.ts: 2,000 one-byte uploads (and an empty one) all went into
// a 20 MB workspace, counted as 2,000 bytes while the disk held 8 MB in 2,001 inodes. With a storage
// limit a file now counts max(size, 4 KB) + 1 KB, so a workspace of L bytes takes at most L / 5 KB files;
// without one the count is that of 0.22.0. The fuse answers from its last measurement while it measures
// again (the walk of 100k files takes a second or more).
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
process.env.SIGNUP_REQUIRE_KEY = '0'
process.env.DATA_DIR ||= mkdtempSync(path.join(tmpdir(), 'inkling-smallfiles-'))

import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { after, before, describe, it } from 'node:test'

describe('[db] small files count their smallest size; the fuse never makes a write wait', { skip: !process.env.DATABASE_URL }, () => {
  let h: typeof import('../mcpTools/testHarness')
  let L: typeof import('../limits')
  let S: typeof import('./storage')
  let I: typeof import('./instance')
  let app: Awaited<ReturnType<typeof import('../mcpTools/testHarness').buildTestApp>>
  let closeDb: () => Promise<void>

  before(async () => {
    mkdirSync(path.join(process.env.DATA_DIR!, 'uploads'), { recursive: true })
    h = await import('../mcpTools/testHarness')
    L = await import('../limits')
    S = await import('./storage')
    I = await import('./instance')
    ;({ closeDb } = await import('../db/index'))
    app = await h.buildTestApp()
  })
  after(async () => {
    await app?.close()
    await closeDb()
    setTimeout(() => process.exit(0), 300).unref()
  })

  const boundary = 'xBOUNDARYx'
  const up = (u: { cookie: string }, ws: string, content: string) =>
    app.inject({
      method: 'POST',
      url: `/api/files?workspaceId=${ws}`,
      headers: { cookie: u.cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\nContent-Type: text/plain\r\n\r\n${content}\r\n--${boundary}--\r\n`,
    })
  const usage = async (u: { cookie: string }, ws: string) =>
    (await app.inject({ method: 'GET', url: `/api/workspaces/${ws}/usage`, headers: { cookie: u.cookie } })).json() as { fileBytes: number; storageBytes: number }

  it('a 1 MB workspace takes at most 1 MB / 5 KB one-byte files (the review: 2,000 of 2,000 into 20 MB); an empty one counts 5 KB', async () => {
    const restore = L.setLimitsForTests({ workspaceStorageMb: 1, fileMb: 5 })
    try {
      const u = await h.makeUser('tiny-n2')
      const ws = await h.makeWorkspace(u)
      const used0 = (await S.recountWorkspaceStorage(ws.id)).total
      const limit = L.mbToBytes(1)
      // the zero-byte upload is still taken (every server's behaviour), and counts as the smallest file
      assert.equal((await up(u, ws.id, '')).statusCode, 200)
      let ok = 0
      let refused: { statusCode: number; body: string } | null = null
      for (let i = 0; i < 400 && !refused; i++) {
        const r = await up(u, ws.id, 'x')
        if (r.statusCode === 200) ok++
        else refused = r
      }
      const fit = Math.floor((limit - used0) / 5120) // files of 5 KB counted that fit, the empty one included
      console.log(`[N2] limit ${limit} B, used before ${used0} B: one-byte uploads taken ${ok} (+1 empty), bound ${fit} files`)
      assert.ok(refused, 'refused before 400 uploads')
      assert.equal(refused!.statusCode, 413, refused!.body)
      assert.equal(JSON.parse(refused!.body).error.code, 'LIMIT_STORAGE')
      assert.equal(ok + 1, fit)
      const c = await S.recountWorkspaceStorage(ws.id)
      assert.equal(c.fileBytes, (ok + 1) * 5120, 'the recount counts each file as at least 4 KB + 1 KB')
      assert.equal(c.over, c.total >= limit)
      assert.equal((await usage(u, ws.id)).fileBytes, (ok + 1) * 5120)
    } finally {
      restore()
    }
  })

  it('a file of 4 KB or more counts its size + 1 KB; without a storage limit a file counts its size (0.22.0)', async () => {
    const u = await h.makeUser('tiny-plain')
    const ws = await h.makeWorkspace(u)
    for (const n of [0, 1, 5000]) assert.equal((await up(u, ws.id, 'y'.repeat(n))).statusCode, 200)
    assert.equal((await S.recountWorkspaceStorage(ws.id)).fileBytes, 5001, 'no limit: sizes only')
    const restore = L.setLimitsForTests({ workspaceStorageMb: 20 })
    try {
      assert.equal((await S.recountWorkspaceStorage(ws.id)).fileBytes, 5120 + 5120 + 6024)
    } finally {
      restore()
    }
  })

  it('the fuse answers from its last measurement while it measures again; only the first answer waits', async () => {
    // the test database alone is past 1 MB: a fresh measurement says full
    const restore = L.setLimitsForTests({ instanceStorageMb: 1 })
    try {
      I._setInstanceStorageForTests({ dbBytes: 0, fileBytes: 0 }, Date.now() - 2 * I.INSTANCE_MEASURE_MS)
      assert.equal(await I.isInstanceFull(), false, 'a stale "not full" answers at once (0.22.0 waited for the walk)')
      const t0 = Date.now()
      while (!I.instanceFullNow() && Date.now() - t0 < 10_000) await new Promise((r) => setTimeout(r, 50))
      assert.equal(I.instanceFullNow(), true, 'the measurement in the background lands')
      // no measurement yet (boot): the first answer waits for one
      I._resetInstanceStorage()
      assert.equal(await I.isInstanceFull(), true)
    } finally {
      I._setInstanceStorageForTests(null)
      restore()
    }
  })
})
