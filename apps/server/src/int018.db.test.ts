// 0.18 integration across streams: a database automation's notification reaches the person's browser
// as a web push (group "mention", the "via automation: <rule>" wording), also from a workspace that
// person archived (ADR 2303: what calls the person is not narrowed), and the outbox reports the
// 'push' and 'automation' topics side by side.
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.APP_URL ||= 'https://notes.example.com'
process.env.APP_SECRET_KEY ||= 'test-app-secret-key-0123456789-abcdefghij'
process.env.DATA_DIR ||= `${process.env.TMPDIR || '/tmp'}/inkling-int018-${process.pid}`
process.env.PUSH_TEST_ALLOW_LOOPBACK = '1'
process.env.NOTIFY_MAIL_DELAY_MS = '3600000'

import assert from 'node:assert/strict'
import { createECDH, randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import type { CollectionField } from '@inkling/shared'

const HAS_DB = !!process.env.DATABASE_URL
mkdirSync(path.join(process.env.DATA_DIR!, 'uploads'), { recursive: true })

describe('[db] 0.18 integration: automations, web push and archived workspaces', { skip: !HAS_DB }, () => {
  let h: typeof import('./mcpTools/testHarness')
  let app: Awaited<ReturnType<typeof import('./mcpTools/testHarness').buildTestApp>>
  let db: typeof import('./db/index').db
  let closeDb: typeof import('./db/index').closeDb
  let sql: typeof import('drizzle-orm').sql
  let engine: typeof import('./notify/engine')
  let deliver: typeof import('./push/deliver')
  let outbox: typeof import('./outbox')
  let changeLog: typeof import('./context/changeLog')
  let crypto: typeof import('./push/webPushCrypto')

  const hits: { path: string; body: Buffer }[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      hits.push({ path: req.url ?? '', body: Buffer.concat(chunks) })
      res.writeHead(201)
      res.end()
    })
  })
  let base = ''

  before(async () => {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    h = await import('./mcpTools/testHarness')
    ;({ db, closeDb } = await import('./db/index'))
    ;({ sql } = await import('drizzle-orm'))
    engine = await import('./notify/engine')
    deliver = await import('./push/deliver')
    outbox = await import('./outbox')
    changeLog = await import('./context/changeLog')
    crypto = await import('./push/webPushCrypto')
    const config = await import('./push/config')
    outbox.setOutboxAutorun(false)
    config.pushPolicy.allowLoopbackForTests = true
    app = await h.buildTestApp()
  })

  after(async () => {
    await app?.close()
    await new Promise<void>((r) => server.close(() => r()))
    await closeDb?.()
  })

  function browser(name: string) {
    const ecdh = createECDH('prime256v1')
    ecdh.generateKeys()
    const auth = randomBytes(16)
    const p = `/push/${name}-${randomBytes(4).toString('hex')}`
    return {
      path: p,
      endpoint: `${base}${p}`,
      keys: { p256dh: crypto.b64u(ecdh.getPublicKey()), auth: crypto.b64u(auth) },
      open: (body: Buffer) => JSON.parse(crypto.decryptPayload(body, ecdh.getPrivateKey(), auth).toString('utf8')),
    }
  }

  type U = Awaited<ReturnType<typeof h.makeUser>>
  const req = (u: U, method: string, url: string, payload?: unknown) =>
    app.inject({ method: method as 'GET', url: `/api${url}`, headers: { cookie: u.cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) })
  const ok = async (u: U, method: string, url: string, payload?: unknown) => {
    const res = await req(u, method, url, payload)
    assert.ok(res.statusCode >= 200 && res.statusCode < 300, `${method} ${url}: ${res.statusCode} ${res.body.slice(0, 300)}`)
    return res.body ? res.json() : {}
  }

  /** Change log → automation runs → notifications → pushes, until this workspace has nothing pending. */
  async function settle(wsId: string) {
    for (let i = 0; i < 200; i++) {
      const a = await changeLog.drainChangeLog()
      const b = await outbox.drainOutbox('automation')
      await engine.flushNotifications()
      await deliver.flushPush()
      const [r] = (await db.execute(sql`SELECT count(*)::int AS n FROM outbox WHERE state = 'pending' AND workspace_id = ${wsId}`)) as unknown as { n: number }[]
      if (a === 0 && b === 0 && Number(r.n) === 0) return
      if (a === 0 && b === 0) await new Promise((res) => setTimeout(res, 50))
    }
  }

  it('an automation notifies a person who archived the workspace: a push in group "mention", via the rule, next to the assignment push', async () => {
    const alice = await h.makeUser('Alice')
    const bob = await h.makeUser('Bob')
    const ws = await h.makeWorkspace(alice, [bob])
    const b = browser('bob')
    const sub = await req(bob, 'POST', '/push/subscriptions', { endpoint: b.endpoint, keys: b.keys })
    assert.equal(sub.statusCode, 201, sub.body)
    // Bob is done with this workspace: archived in his own list (docs/adr/2300-*)
    await ok(bob, 'PATCH', `/me/workspaces/${ws.id}/listing`, { archived: true })

    const { page } = await ok(alice, 'POST', '/pages', { workspaceId: ws.id, kind: 'collection', title: 'Reviews' })
    const fields = [{ id: 'who', name: 'Reviewer', type: 'person' }] as CollectionField[]
    await ok(alice, 'PUT', `/pages/${page.id}/collection/fields`, { fields })
    await ok(alice, 'POST', `/collections/${page.id}/automations`, {
      name: 'Ping reviewer',
      trigger: { type: 'rowAdded' },
      actions: [{ type: 'notify', fieldId: 'who', message: 'please look at {{page}}' }],
    })
    const { row } = await ok(alice, 'POST', `/pages/${page.id}/collection/rows`, { title: 'Draft 3', props: { who: bob.id }, template: null })
    await settle(ws.id)

    // two notifications: the person cell assigns Bob (group "assigned"), and the rule's notify action
    const got = hits.filter((x) => x.path === b.path).map((x) => b.open(x.body))
    assert.deepEqual(got.map((x) => x.title).sort(), ['Alice assigned you "Draft 3"', 'Alice via automation: Ping reviewer mentioned you in "Draft 3"'].sort(), JSON.stringify(got))
    const p = got.find((x) => /automation/.test(x.title))
    assert.equal(p.title, 'Alice via automation: Ping reviewer mentioned you in "Draft 3"')
    assert.equal(p.body, 'Ping reviewer: please look at Draft 3')
    assert.equal(p.url, `/w/${ws.id}/p/${row.id}`)
    const [n] = (await db.execute(sql`SELECT type, via_client AS via FROM notifications WHERE user_id = ${bob.id} AND page_id = ${row.id} AND type = 'doc_mention'`)) as unknown as { type: string; via: string }[]
    assert.deepEqual({ ...n }, { type: 'doc_mention', via: 'automation: Ping reviewer' })
  })

  it('Bob switches the "mention" kind off: the automation still notifies, but does not push', async () => {
    const alice = await h.makeUser('Alice')
    const bob = await h.makeUser('Bob')
    const ws = await h.makeWorkspace(alice, [bob])
    const b = browser('bob2')
    assert.equal((await req(bob, 'POST', '/push/subscriptions', { endpoint: b.endpoint, keys: b.keys })).statusCode, 201)
    await ok(bob, 'PATCH', '/push/settings', { kinds: ['reply', 'comment'] })
    const { page } = await ok(alice, 'POST', '/pages', { workspaceId: ws.id, kind: 'collection', title: 'Queue' })
    await ok(alice, 'PUT', `/pages/${page.id}/collection/fields`, { fields: [{ id: 'who', name: 'Who', type: 'person' }] })
    await ok(alice, 'POST', `/collections/${page.id}/automations`, { name: 'Tell', trigger: { type: 'rowAdded' }, actions: [{ type: 'notify', fieldId: 'who' }] })
    const { row } = await ok(alice, 'POST', `/pages/${page.id}/collection/rows`, { title: 'Item', props: { who: bob.id }, template: null })
    await settle(ws.id)
    assert.equal(hits.filter((x) => x.path === b.path).length, 0)
    const [n] = (await db.execute(sql`SELECT count(*)::int AS n FROM notifications WHERE user_id = ${bob.id} AND page_id = ${row.id} AND type = 'doc_mention'`)) as unknown as { n: number }[]
    assert.equal(Number(n.n), 1, 'the bell still has it')
  })

  it('the outbox reports the push and automation topics next to the others', async () => {
    const pending = await outbox.pendingOutbox()
    assert.deepEqual(Object.keys(pending).sort(), ['automation', 'change', 'notify', 'push', 'slack', 'webhook'])
    assert.ok(outbox.OUTBOX_TOPICS.includes('push') && outbox.OUTBOX_TOPICS.includes('automation'))
  })
})
