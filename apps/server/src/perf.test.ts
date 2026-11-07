// Phase-2 performance / cache / concurrency tests (docs/adr/0750-0757).
// Run: cd apps/server && DATABASE_URL=postgres://… npx tsx --test src/perf.test.ts
// Tests marked [db] are skipped when DATABASE_URL is unset (they need a migrated scratch DB).
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { after, describe, it } from 'node:test'
import * as Y from 'yjs'

const HAS_DB = !!process.env.DATABASE_URL
const dbIt = HAS_DB ? it : it.skip

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

describe('httpCache', async () => {
  const { ifNoneMatch, staticCacheControl } = await import('./httpCache')
  it('weak/strong/list/star matching', () => {
    assert.equal(ifNoneMatch('W/"abc"', 'W/"abc"'), true)
    assert.equal(ifNoneMatch('"abc"', 'W/"abc"'), true)
    assert.equal(ifNoneMatch('"x", W/"abc"', 'W/"abc"'), true)
    assert.equal(ifNoneMatch('*', 'W/"abc"'), true)
    assert.equal(ifNoneMatch('W/"abd"', 'W/"abc"'), false)
    assert.equal(ifNoneMatch(undefined, 'W/"abc"'), false)
  })
  it('static roles', () => {
    assert.match(staticCacheControl('assets/index-abc123.js'), /immutable/)
    assert.match(staticCacheControl('workbox-1a2b3c4d.js'), /immutable/)
    for (const f of ['index.html', 'sw.js', 'registerSW.js', 'manifest.webmanifest']) {
      assert.equal(staticCacheControl(f), 'no-cache')
    }
    assert.equal(staticCacheControl('icons/i-192.png'), 'public, max-age=86400')
  })
})

describe('BoundedLru', async () => {
  const { BoundedLru } = await import('./lru')
  it('evicts by count, bytes and recency', () => {
    const c = new BoundedLru<string>(2, 60_000, 10, (s) => s.length)
    c.set('a', 'xx')
    c.set('b', 'yy')
    c.get('a') // a is now most recent
    c.set('c', 'zz') // evicts b (count)
    assert.equal(c.get('b'), undefined)
    assert.equal(c.get('a'), 'xx')
    c.set('d', 'wwwwwwwww') // 9 bytes: evicts until ≤ 10 bytes
    assert.ok(c.byteSize <= 10)
    c.set('huge', 'x'.repeat(11)) // larger than the whole budget: not stored
    assert.equal(c.get('huge'), undefined)
  })
  it('expires by TTL', async () => {
    const c = new BoundedLru<number>(5, 5)
    c.set('k', 1)
    await new Promise((r) => setTimeout(r, 15))
    assert.equal(c.get('k'), undefined)
  })
})

describe('streamToFile', async () => {
  const { streamToFile } = await import('./routes/exportImport')
  const dir = await mkdtemp(path.join(tmpdir(), 'inkling-stream-'))
  it('writes within budget', async () => {
    const dest = path.join(dir, 'ok')
    const n = await streamToFile(Readable.from([Buffer.alloc(1000, 1), Buffer.alloc(24, 2)]), dest, 2048)
    assert.equal(n, 1024)
    assert.equal((await readFile(dest)).length, 1024)
  })
  it('over budget → -1 and no file left behind', async () => {
    const dest = path.join(dir, 'big')
    const n = await streamToFile(Readable.from([Buffer.alloc(3000, 1), Buffer.alloc(3000, 1)]), dest, 4096)
    assert.equal(n, -1)
    assert.equal(existsSync(dest), false)
  })
})

// ---------------------------------------------------------------------------
// live collab connection revocation (docs/adr/0754-*) — fake Hocuspocus instance
// ---------------------------------------------------------------------------

