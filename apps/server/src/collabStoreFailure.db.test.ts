// A failed collab store must not end in an unload without a save (docs/adr/1921-*), against a real
// database and a real WebSocket client on the /collab endpoint:
//  - the debounced store of a client's edit fails (database fault injected in-process); the client
//    then leaves. Hocuspocus has no store queued any more, so before 0.15.1 it unloaded the document
//    and the edit was gone. Now the unload stores it first.
//  - the database is still failing when the last client leaves: the document stays in memory and a
//    retry timer stores it once the database answers again, then it unloads.
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.DATA_DIR ||= `${process.env.TMPDIR || '/tmp'}/inkling-collabfail-${process.pid}`

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { after, before, describe, it } from 'node:test'

const HAS_DB = !!process.env.DATABASE_URL
// as in index.ts: a debounced store that failed after its retries is a logged rejection, not a crash
process.on('unhandledRejection', (reason) => console.error('[test] unhandled rejection', String(reason)))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// --- minimal Hocuspocus client framing (lib0 varuint / varstring) -------------------------------
function varUint(n: number): number[] {
  const out: number[] = []
  while (n > 0x7f) {
    out.push(0x80 | (n & 0x7f))
    n = Math.floor(n / 128)
  }
  out.push(n)
  return out
}
function varBytes(b: Uint8Array): number[] {
  return [...varUint(b.length), ...b]
}
const varString = (s: string) => varBytes(new TextEncoder().encode(s))
const MSG_SYNC = 0
const MSG_AUTH = 2
const SYNC_STEP1 = 0
const SYNC_UPDATE = 2

describe('[db] collab store failure before the last client leaves', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const h = await import('./mcpTools/testHarness')
  const { db, closeDb } = await import('./db/index')
  const schema = await import('./db/schema')
  const { eq } = await import('drizzle-orm')
  const Y = await import('yjs')
  const { WebSocket } = await import('ws')
  const collab = await import('./collab')
  const { docFromStoredState } = await import('./yState')

  // Fault injection: page_docs writes of the collab store throw while `failing` is set.
  let failing = false
  let failures = 0
  const dialect = (db as unknown as { dialect: { sqlToQuery: (q: unknown) => { sql: string } } }).dialect
  const realExecute = db.execute.bind(db)
  ;(db as unknown as { execute: typeof db.execute }).execute = ((q: Parameters<typeof db.execute>[0]) => {
    if (failing) {
      let text = ''
      try {
        text = dialect.sqlToQuery(q).sql
      } catch {
        // not an SQL object
      }
      if (text.includes('INSERT INTO page_docs')) {
        failures++
        return Promise.reject(new Error('injected: database unavailable'))
      }
    }
    return realExecute(q)
  }) as unknown as typeof db.execute

  const server = createServer()
  collab.attachCollab(server)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const addr = server.address()
  const url = `ws://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/collab`
  const origRetry = { ...collab.collabStoreRetry }

  type U = Awaited<ReturnType<typeof h.makeUser>>
  let alice: U
  let wsId: string

  before(async () => {
    alice = await h.makeUser('Alice')
    wsId = (await h.makeWorkspace(alice)).id
  })

  after(async () => {
    Object.assign(collab.collabStoreRetry, origRetry)
    failing = false
    await collab.destroyCollab()
    await new Promise<void>((r) => server.close(() => r()))
    await closeDb()
  })

  /** Opens the page over /collab, sends one edit (text in a probe type), returns the socket. */
  async function editOverSocket(pageId: string, probe: string): Promise<InstanceType<typeof WebSocket>> {
    const ws = new WebSocket(url, { headers: { cookie: alice.cookie, origin: 'https://notes.example.com' } })
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve())
      ws.once('error', reject)
    })
    const send = (bytes: number[]) => ws.send(Uint8Array.from(bytes))
    send([...varString(pageId), ...varUint(MSG_AUTH), ...varUint(0), ...varString('cookie')])
    const client = new Y.Doc()
    send([...varString(pageId), ...varUint(MSG_SYNC), ...varUint(SYNC_STEP1), ...varBytes(Y.encodeStateVector(client))])
    client.getText('probe').insert(0, probe)
    send([...varString(pageId), ...varUint(MSG_SYNC), ...varUint(SYNC_UPDATE), ...varBytes(Y.encodeStateAsUpdate(client))])
    // the server applied it once the live document holds the probe
    for (let i = 0; i < 100; i++) {
      if (collab.hocuspocus.documents.get(pageId)?.getText('probe').toString() === probe) return ws
      await sleep(20)
    }
    throw new Error('the edit never reached the live document')
  }

  async function storedProbe(pageId: string): Promise<string> {
    const [row] = await db.select({ state: schema.pageDocs.state }).from(schema.pageDocs).where(eq(schema.pageDocs.pageId, pageId))
    return row ? docFromStoredState(row.state).getText('probe').toString() : ''
  }

  async function closeSocket(ws: InstanceType<typeof WebSocket>): Promise<void> {
    await new Promise<void>((r) => {
      ws.once('close', () => r())
      ws.close()
    })
  }

  it('the store failed, the database is back, the last client leaves: the edit is stored before the unload', async () => {
    const page = await h.makeDocPage(wsId, alice.id, 'Store fails once', [] as never)
    // no retry timer within this test: only the unload guard can save the edit
    collab.collabStoreRetry.baseMs = 60_000
    collab.collabStoreRetry.maxMs = 60_000
    failing = true
    failures = 0
    const ws = await editOverSocket(page.id, 'typed while the database was down')
    // debounced store (2 s) + its retries (~1.75 s) all fail
    for (let i = 0; i < 100 && failures < 4; i++) await sleep(100)
    assert.ok(failures >= 4, `the store failed with its retries (${failures})`)
    await sleep(100)
    failing = false
    await closeSocket(ws)
    for (let i = 0; i < 50 && collab.hocuspocus.documents.has(page.id); i++) await sleep(100)
    assert.equal(await storedProbe(page.id), 'typed while the database was down', 'the edit reached page_docs')
    assert.equal(collab.hocuspocus.documents.has(page.id), false, 'and the document was unloaded after that')
  })

  it('the database is still down when the last client leaves: kept in memory, stored by the retry timer', async () => {
    const page = await h.makeDocPage(wsId, alice.id, 'Store keeps failing', [] as never)
    collab.collabStoreRetry.baseMs = 300
    collab.collabStoreRetry.maxMs = 600
    failing = true
    failures = 0
    const ws = await editOverSocket(page.id, 'kept until the database answers')
    for (let i = 0; i < 100 && failures < 4; i++) await sleep(100)
    await closeSocket(ws)
    await sleep(1500)
    assert.equal(collab.hocuspocus.documents.has(page.id), true, 'not unloaded while unsaved')
    assert.equal(await storedProbe(page.id), '')
    failing = false
    for (let i = 0; i < 100 && collab.hocuspocus.documents.has(page.id); i++) await sleep(100)
    assert.equal(await storedProbe(page.id), 'kept until the database answers', 'the retry stored it')
    assert.equal(collab.hocuspocus.documents.has(page.id), false, 'then unloaded it')
  })
})
