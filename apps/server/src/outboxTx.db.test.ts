// Events in the writer's transaction, the batched notification consumer, NOTIFY after the commit and
// the write gate on comments and document edits (docs/adr/1150-*), against a real database.
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.DATA_DIR ||= `${process.env.TMPDIR || '/tmp'}/inkling-otx-${process.pid}`
process.env.WEBHOOK_TEST_ALLOW_LOOPBACK = '1'

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

const HAS_DB = !!process.env.DATABASE_URL
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('[db] outbox in the write transaction, write gate on comments and documents', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const h = await import('./mcpTools/testHarness')
  const { db, closeDb } = await import('./db/index')
  const schema = await import('./db/schema')
  const { and, eq, sql } = await import('drizzle-orm')
  const outbox = await import('./outbox')
  const engine = await import('./notify/engine')
  const { bumpAcl, recountLockedPages } = await import('./aclVersion')
  const { invalidateWebhookCache } = await import('./webhooks')
  const { readBlocks } = await import('./context/sectionPatch')
  const { hocuspocus } = await import('./collab')
  const app = await h.buildTestApp()

  after(async () => {
    outbox.setOutboxAutorun(true)
    await app.close()
    await outbox.stopOutboxWorker()
    await closeDb()
  })

  type U = Awaited<ReturnType<typeof h.makeUser>>
  const req = (u: U, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
    app.inject({ method, url: `/api${url}`, headers: { cookie: u.cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) })
  const code = (r: { json: () => unknown }) => (r.json() as { error?: { code?: string } }).error?.code
  const para = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text, styles: {} }] })
  const heading = (text: string) => ({ type: 'heading', props: { level: 2 }, content: [{ type: 'text', text, styles: {} }] })
  /** 'done' when `p` settles within `ms`, else 'waiting'. */
  const settles = (p: PromiseLike<unknown>, ms = 400) =>
    Promise.race([Promise.resolve(p).then(() => 'done' as const, () => 'done' as const), sleep(ms).then(() => 'waiting' as const)])
  const pending = async (wsId: string) =>
    Object.fromEntries(
      ((await db.execute(sql`
        SELECT topic, count(*)::int AS n FROM outbox WHERE workspace_id = ${wsId} AND state = 'pending' GROUP BY topic
      `)) as unknown as { topic: string; n: number }[]).map((r) => [r.topic, Number(r.n)]),
    )
  const commentCount = async (pageId: string) =>
    Number(((await db.execute(sql`SELECT count(*)::int AS n FROM comments WHERE page_id = ${pageId}`)) as unknown as { n: number }[])[0].n)
  const docText = async (pageId: string) => {
    const conn = await hocuspocus.openDirectConnection(pageId)
    try {
      return JSON.stringify(readBlocks(conn.document!))
    } finally {
      await conn.disconnect()
    }
  }
  /** A trigger that makes every insert into `table` for workspace/page `id` fail (the write's own error). */
  async function failInserts(table: 'outbox' | 'comments', col: 'workspace_id' | 'page_id', id: string): Promise<() => Promise<void>> {
    const fn = `otx_fail_${table}`
    await db.execute(sql.raw(`
      CREATE OR REPLACE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.${col} = '${id}'::uuid THEN RAISE EXCEPTION 'injected ${table} failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER ${fn} BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION ${fn}();
    `))
    return async () => {
      await db.execute(sql.raw(`DROP TRIGGER IF EXISTS ${fn} ON ${table}; DROP FUNCTION IF EXISTS ${fn}();`))
    }
  }
  /** A member removal in progress (what DELETE /workspaces/:id/members/:userId does), not committed yet. */
  function removalInProgress(wsId: string, userId: string) {
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    let started!: () => void
    const startedP = new Promise<void>((r) => (started = r))
    const done = db.transaction(async (tx) => {
      await bumpAcl(tx, wsId)
      await tx.delete(schema.workspaceMembers).where(and(eq(schema.workspaceMembers.workspaceId, wsId), eq(schema.workspaceMembers.userId, userId)))
      started()
      await held
    })
    return { started: startedP, release: () => (release(), done) }
  }
  /** A lock change in progress (what applyLockChange does): everyone denied, not committed yet. */
  function lockInProgress(wsId: string, pageId: string) {
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    let started!: () => void
    const startedP = new Promise<void>((r) => (started = r))
    const done = db.transaction(async (tx) => {
      await bumpAcl(tx, wsId)
      await tx.update(schema.pages).set({ editLocked: true }).where(eq(schema.pages.id, pageId))
      await tx.insert(schema.pageAccessOverrides).values({ pageId, subject: 'everyone', deny: 1 })
      await recountLockedPages(tx, wsId)
      started()
      await held
    })
    return { started: startedP, release: () => (release(), done) }
  }

  let O: U, M: U, B: U
  let wsId: string
  before(async () => {
    O = await h.makeUser('Owner')
    M = await h.makeUser('Member')
    B = await h.makeUser('Bystander')
    wsId = (await h.makeWorkspace(O, [M, B])).id
    await db.insert(schema.workspaceWebhooks).values({ workspaceId: wsId, kind: 'slack', url: 'http://127.0.0.1:9/hook', events: ['comment', 'page_created'] })
    invalidateWebhookCache(wsId)
  })

  describe('events commit with the write', () => {
    it('a comment, its notification event and its webhook delivery commit together, and roll back together', async () => {
      const P = (await h.makeDocPage(wsId, O.id, 'Commented', [para('x')] as never)).id
      outbox.setOutboxAutorun(false)
      try {
        const before = await pending(wsId)
        const ok = await req(M, 'POST', `/pages/${P}/comments`, { body: 'first', blockId: 'b1' })
        assert.equal(ok.statusCode, 200, ok.body)
        const afterOk = await pending(wsId)
        assert.equal((afterOk.notify ?? 0) - (before.notify ?? 0), 1, 'one notification event')
        assert.equal((afterOk.webhook ?? 0) - (before.webhook ?? 0), 1, 'one webhook delivery')
        assert.equal(await commentCount(P), 1)

        // The event cannot be queued: the comment is not written either.
        let drop = await failInserts('outbox', 'workspace_id', wsId)
        try {
          const r = await req(M, 'POST', `/pages/${P}/comments`, { body: 'lost?', blockId: 'b1' })
          assert.equal(r.statusCode, 500, r.body)
        } finally {
          await drop()
        }
        assert.equal(await commentCount(P), 1, 'no comment without its events')
        assert.deepEqual(await pending(wsId), afterOk)

        // The comment cannot be written: no event either.
        drop = await failInserts('comments', 'page_id', P)
        try {
          const r = await req(M, 'POST', `/pages/${P}/comments`, { body: 'rolled back', blockId: 'b1' })
          assert.equal(r.statusCode, 500, r.body)
        } finally {
          await drop()
        }
        assert.equal(await commentCount(P), 1)
        assert.deepEqual(await pending(wsId), afterOk, 'no events for a write that rolled back')
      } finally {
        outbox.setOutboxAutorun(true)
      }
      await engine.flushNotifications()
      const n = (await db.execute(sql`
        SELECT count(*)::int AS n FROM notifications WHERE user_id = ${O.id} AND page_id = ${P} AND type = 'comment'
      `)) as unknown as { n: number }[]
      assert.equal(Number(n[0].n), 1, 'the page creator heard about the one comment, once')
    })

    it('page events commit with the page change (rename, trash), page_created with the page', async () => {
      const P = (await h.makeDocPage(wsId, M.id, 'Renamed', [para('x')] as never)).id
      outbox.setOutboxAutorun(false)
      try {
        const before = await pending(wsId)
        assert.equal((await req(M, 'PATCH', `/pages/${P}`, { title: 'Renamed 2' })).statusCode, 200)
        assert.equal(((await pending(wsId)).change ?? 0) - (before.change ?? 0), 1, 'the rename is queued with the commit')

        const drop = await failInserts('outbox', 'workspace_id', wsId)
        try {
          assert.equal((await req(M, 'PATCH', `/pages/${P}`, { title: 'Renamed 3' })).statusCode, 500)
          assert.equal((await req(M, 'DELETE', `/pages/${P}`)).statusCode, 500)
          const created = await req(M, 'POST', '/pages', { workspaceId: wsId, title: 'New shared page' })
          assert.equal(created.statusCode, 500, created.body)
        } finally {
          await drop()
        }
        const [p] = await db.select({ title: schema.pages.title, deletedAt: schema.pages.deletedAt }).from(schema.pages).where(eq(schema.pages.id, P))
        assert.equal(p.title, 'Renamed 2', 'no rename without its event')
        assert.equal(p.deletedAt, null, 'no trash without its events')
        const made = await db.select({ id: schema.pages.id }).from(schema.pages).where(and(eq(schema.pages.workspaceId, wsId), eq(schema.pages.title, 'New shared page')))
        assert.equal(made.length, 0, 'no page without its page_created delivery')
      } finally {
        outbox.setOutboxAutorun(true)
      }
    })

    it('rows of this process are not announced; change rows are, after the commit', async () => {
      const P = (await h.makeDocPage(wsId, O.id, 'Announce', [para('x')] as never)).id
      await outbox.flushAnnouncements()
      const a0 = outbox.outboxAnnouncements
      assert.equal((await req(M, 'POST', `/pages/${P}/comments`, { body: 'quiet', blockId: 'b1' })).statusCode, 200)
      await outbox.flushAnnouncements()
      assert.equal(outbox.outboxAnnouncements, a0, 'notification and webhook rows of this process: no NOTIFY')
      assert.equal((await req(M, 'PATCH', `/pages/${P}`, { title: 'Announce 2' })).statusCode, 200)
      await outbox.flushAnnouncements()
      assert.ok(outbox.outboxAnnouncements > a0, 'a change row is announced to other processes')
    })
  })

  describe('batched notification consumer', () => {
    it('several events in one pass: same rows as one by one, the hourly cap counts rows of the same pass', async () => {
      const P = (await h.makeDocPage(wsId, O.id, 'Batch', [para('x')] as never)).id
      // B already has 59 items this hour: the next one arrives normally, the ones after it quietly.
      await db.execute(sql`
        INSERT INTO notifications (user_id, type, workspace_id, page_id, delivery)
        SELECT ${B.id}, 'comment_mention', ${wsId}, ${P}, 'quiet' FROM generate_series(1, 59)
      `)
      outbox.setOutboxAutorun(false)
      try {
        const threads = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()]
        await outbox.enqueue(
          db,
          threads.map((t) => ({
            topic: 'notify' as const,
            workspaceId: wsId,
            payload: {
              workspaceId: wsId,
              pageId: P,
              actorId: O.id,
              via: null,
              recipients: [
                { userId: B.id, kind: 'comment_mention', reason: 'direct' },
                { userId: M.id, kind: 'comment_mention', reason: 'direct' },
              ],
              threadId: t,
              excerpt: `ev ${t}`,
            },
          })),
        )
        const stats0 = { ...engine.notifyStats }
        assert.equal(await engine.runNotifyBatch(), 3)
        assert.equal(engine.notifyStats.passes - stats0.passes, 1, 'one pass')
        assert.equal(engine.notifyStats.events - stats0.events, 3)
        const rows = (await db.execute(sql`
          SELECT user_id AS u, delivery FROM notifications WHERE page_id = ${P} AND group_key IS NOT NULL ORDER BY seq
        `)) as unknown as { u: string; delivery: string }[]
        assert.deepEqual(
          rows.filter((r) => r.u === B.id).map((r) => r.delivery),
          ['now', 'quiet', 'quiet'],
          'the 60th item of the hour is the last one that pings',
        )
        assert.deepEqual(rows.filter((r) => r.u === M.id).map((r) => r.delivery), ['now', 'now', 'now'])
        assert.equal(rows.filter((r) => r.u === O.id).length, 0, 'never the actor')
      } finally {
        outbox.setOutboxAutorun(true)
      }
    })
  })

  describe('write gate on comments and document edits', () => {
    it('a comment that starts during a member removal waits for it and is refused', async () => {
      const R = await h.makeUser('Removed')
      await db.insert(schema.workspaceMembers).values({ workspaceId: wsId, userId: R.id, role: 'member' })
      const P = (await h.makeDocPage(wsId, O.id, 'Gate comment', [para('x')] as never)).id
      const mine = await req(R, 'POST', `/pages/${P}/comments`, { body: 'mine', blockId: 'b1' })
      assert.equal(mine.statusCode, 200)
      const cid = (mine.json() as { comment: { id: string } }).comment.id
      // A write that already passed its checks reaches the gate while the removal holds it.
      const removal = removalInProgress(wsId, R.id)
      await removal.started
      const post = req(R, 'POST', `/pages/${P}/comments`, { body: 'raced', blockId: 'b1' })
      const edit = req(R, 'PATCH', `/comments/${cid}`, { body: 'edited after removal' })
      assert.equal(await settles(post), 'waiting', 'the comment waits for the removal')
      assert.equal(await settles(edit, 50), 'waiting', 'the edit waits for the removal')
      await removal.release()
      assert.equal((await post).statusCode, 403)
      assert.equal((await edit).statusCode, 403)
      assert.equal(await commentCount(P), 1)
      const [c] = await db.select({ body: schema.comments.body }).from(schema.comments).where(eq(schema.comments.id, cid))
      assert.equal(c.body, 'mine')
    })

    it('a page PATCH waiting for a member removal reads the role after it (no stale membership)', async () => {
      const R = await h.makeUser('Removed2')
      await db.insert(schema.workspaceMembers).values({ workspaceId: wsId, userId: R.id, role: 'member' })
      const P = (await h.makeDocPage(wsId, R.id, 'Stale role', [para('x')] as never)).id
      const removal = removalInProgress(wsId, R.id)
      await removal.started
      const patch = req(R, 'PATCH', `/pages/${P}`, { title: 'after removal' })
      assert.equal(await settles(patch), 'waiting')
      await removal.release()
      assert.equal((await patch).statusCode, 403)
      const [p] = await db.select({ title: schema.pages.title }).from(schema.pages).where(eq(schema.pages.id, P))
      assert.equal(p.title, 'Stale role')
    })

    it('update_page (append) and patch_section that start during a lock change wait for it and are refused', async () => {
      const P = (await h.makeDocPage(wsId, M.id, 'Gate doc', [heading('Intro'), para('one')] as never)).id
      const before = await docText(P)
      const lock = lockInProgress(wsId, P)
      await lock.started
      const append = req(M, 'POST', `/pages/${P}/content`, { markdown: 'appended during the lock change', mode: 'append' })
      const patch = req(M, 'POST', `/pages/${P}/section`, { ref: 'Intro', markdown: 'patched during the lock change', mode: 'append' })
      assert.equal(await settles(append), 'waiting', 'the append waits for the lock change')
      assert.equal(await settles(patch, 50), 'waiting', 'the section patch waits for the lock change')
      await lock.release()
      const ra = await append
      const rp = await patch
      assert.equal(ra.statusCode, 403, ra.body)
      assert.equal(code(ra), 'PAGE_LOCKED')
      assert.equal(rp.statusCode, 403, rp.body)
      assert.equal(code(rp), 'PAGE_LOCKED')
      assert.equal(await docText(P), before, 'the document is untouched')
    })

    it('a version restore that starts during a lock change waits for it and is refused (docs/adr/1513-*)', async () => {
      const P = (await h.makeDocPage(wsId, M.id, 'Gate restore', [para('old text')] as never)).id
      assert.equal((await req(M, 'POST', `/pages/${P}/snapshots`, { label: 'v1' })).statusCode, 200)
      assert.equal((await req(M, 'POST', `/pages/${P}/content`, { markdown: 'new text', mode: 'replace' })).statusCode, 200)
      const [snap] = (await db.execute(sql`SELECT id FROM page_snapshots WHERE page_id = ${P} AND label = 'v1'`)) as unknown as { id: string }[]
      const before = await docText(P)
      const lock = lockInProgress(wsId, P)
      await lock.started
      const restore = req(M, 'POST', `/pages/${P}/snapshots/${snap.id}/restore`)
      assert.equal(await settles(restore), 'waiting', 'the restore waits for the lock change')
      await lock.release()
      const r = await restore
      assert.equal(r.statusCode, 403, r.body)
      assert.equal(code(r), 'PAGE_LOCKED')
      assert.equal(await docText(P), before, 'the document is untouched')
    })
  })
})