describe('liveConnections', async () => {
  const live = await import('./liveConnections')
  function fakeInstance(conns: Record<string, { userId: string; sessionToken?: string }[]>) {
    const closed: string[] = []
    const documents = new Map<string, unknown>()
    for (const [name, list] of Object.entries(conns)) {
      const doc = new Y.Doc()
      const connections = list.map((ctx) => ({
        context: ctx,
        close: () => closed.push(`${name}:${ctx.userId}:${ctx.sessionToken ?? ''}`),
      }))
      Object.assign(doc, { getConnections: () => connections })
      documents.set(name, doc)
    }
    live.registerHocuspocus({ documents } as never)
    return closed
  }
  const P1 = randomUUID()
  const P2 = randomUUID()

  it('force-delete / revoked sessions close every socket of the user incl. inbox', () => {
    const closed = fakeInstance({
      [P1]: [{ userId: 'u1', sessionToken: 's1' }, { userId: 'u2' }],
      [`inbox:u1`]: [{ userId: 'u1', sessionToken: 's1' }],
    })
    assert.equal(live.closeUserConnections('u1', { includeInbox: true }), 2)
    assert.deepEqual(closed.sort(), [`${P1}:u1:s1`, 'inbox:u1:u1:s1'].sort())
  })
  it('own password change keeps the current session’s sockets', () => {
    const closed = fakeInstance({
      [P1]: [{ userId: 'u1', sessionToken: 'keep' }, { userId: 'u1', sessionToken: 'old' }],
    })
    assert.equal(live.closeUserConnections('u1', { includeInbox: true, keepSessionToken: 'keep' }), 1)
    assert.deepEqual(closed, [`${P1}:u1:old`])
  })
  it('trashed/purged pages drop all their sockets', () => {
    const closed = fakeInstance({ [P1]: [{ userId: 'u1' }, { userId: 'u2' }], [P2]: [{ userId: 'u1' }] })
    assert.equal(live.closePageConnections([P1]), 2)
    assert.equal(closed.every((c) => c.startsWith(P1)), true)
  })
  it('liveDocState reads the in-memory document', () => {
    const doc = new Y.Doc()
    doc.getText('t').insert(0, 'hello')
    live.registerHocuspocus({ documents: new Map([[P1, doc]]) } as never)
    const copy = new Y.Doc()
    Y.applyUpdate(copy, live.liveDocState(P1)!)
    assert.equal(copy.getText('t').toString(), 'hello')
    assert.equal(live.liveDocState(P2), null)
  })
})

// ---------------------------------------------------------------------------
// [db] tests
// ---------------------------------------------------------------------------

