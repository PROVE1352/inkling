// The daily budget of uploads through connections under parallel requests (C-mcp I2, 0.25.4): the
// check before the body is read lets parallel uploads all pass; the recheck inside the insert
// transaction (recheckDailyUploadBudget, docs/adr/2578-*) lets the budget be passed by one upload at
// most. AGENT_UPLOAD_DAILY_MB=1 so a few small files reach it. The env is read at import.
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
import { mkdirSync } from 'node:fs'
import path from 'node:path'

process.env.AGENT_UPLOAD_DAILY_MB = '1'
const DATA = `${process.env.TMPDIR || '/tmp'}/inkling-agentuploads-budget-${process.pid}`
process.env.DATA_DIR ||= DATA
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.APP_URL ||= 'https://notes.example.com'

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

const HAS_DB = !!process.env.DATABASE_URL
const MB = 1024 * 1024
const PART = Math.floor(0.4 * MB)

describe('[db] uploads by AI agents: the daily budget under parallel requests', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  mkdirSync(path.join(process.env.DATA_DIR!, 'uploads'), { recursive: true })
  const h = await import('./mcpTools/testHarness')
  const { db, closeDb } = await import('./db/index')
  const schema = await import('./db/schema')
  const { sql } = await import('drizzle-orm')
  const collab = await import('./collab')
  const { agentUploadEnv, recheckDailyUploadBudget } = await import('./agentUploads')
  const app = await h.buildTestApp()

  type U = Awaited<ReturnType<typeof h.makeUser>>
  let bob: U, carol: U
  let wsId: string
  let pageId: string
  let secret: string

  const multipart = (headers: Record<string, string>, name: string, bytes: Buffer) => {
    const b = '----x'
    return {
      payload: Buffer.concat([
        Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: text/plain\r\n\r\n`),
        bytes,
        Buffer.from(`\r\n--${b}--\r\n`),
      ]),
      headers: { ...headers, 'content-type': `multipart/form-data; boundary=${b}` },
    }
  }
  const used = async (userId: string) =>
    Number(
      ((await db.execute(sql`SELECT coalesce(sum(size), 0)::bigint AS n FROM files WHERE created_by = ${userId} AND uploaded_via IS NOT NULL`)) as unknown as { n: string }[])[0].n,
    )

  before(async () => {
    bob = await h.makeUser('Bob')
    carol = await h.makeUser('Carol')
    wsId = (await h.makeWorkspace(bob, [carol])).id
    pageId = (await h.makeDocPage(wsId, bob.id, 'Uploads', [{ type: 'paragraph', content: [{ type: 'text', text: 'x', styles: {} }] }] as never)).id
    const t = await app.inject({
      method: 'POST',
      url: '/api/tokens',
      headers: { cookie: bob.cookie },
      payload: { name: 'up', expiresInDays: 30, access: 'write', range: { kind: 'all' } },
    })
    secret = t.json().secret as string
  })
  after(async () => {
    await collab.destroyCollab()
    await app.close()
    await closeDb()
  })

  it('reads the 1 MB budget', () => {
    assert.equal(agentUploadEnv.dailyBytes, MB)
  })

  it('recheckDailyUploadBudget: parallel inserts pass the budget by one file at most', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) =>
        db.transaction(async (tx) => {
          await recheckDailyUploadBudget(tx, carol.id)
          await tx.insert(schema.files).values({ workspaceId: wsId, name: `p${i}.txt`, mime: 'text/plain', size: PART, createdBy: carol.id, uploadedVia: 'token:test' })
        }),
      ),
    )
    const ok = results.filter((r) => r.status === 'fulfilled').length
    // 0 → 0.4 → 0.8 MB pass the check; the third insert crosses 1 MB, the rest are refused
    assert.equal(ok, 3)
    assert.ok((await used(carol.id)) < MB + PART)
    for (const r of results) if (r.status === 'rejected') assert.match(String((r.reason as Error).message), /uploaded/)
  })

  it(
    'parallel uploads through an API token pass the budget by one upload at most',
    async () => {
      const rs = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          app.inject({
            method: 'POST',
            url: `/api/files?workspaceId=${wsId}&pageId=${pageId}`,
            ...multipart({ authorization: `Bearer ${secret}` }, `n${i}.txt`, Buffer.alloc(PART, 0x61)),
          }),
        ),
      )
      const ok = rs.filter((r) => r.statusCode === 200).length
      assert.ok(ok >= 1)
      assert.ok((await used(bob.id)) < MB + PART, `${ok} uploads stored ${(await used(bob.id)) / MB} MB`)
    },
  )
})
