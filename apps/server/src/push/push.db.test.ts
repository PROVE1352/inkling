// Web push end to end against a fake push service on loopback (docs/adr/2220-* .. 2223-*): register a
// browser subscription, produce a notification through the real routes and the notification engine,
// then check the request the server sent (TTL, Content-Encoding, VAPID Authorization) and decrypt its
// body with the "browser" key. Also: 410 removes the subscription, retries, send-time visibility, the
// person's switch and kinds, ownership of devices, and session / account ends removing subscriptions.
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.APP_URL ||= 'https://notes.example.com'
process.env.APP_SECRET_KEY ||= 'test-app-secret-key-0123456789-abcdefghij'
process.env.DATA_DIR ||= `${process.env.TMPDIR || '/tmp'}/inkling-push-${process.pid}`
process.env.PUSH_TEST_ALLOW_LOOPBACK = '1'
process.env.NOTIFY_MAIL_DELAY_MS = '3600000'

import assert from 'node:assert/strict'
import { createECDH } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, describe, it } from 'node:test'

const HAS_DB = !!process.env.DATABASE_URL

describe('[db] web push', { skip: !HAS_DB }, () => {
  let h: typeof import('../mcpTools/testHarness')
  let app: Awaited<ReturnType<typeof import('../mcpTools/testHarness').buildTestApp>>
  let db: typeof import('../db/index').db
  let closeDb: typeof import('../db/index').closeDb
  let sql: typeof import('drizzle-orm').sql
  let engine: typeof import('../notify/engine')
  let deliver: typeof import('./deliver')
  let outbox: typeof import('../outbox')
  let config: typeof import('./config')
  let keys: typeof import('./keys')
  let crypto: typeof import('./webPushCrypto')

  // the fake push service: every request is recorded; the status per path can be scripted
  interface Hit {
    path: string
    headers: Record<string, string | string[] | undefined>
    body: Buffer
  }
  const hits: Hit[] = []
  const script = new Map<string, number[]>()
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const path = req.url ?? ''
      hits.push({ path, headers: req.headers, body: Buffer.concat(chunks) })
      const next = script.get(path)?.shift() ?? 201
      res.writeHead(next, next === 429 ? { 'retry-after': '0' } : {})
      res.end('x'.repeat(next === 201 ? 0 : 100))
    })
  })
  let base = ''

  before(async () => {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    h = await import('../mcpTools/testHarness')
    ;({ db, closeDb } = await import('../db/index'))
    ;({ sql } = await import('drizzle-orm'))
    engine = await import('../notify/engine')
    deliver = await import('./deliver')
    outbox = await import('../outbox')
    config = await import('./config')
    keys = await import('./keys')
    crypto = await import('./webPushCrypto')
    // deliveries run only when the test drains them
    outbox.setOutboxAutorun(false)
    config.pushPolicy.allowLoopbackForTests = true
    deliver.PUSH_RETRY.baseMs = 20
    deliver.PUSH_RETRY.capMs = 50
    app = await h.buildTestApp()
  })

  after(async () => {
    await app?.close()
    await new Promise<void>((r) => server.close(() => r()))
    await closeDb?.()
  })

  /** A "browser": a P-256 key pair, an auth secret and an endpoint on the fake service. */
  function browser(name: string) {
    const ecdh = createECDH('prime256v1')
    ecdh.generateKeys()
    const auth = Buffer.alloc(16)
    for (let i = 0; i < 16; i++) auth[i] = (i * 31 + name.length) & 0xff
    const path = `/push/${name}-${Math.random().toString(36).slice(2, 10)}`
    return {
      path,
      endpoint: `${base}${path}`,
      keys: { p256dh: crypto.b64u(ecdh.getPublicKey()), auth: crypto.b64u(auth) },
      open(body: Buffer) {
        return JSON.parse(crypto.decryptPayload(body, ecdh.getPrivateKey(), auth).toString('utf8'))
      },
    }
  }

  type U = Awaited<ReturnType<typeof h.makeUser>>
  const req = (u: U | null, method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method: method as 'GET', url: `/api${url}`, headers: { ...(u ? { cookie: u.cookie } : {}), ...headers }, ...(payload !== undefined ? { payload: payload as object } : {}) })

  async function subscribe(u: U, b: ReturnType<typeof browser>, label?: string) {
    const res = await req(u, 'POST', '/push/subscriptions', { endpoint: b.endpoint, keys: b.keys, ...(label ? { label } : {}) })
    assert.equal(res.statusCode, 201, res.body)
    return res.json().id as string
  }

  async function settle() {
    await engine.flushNotifications()
    await deliver.flushPush()
  }

  const hitsFor = (b: { path: string }) => hits.filter((x) => x.path === b.path)
  const subCount = async (id: string) =>
    Number(((await db.execute(sql`SELECT count(*)::int AS n FROM push_subscriptions WHERE id = ${id}`)) as unknown as { n: number }[])[0].n)

  it('a mention reaches the browser: headers, VAPID JWT and the decrypted text', async () => {
    const alice = await h.makeUser('Alice')
    const bob = await h.makeUser('Bob')
    const ws = await h.makeWorkspace(alice, [bob])
    const page = await h.makeDocPage(ws.id, alice.id, 'Launch plan', [])
    const key = (await req(bob, 'GET', '/push/key')).json()
    assert.equal(key.available, true)
    assert.equal(crypto.fromB64u(key.publicKey).length, 65)
    const b = browser('bob')
    const subId = await subscribe(bob, b)

    // stored protected: neither the endpoint nor the auth secret is in the row as is
    const [row] = (await db.execute(sql`SELECT endpoint, auth, p256dh FROM push_subscriptions WHERE id = ${subId}`)) as unknown as {
      endpoint: string
      auth: string
      p256dh: string
    }[]
    assert.match(row.endpoint, /^v1\./)
    assert.match(row.auth, /^v1\./)
    assert.equal(row.p256dh, b.keys.p256dh)

    const c = await req(alice, 'POST', `/pages/${page.id}/comments`, { blockId: 'b1', body: '@Bob numbers before Friday?', mentionUserIds: [bob.id] })
    assert.equal(c.statusCode, 200, c.body)
    await settle()

    const got = hitsFor(b)
    assert.equal(got.length, 1)
    const hit = got[0]
    assert.equal(hit.headers['content-encoding'], 'aes128gcm')
    assert.equal(hit.headers['content-type'], 'application/octet-stream')
    assert.equal(hit.headers['ttl'], String(deliver.PUSH_TTL_S))
    assert.equal(hit.headers['urgency'], 'high')
    assert.match(String(hit.headers['topic']), /^[A-Za-z0-9_-]{1,32}$/)
    const m = /^vapid t=([^,]+), k=([A-Za-z0-9_-]+)$/.exec(String(hit.headers['authorization']))
    assert.ok(m, String(hit.headers['authorization']))
    assert.equal(m[2], key.publicKey)
    const claims = crypto.verifyVapidJwt(m[1], m[2])
    assert.ok(claims, 'JWT verifies with the advertised key')
    assert.equal(claims.aud, base)
    assert.equal(claims.sub, 'https://notes.example.com')
    assert.ok(claims.exp > Date.now() / 1000 && claims.exp <= Date.now() / 1000 + 24 * 3600)
    assert.ok(hit.body.length <= 4096)
    const p = b.open(hit.body)
    assert.equal(p.title, 'Alice mentioned you in a comment on "Launch plan"')
    assert.equal(p.body, '@Bob numbers before Friday?')
    assert.equal(p.url, `/w/${ws.id}/p/${page.id}`)
    assert.equal(p.tag, `p:${page.id}`)
    // the actor's own devices are not pinged by their own comment
    const devs = (await req(bob, 'GET', '/push/settings')).json()
    assert.equal(devs.devices.length, 1)
    assert.equal(devs.devices[0].current, true)
    assert.ok(devs.devices[0].lastSuccessAt)
  })

  it('410 Gone removes the subscription; a 500 is retried and then delivered', async () => {
    const alice = await h.makeUser('Alice')
    const bob = await h.makeUser('Bob')
    const ws = await h.makeWorkspace(alice, [bob])
    const page = await h.makeDocPage(ws.id, alice.id, 'Retry page', [])
    const gone = browser('gone')
    const flaky = browser('flaky')
    const goneId = await subscribe(bob, gone)
    // the same person on a second device, signed in with another session
    const bob2 = { ...bob, cookie: (await reSession(bob.id)).cookie }
    const flakyId = await subscribe(bob2, flaky)
    script.set(gone.path, [410])
    script.set(flaky.path, [500, 503])

    await req(alice, 'POST', `/pages/${page.id}/comments`, { blockId: 'b1', body: 'ping', mentionUserIds: [bob.id] })
    await engine.flushNotifications()
    for (let i = 0; i < 20 && hitsFor(flaky).length < 3; i++) {
      await deliver.flushPush()
      await new Promise((r) => setTimeout(r, 60))
      await db.execute(sql`UPDATE outbox SET available_at = now() WHERE topic = 'push' AND state = 'pending'`)
    }
    assert.equal(hitsFor(gone).length, 1)
    assert.equal(await subCount(goneId), 0, 'removed after 410')
    assert.equal(hitsFor(flaky).length, 3, 'two failures, then delivered')
    const [s] = (await db.execute(sql`SELECT failure_count AS n, last_success_at AS ok FROM push_subscriptions WHERE id = ${flakyId}`)) as unknown as {
      n: number
      ok: Date | null
    }[]
    assert.equal(Number(s.n), 0, 'a success resets the failure count')
    assert.ok(s.ok)
  })

  async function reSession(userId: string) {
    const { createSession, SESSION_COOKIE } = await import('../auth')
    const { token } = await createSession(userId)
    return { token, cookie: `${SESSION_COOKIE}=${token}` }
  }

  it('consecutive failures past the cap remove the subscription', async () => {
    const alice = await h.makeUser('Alice')
    const bob = await h.makeUser('Bob')
    const b = browser('broken')
    const id = await subscribe(bob, b)
    await db.execute(sql`UPDATE push_subscriptions SET failure_count = ${deliver.PUSH_MAX_FAILURES - 1} WHERE id = ${id}`)
    script.set(b.path, [400])
    void alice
    assert.equal((await req(bob, 'POST', '/push/test', {})).statusCode, 200)
    await deliver.flushPush()
    assert.equal(hitsFor(b).length, 1)
    assert.equal(await subCount(id), 0)
  })

  it('a recipient who can no longer see the page at send time gets nothing; at creation time the engine already filters', async () => {
    const alice = await h.makeUser('Alice')
    const bob = await h.makeUser('Bob')
    const carol = await h.makeUser('Carol')
    const ws = await h.makeWorkspace(alice, [bob])
    const page = await h.makeDocPage(ws.id, alice.id, 'Secret plan', [])
    const bb = browser('bob-left')
    const cb = browser('carol-outsider')
    await subscribe(bob, bb)
    await subscribe(carol, cb)
    // Carol is no member: the engine writes nothing for her, so nothing is queued
    await req(alice, 'POST', `/pages/${page.id}/comments`, { blockId: 'b1', body: 'hi', mentionUserIds: [bob.id, carol.id] })
    await engine.flushNotifications()
    // Bob leaves before the delivery runs
    await db.execute(sql`DELETE FROM workspace_members WHERE workspace_id = ${ws.id} AND user_id = ${bob.id}`)
    await deliver.flushPush()
    assert.equal(hitsFor(bb).length, 0)
    assert.equal(hitsFor(cb).length, 0)
    const rows = (await db.execute(sql`
      SELECT last_error FROM outbox WHERE topic = 'push' AND payload->>'u' = ${bob.id}
    `)) as unknown as { last_error: string }[]
    assert.deepEqual(rows.map((r) => r.last_error), ['skipped: not visible or already read'])

    // a private page of Alice: mentioning Bob there reaches nobody
    await db.execute(sql`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (${ws.id}, ${bob.id}, 'member')`)
    const priv = await h.makeDocPage(ws.id, alice.id, 'Private', [], { scope: 'private' })
    await req(alice, 'POST', `/pages/${priv.id}/comments`, { blockId: 'b1', body: 'hi', mentionUserIds: [bob.id] })
    await settle()
    assert.equal(hitsFor(bb).length, 0)
  })

  it('the person\'s switch, kinds and "hide content" are followed', async () => {
    const alice = await h.makeUser('Alice')
    const bob = await h.makeUser('Bob')
    const ws = await h.makeWorkspace(alice, [bob])
    const page = await h.makeDocPage(ws.id, alice.id, 'Settings page', [])
    const b = browser('bob-settings')
    await subscribe(bob, b)
    const mention = async (text: string) => {
      await req(alice, 'POST', `/pages/${page.id}/comments`, { blockId: `b-${Math.random()}`, body: text, mentionUserIds: [bob.id] })
      await settle()
    }
    // off
    const off = await req(bob, 'PATCH', '/push/settings', { enabled: false })
    assert.equal(off.statusCode, 200, off.body)
    assert.equal(off.json().enabled, false)
    await mention('one')
    assert.equal(hitsFor(b).length, 0)
    // on, but mentions not wanted
    await req(bob, 'PATCH', '/push/settings', { enabled: true, kinds: ['assigned', 'reply'] })
    await mention('two')
    assert.equal(hitsFor(b).length, 0)
    // mentions back, content hidden
    const s = await req(bob, 'PATCH', '/push/settings', { kinds: ['mention'], hideContent: true })
    assert.deepEqual(s.json().kinds, ['mention'])
    await mention('three secret words')
    assert.equal(hitsFor(b).length, 1)
    const p = b.open(hitsFor(b)[0].body)
    assert.equal(p.title, 'Inkling')
    assert.equal(p.body, 'New notification')
    assert.ok(!JSON.stringify(p).includes('secret'))
    assert.ok(!JSON.stringify(p).includes('Settings page'))
  })

  it('devices: only my own can be listed or removed; registering again keeps one row', async () => {
    const bob = await h.makeUser('Bob')
    const eve = await h.makeUser('Eve')
    const b = browser('bob-own')
    const id = await subscribe(bob, b, 'Phone')
    assert.equal(await subscribe(bob, b), id, 'same endpoint, same row')
    const list = (await req(bob, 'GET', '/push/settings')).json().devices
    assert.equal(list.length, 1)
    assert.equal(list[0].label, 'Phone', 'a refresh without a label keeps the name')
    assert.equal((await req(eve, 'GET', '/push/settings')).json().devices.length, 0)
    assert.equal((await req(eve, 'DELETE', `/push/devices/${id}`)).statusCode, 404)
    assert.equal((await req(eve, 'DELETE', '/push/subscriptions', { endpoint: b.endpoint })).statusCode, 204)
    assert.equal(await subCount(id), 1, "Eve cannot remove Bob's device")
    assert.equal((await req(eve, 'POST', '/push/test', { deviceId: id })).statusCode, 404)
    assert.equal((await req(bob, 'DELETE', `/push/devices/${id}`)).statusCode, 204)
    assert.equal(await subCount(id), 0)
  })

  it('a shared browser: the account that registers last owns the subscription', async () => {
    const bob = await h.makeUser('Bob')
    const eve = await h.makeUser('Eve')
    const b = browser('shared')
    const bobId = await subscribe(bob, b)
    const eveId = await subscribe(eve, b)
    assert.notEqual(eveId, bobId)
    assert.equal((await req(bob, 'GET', '/push/settings')).json().devices.length, 0)
    assert.equal((await req(eve, 'GET', '/push/settings')).json().devices.length, 1)
  })

  it('refused: bearer connections, endpoints outside the allowlist, bad keys', async () => {
    const bob = await h.makeUser('Bob')
    // a personal API token with write access (docs/adr/1201-*)
    const tok = (await req(bob, 'POST', '/tokens', { name: 'push', expiresInDays: 30, access: 'write', range: { kind: 'all' } })).json().secret as string
    const bearer = await app.inject({ method: 'GET', url: '/api/push/settings', headers: { authorization: `Bearer ${tok}` } })
    assert.equal(bearer.statusCode, 403)
    const b = browser('x')
    const post = await app.inject({
      method: 'POST',
      url: '/api/push/subscriptions',
      headers: { authorization: `Bearer ${tok}` },
      payload: { endpoint: b.endpoint, keys: b.keys },
    })
    assert.equal(post.statusCode, 403)
    assert.equal((await req(null, 'GET', '/push/key')).statusCode, 401)
    const bad = await req(bob, 'POST', '/push/subscriptions', { endpoint: 'https://push.evil.example/x', keys: b.keys })
    assert.equal(bad.statusCode, 400)
    assert.equal(bad.json().error.code, 'PUSH_SERVICE_NOT_ALLOWED')
    const internal = await req(bob, 'POST', '/push/subscriptions', { endpoint: 'http://10.0.0.1/x', keys: b.keys })
    assert.equal(internal.statusCode, 400)
    assert.equal(internal.json().error.code, 'PUSH_SUBSCRIPTION_INVALID')
    const badKeys = await req(bob, 'POST', '/push/subscriptions', { endpoint: b.endpoint, keys: { p256dh: b.keys.p256dh, auth: 'AAAA' } })
    assert.equal(badKeys.statusCode, 400)
  })

  it('logout, sign out everywhere and account deletion remove the subscriptions of those sessions', async () => {
    const { destroySession } = await import('../auth')
    const { setPassword } = await import('../accounts')
    const bob = await h.makeUser('Bob')
    const s1 = await reSession(bob.id)
    const s2 = await reSession(bob.id)
    const s3 = await reSession(bob.id)
    const id1 = await subscribe({ ...bob, cookie: s1.cookie }, browser('s1'))
    const id2 = await subscribe({ ...bob, cookie: s2.cookie }, browser('s2'))
    const id3 = await subscribe({ ...bob, cookie: s3.cookie }, browser('s3'))
    await destroySession(s1.token)
    assert.equal(await subCount(id1), 0, 'logout')
    assert.equal(await subCount(id2), 1)
    // a password change keeps only the session that made it
    await setPassword(bob.id, 'a-new-password-123', { keepSessionToken: s3.token })
    assert.equal(await subCount(id2), 0, 'sign out everywhere')
    assert.equal(await subCount(id3), 1, 'the session that changed the password')
    await db.execute(sql`DELETE FROM users WHERE id = ${bob.id}`)
    assert.equal(await subCount(id3), 0, 'account deleted')
  })

  it('a subscription made with another VAPID key is dropped at delivery', async () => {
    const bob = await h.makeUser('Bob')
    const b = browser('stale')
    const id = await subscribe(bob, b)
    await db.execute(sql`UPDATE push_subscriptions SET vapid_key_id = 'old-key-0000' WHERE id = ${id}`)
    assert.equal((await req(bob, 'GET', '/push/settings')).json().devices[0].stale, true)
    await req(bob, 'POST', '/push/test', {})
    await deliver.flushPush()
    assert.equal(hitsFor(b).length, 0)
    assert.equal(await subCount(id), 0)
  })

  it('the test notification, and the VAPID key made once and kept sealed', async () => {
    const bob = await h.makeUser('Bob')
    const b = browser('test')
    await subscribe(bob, b)
    const r = await req(bob, 'POST', '/push/test', {})
    assert.equal(r.json().queued, 1)
    await deliver.flushPush()
    const p = b.open(hitsFor(b)[0].body)
    assert.equal(p.tag, 'test')
    assert.equal(p.id, null)
    const [k] = (await db.execute(sql`SELECT public_key AS pub, private_key AS priv FROM push_vapid_keys`)) as unknown as { pub: string; priv: string }[]
    assert.match(k.priv, /^v1\./, 'private key sealed with APP_SECRET_KEY')
    keys._resetVapidCache()
    assert.equal((await keys.activeVapid()).keys.publicKey, k.pub, 'the stored pair is reused')
  })

  it('due-date reminders written outside the engine push too (pushForInserted)', async () => {
    const alice = await h.makeUser('Alice')
    const ws = await h.makeWorkspace(alice)
    const page = await h.makeDocPage(ws.id, alice.id, 'Due today', [])
    const b = browser('reminder')
    await subscribe(alice, b)
    const [n] = (await db.execute(sql`
      INSERT INTO notifications (user_id, type, page_id, workspace_id) VALUES (${alice.id}, 'reminder', ${page.id}, ${ws.id}) RETURNING id
    `)) as unknown as { id: string }[]
    await deliver.pushForInserted([n.id])
    await deliver.flushPush()
    assert.equal(hitsFor(b).length, 1)
    const p = b.open(hitsFor(b)[0].body)
    assert.equal(p.title, 'Due today: "Due today"')
    assert.equal(p.id, n.id)
    assert.equal(hitsFor(b)[0].headers['urgency'], 'high')
  })

  it('WEB_PUSH=off: nothing is queued or sent, the routes say unavailable', async () => {
    const alice = await h.makeUser('Alice')
    const bob = await h.makeUser('Bob')
    const ws = await h.makeWorkspace(alice, [bob])
    const page = await h.makeDocPage(ws.id, alice.id, 'Off page', [])
    const b = browser('off')
    await subscribe(bob, b)
    config.pushEnv.enabled = false
    try {
      assert.equal((await req(bob, 'GET', '/push/key')).json().available, false)
      assert.equal((await req(bob, 'POST', '/push/subscriptions', { endpoint: browser('o2').endpoint, keys: b.keys })).statusCode, 503)
      await req(alice, 'POST', `/pages/${page.id}/comments`, { blockId: 'b1', body: 'off?', mentionUserIds: [bob.id] })
      await settle()
      assert.equal(hitsFor(b).length, 0)
    } finally {
      config.pushEnv.enabled = true
    }
  })
})