describe('[db] permission-change revocation + concurrency', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const { db, closeDb } = await import('./db/index')
  const schema = await import('./db/schema')
  const live = await import('./liveConnections')
  after(async () => {
    await closeDb()
  })

  async function fixture() {
    const tag = randomUUID().slice(0, 8)
    const [a, b] = await db
      .insert(schema.users)
      .values([
        { email: `a-${tag}@t.t`, name: 'a', passwordHash: 'x' },
        { email: `b-${tag}@t.t`, name: 'b', passwordHash: 'x' },
      ])
      .returning()
    const [ws] = await db.insert(schema.workspaces).values({ name: 't', inviteCode: `t-${tag}` }).returning()
    const [ws2] = await db.insert(schema.workspaces).values({ name: 't2', inviteCode: `t2-${tag}` }).returning()
    const [p, q] = await db
      .insert(schema.pages)
      .values([
        { workspaceId: ws.id, title: 'p', createdBy: a.id, scope: 'private' },
        { workspaceId: ws2.id, title: 'q', createdBy: a.id },
      ])
      .returning()
    return { a, b, ws, ws2, p, q }
  }

  function fake(conns: Record<string, string[]>) {
    const closed: string[] = []
    const documents = new Map<string, unknown>()
    for (const [name, users] of Object.entries(conns)) {
      const connections = users.map((u) => ({ context: { userId: u }, close: () => closed.push(`${name}:${u}`) }))
      documents.set(name, { getConnections: () => connections })
    }
    live.registerHocuspocus({ documents } as never)
    return closed
  }

  dbIt('member removal closes only that member’s sockets in that workspace', async () => {
    const f = await fixture()
    const closed = fake({ [f.p.id]: [f.b.id, f.a.id], [f.q.id]: [f.b.id] })
    assert.equal(await live.closeUserWorkspaceConnections(f.b.id, f.ws.id), 1)
    assert.deepEqual(closed, [`${f.p.id}:${f.b.id}`])
  })

  dbIt('page made private closes everyone but its creator', async () => {
    const f = await fixture()
    const closed = fake({ [f.p.id]: [f.a.id, f.b.id] })
    assert.equal(await live.closeConnectionsLosingPrivateAccess([f.p.id]), 1)
    assert.deepEqual(closed, [`${f.p.id}:${f.b.id}`])
  })

  dbIt('signup key: 10 concurrent sign-ups never exceed max_uses=3', async () => {
    const { consumeSignupKey } = await import('./routes/auth')
    const key = `K-${randomUUID()}`
    await db.insert(schema.signupKeys).values({ key, maxUses: 3 } as never)
    const results = await Promise.all(Array.from({ length: 10 }, () => consumeSignupKey(key)))
    assert.equal(results.filter(Boolean).length, 3)
    const { eq } = await import('drizzle-orm')
    const [row] = await db.select().from(schema.signupKeys).where(eq(schema.signupKeys.key, key))
    assert.equal(row.usedCount, 3)
  })

  dbIt('reset code: 5 concurrent consumes succeed exactly once', async () => {
    const acc = await import('./accounts')
    const f = await fixture()
    const { code } = await acc.issueResetCode(f.a.id, null)
    const results = await Promise.all(Array.from({ length: 5 }, () => acc.consumeResetCode(f.a.id, code)))
    assert.equal(results.filter(Boolean).length, 1)
  })

  dbIt('docIndexer: debounced, diffed, immediate for server edits', async () => {
    const idx = await import('./docIndexer')
    const { blocksToStateBuffer } = await import('./md/convert')
    const { eq } = await import('drizzle-orm')
    const f = await fixture()
    const mk = (t: string) =>
      blocksToStateBuffer([{ type: 'paragraph', content: [{ type: 'text', text: t, styles: {} }] }])
    const s0 = idx.docIndexStats.runs
    await idx.scheduleDocIndex(f.p.id, mk('one #alpha'), false)
    await idx.scheduleDocIndex(f.p.id, mk('two #alpha'), false)
    assert.equal(idx.docIndexStats.runs, s0, 'debounced: nothing ran yet')
    await idx.flushDocIndexes()
    assert.equal(idx.docIndexStats.runs, s0 + 1, 'two schedules → one pass with the newest state')
    const [t1] = await db.select().from(schema.pageTexts).where(eq(schema.pageTexts.pageId, f.p.id))
    assert.equal(t1.text, 'two #alpha')
    const tagsBefore = idx.docIndexStats.tags
    await idx.scheduleDocIndex(f.p.id, mk('three #alpha'), true)
    assert.equal(idx.docIndexStats.tags, tagsBefore, 'unchanged tag set → no page_tags rewrite')
    const [t2] = await db.select().from(schema.pageTexts).where(eq(schema.pageTexts.pageId, f.p.id))
    assert.equal(t2.text, 'three #alpha', 'immediate pass is awaited')
  })

  dbIt('importer resolver ignores other users’ private pages', async () => {
    const { buildTitleResolver } = await import('./md/importer')
    const f = await fixture() // p is a's private page in ws
    const asB = await buildTitleResolver(f.ws.id, new Map(), f.b.id)
    const asA = await buildTitleResolver(f.ws.id, new Map(), f.a.id)
    assert.equal(asB('p'), null)
    assert.equal(asA('p'), `/w/${f.ws.id}/p/${f.p.id}`)
  })
})
