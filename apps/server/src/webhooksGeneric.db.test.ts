// Generic (signed JSON) webhooks: URL policy / SSRF, signature, payload privacy, secret rotation,
// delivery records, resend, test events, the 24 h auto-disable rule and a crash after the HTTP call
// (docs/adr/1190-*, 1191-*, 1192-*, docs/WEBHOOKS.md).
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
process.env.PUBLIC_URL ||= 'https://notes.example.com/'

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

// imported after PUBLIC_URL is set (static imports are evaluated first)
const { maskWebhookUrl, parseWebhookUrl, signatureHeader, WebhookUrlError } = await import('./webhooks')

const HAS_DB = !!process.env.DATABASE_URL
const SRC = path.dirname(fileURLToPath(import.meta.url))

/** What a receiver does (docs/WEBHOOKS.md): HMAC over `t + "." + raw body`, constant-time compare. */
function verify(header: string | undefined, raw: string, secret: string, toleranceS = 300, now = Date.now() / 1000): boolean {
  if (!header) return false
  const parts = header.split(',').map((p) => p.split('='))
  const t = Number(parts.find(([k]) => k === 't')?.[1])
  if (!Number.isFinite(t) || Math.abs(now - t) > toleranceS) return false
  const want = Buffer.from(createHmac('sha256', secret).update(`${t}.${raw}`, 'utf8').digest('hex'), 'hex')
  return parts
    .filter(([k]) => k === 'v1')
    .some(([, v]) => {
      const got = Buffer.from(v ?? '', 'hex')
      return got.length === want.length && timingSafeEqual(got, want)
    })
}

describe('generic webhook URL policy (no test mode)', () => {
  // The [db] suite below turns the loopback test mode on while registering; these tests run first.
  let prev: string | undefined
  before(() => {
    prev = process.env.WEBHOOK_TEST_ALLOW_LOOPBACK
    delete process.env.WEBHOOK_TEST_ALLOW_LOOPBACK
  })
  after(() => {
    if (prev !== undefined) process.env.WEBHOOK_TEST_ALLOW_LOOPBACK = prev
  })

  it('accepts public https URLs (query kept, fragment refused) only when generic is chosen', () => {
    assert.deepEqual(parseWebhookUrl('https://n8n.example.com/webhook/abc?route=inkling', 'generic'), {
      url: 'https://n8n.example.com/webhook/abc?route=inkling',
      kind: 'generic',
    })
    // without the explicit kind, a non-Slack/Discord host is refused (no silent generic hook)
    assert.throws(() => parseWebhookUrl('https://n8n.example.com/webhook/abc'), WebhookUrlError)
    // a Slack URL stays Slack unless generic is chosen
    assert.equal(parseWebhookUrl('https://hooks.slack.com/services/T1/B2/abc').kind, 'slack')
  })

  it('refuses internal targets, other schemes and ports, credentials and fragments', () => {
    for (const bad of [
      'http://example.com/hook',
      'https://example.com:8443/hook',
      'https://user:pw@example.com/hook',
      'https://example.com/hook#x',
      'https://localhost/hook',
      'https://app.localhost/hook',
      'https://127.0.0.1/hook',
      'https://10.1.2.3/hook',
      'https://169.254.169.254/latest/meta-data',
      'https://[::1]/hook',
      'https://[::ffff:127.0.0.1]/hook',
      'https://[fd00::1]/hook',
      'https://2130706433/hook',
      'http://127.0.0.1:9/hook',
      'ftp://example.com/x',
    ]) {
      assert.throws(() => parseWebhookUrl(bad, 'generic'), WebhookUrlError, bad)
    }
  })

  it('masks everything but the host and a route-like first segment', () => {
    assert.equal(maskWebhookUrl('https://n8n.example.com/webhook/3f1c-9a?token=secret'), 'https://n8n.example.com/webhook/••••')
    assert.equal(maskWebhookUrl('https://hooks.zapier.com/hooks/catch/123/abc/'), 'https://hooks.zapier.com/hooks/••••')
    assert.equal(maskWebhookUrl('https://api.example.com/a1b2c3d4'), 'https://api.example.com/••••')
  })

  it('signs t + "." + body with every active secret (Stripe scheme)', () => {
    const body = '{"version":1,"id":"7"}'
    const h = signatureHeader(['whsec_a', 'whsec_b'], body, 1_700_000_000)
    assert.match(h, /^t=1700000000,v1=[0-9a-f]{64},v1=[0-9a-f]{64}$/)
    assert.equal(h.split(',')[1], `v1=${createHmac('sha256', 'whsec_a').update(`1700000000.${body}`).digest('hex')}`)
    assert.ok(verify(h, body, 'whsec_b', 300, 1_700_000_100))
    assert.ok(!verify(h, body, 'whsec_c', 300, 1_700_000_100))
    assert.ok(!verify(h, body + ' ', 'whsec_a', 300, 1_700_000_100), 'any byte change breaks the signature')
    assert.ok(!verify(h, body, 'whsec_a', 300, 1_700_000_301), 'outside the tolerance (replay)')
  })
})

async function runChild(body: string, env: Record<string, string> = {}): Promise<{ stdout: string; stderr: string; code: number | null; signal: string | null }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'inkling-generic-'))
  const file = path.join(dir, 'child.mjs')
  const prelude = `const M = (rel) => import(new URL(rel, ${JSON.stringify(new URL('./', `file://${SRC}/`).href)}).href)\n`
  await writeFile(file, prelude + body)
  const tsx = import.meta.resolve('tsx')
  return new Promise((resolve) => {
    const c = spawn(process.execPath, ['--import', tsx, file], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    c.stdout.on('data', (d) => (stdout += d))
    c.stderr.on('data', (d) => (stderr += d))
    c.on('exit', (code, signal) => resolve({ stdout, stderr, code, signal }))
  })
}

describe('[db] generic webhooks', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  process.env.WEBHOOK_TEST_ALLOW_LOOPBACK = '1'
  const H = await import('./mcpTools/testHarness')
  const { db, closeDb } = await import('./db/index')
  const schema = await import('./db/schema')
  const { eq, sql } = await import('drizzle-orm')
  const outbox = await import('./outbox')
  const webhooks = await import('./webhooks')
  const { AppError } = await import('./errors')
  const { ZodError } = await import('zod')
  const Fastify = (await import('fastify')).default

  const app = Fastify()
  await app.register(import('@fastify/cookie'))
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.code(err.status).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.code(400).send({ error: { code: 'VALIDATION', message: err.message } })
    return reply.code(500).send({ error: { code: 'INTERNAL', message: String(err) } })
  })
  await app.register(async (api) => (await import('./routes/webhooks')).registerWebhookRoutes(api), { prefix: '/api' })
  await app.ready()

  // Receiver: records raw bodies and headers; behaviour switchable per test.
  type Hit = { raw: string; headers: IncomingHttpHeaders; path: string }
  const hits: Hit[] = []
  let reply: { status: number; body?: string; headers?: Record<string, string> } = { status: 200 }
  const server = createServer((req, res) => {
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      hits.push({ raw, headers: req.headers, path: req.url ?? '' })
      res.writeHead(reply.status, reply.headers ?? {}).end(reply.body ?? 'ok')
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  after(async () => {
    await outbox.stopOutboxWorker()
    await closeDb()
    await new Promise<void>((r) => server.close(() => r()))
  })

  const owner = await H.makeUser('owner')
  const member = await H.makeUser('member')
  const req = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown, who = owner) =>
    app.inject({ method, url: `/api${url}`, headers: { cookie: who.cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) })

  async function setup(events = ['comment', 'mention', 'page_created']) {
    const ws = await H.makeWorkspace(owner, [member], 'Generic WS')
    const created = await req('POST', `/workspaces/${ws.id}/webhooks`, { url: `${base}/in`, events, kind: 'generic' })
    assert.equal(created.statusCode, 200, created.body)
    const { webhook, secret } = created.json() as { webhook: { id: string; kind: string; hasSecret: boolean }; secret: string }
    assert.equal(webhook.kind, 'generic')
    assert.equal(webhook.hasSecret, true)
    assert.match(secret, /^whsec_[A-Za-z0-9_-]{43}$/)
    const shared = await H.makeDocPage(ws.id, owner.id, 'Launch plan', [])
    const priv = await H.makeDocPage(ws.id, owner.id, 'My diary', [], { scope: 'private' })
    return { ws, hookId: webhook.id, secret, shared, priv }
  }
  async function comment(pageId: string, body: string) {
    const [c] = await db
      .insert(schema.comments)
      .values({ pageId, authorId: owner.id, blockId: 'x', threadId: crypto.randomUUID(), body })
      .returning()
    return c
  }
  async function settleWs(wsId: string) {
    await webhooks.flushWebhookEmits()
    for (let i = 0; i < 200; i++) {
      await outbox.drainOutbox('webhook')
      const [r] = (await db.execute(sql`
        SELECT count(*)::int AS n FROM outbox WHERE topic = 'webhook' AND state = 'pending' AND available_at <= now() AND workspace_id = ${wsId}
      `)) as unknown as { n: number }[]
      if (webhooks._queueSize() === 0 && r.n === 0) break
      await new Promise((res) => setTimeout(res, 20))
    }
  }
  const deliveries = async (hookId: string) =>
    (await req('GET', `/webhooks/${hookId}/deliveries`)).json().deliveries as {
      id: string | null
      event: string
      status: string
      attempts: number
      statusCode: number | null
      error: string | null
      responseExcerpt: string | null
      nextAttemptAt: string | null
      durationMs: number | null
      canResend: boolean
    }[]

  it('the secret is shown once; deliveries are signed JSON without comment text; private pages are never sent', async () => {
    const s = await setup()
    const list = await req('GET', `/workspaces/${s.ws.id}/webhooks`)
    assert.ok(!list.body.includes(s.secret), 'the list never contains the secret')
    assert.ok(!list.body.includes(`${base}/in`), 'nor the full URL')
    assert.equal(list.json().webhooks[0].urlMasked, `${base}/••••`)

    const c = await comment(s.shared.id, 'TOP SECRET comment text')
    const pc = await comment(s.priv.id, 'private page comment')
    hits.length = 0
    webhooks.emitWebhookEvent({ type: 'comment', workspaceId: s.ws.id, pageId: s.shared.id, actorId: owner.id, commentId: c.id, via: 'Claude' })
    webhooks.emitWebhookEvent({ type: 'comment', workspaceId: s.ws.id, pageId: s.priv.id, actorId: owner.id, commentId: pc.id })
    webhooks.emitWebhookEvent({ type: 'mention', workspaceId: s.ws.id, pageId: s.shared.id, actorId: owner.id, commentId: c.id, mentionedUserIds: [member.id] })
    await settleWs(s.ws.id)

    assert.equal(hits.length, 2, 'comment + mention on the shared page; nothing for the private page')
    for (const h of hits) {
      assert.ok(verify(h.headers['x-inkling-signature'] as string, h.raw, s.secret), 'signature verifies over the raw body')
      assert.equal(h.headers['content-type'], 'application/json')
      assert.ok(!h.raw.includes('TOP SECRET'), 'comment text is not sent')
      assert.ok(!h.raw.includes('My diary') && !h.raw.includes(s.priv.id), 'nothing about the private page')
      const p = JSON.parse(h.raw)
      assert.equal(p.version, 1)
      assert.equal(p.id, h.headers['x-inkling-delivery'], 'body id = X-Inkling-Delivery')
      assert.equal(p.type, h.headers['x-inkling-event'])
      assert.ok(!Number.isNaN(Date.parse(p.occurredAt)))
      assert.deepEqual(p.workspace, { id: s.ws.id, name: 'Generic WS' })
      assert.deepEqual(p.page, { id: s.shared.id, title: 'Launch plan', url: `https://notes.example.com/w/${s.ws.id}/p/${s.shared.id}` })
      assert.deepEqual(p.comment, { id: c.id })
    }
    const byType = Object.fromEntries(hits.map((h) => [JSON.parse(h.raw).type, JSON.parse(h.raw)]))
    assert.deepEqual(byType.comment.actor, { id: owner.id, name: 'owner', via: 'Claude' })
    assert.deepEqual(byType.mention.users, [{ id: member.id, name: 'member' }])

    // The private-page row was finished without a delivery record.
    const recs = await deliveries(s.hookId)
    assert.equal(recs.length, 2)
    assert.ok(recs.every((r) => r.status === 'ok' && r.statusCode === 200 && r.attempts === 1 && r.responseExcerpt === null && r.canResend))
    assert.deepEqual(recs.map((r) => r.id).sort(), hits.map((h) => h.headers['x-inkling-delivery'] as string).sort())
  })

  it('rotation keeps the old secret valid for 24 h unless revoked at once', async () => {
    const s = await setup()
    const other = await req('POST', `/webhooks/${s.hookId}/secret`, {}, member)
    assert.equal(other.statusCode, 403, 'owners only')
    const r1 = await req('POST', `/webhooks/${s.hookId}/secret`, {})
    assert.equal(r1.statusCode, 200, r1.body)
    const s2 = r1.json().secret as string
    assert.notEqual(s2, s.secret)
    assert.ok(r1.json().webhook.previousSecretUntil)
    hits.length = 0
    assert.equal((await req('POST', `/webhooks/${s.hookId}/test`)).json().ok, true)
    const sig = hits[0].headers['x-inkling-signature'] as string
    assert.equal(sig.split(',').filter((p) => p.startsWith('v1=')).length, 2)
    assert.ok(verify(sig, hits[0].raw, s.secret) && verify(sig, hits[0].raw, s2))

    const r2 = await req('POST', `/webhooks/${s.hookId}/secret`, { keepPrevious: false })
    const s3 = r2.json().secret as string
    assert.equal(r2.json().webhook.previousSecretUntil, null)
    hits.length = 0
    await req('POST', `/webhooks/${s.hookId}/test`)
    const sig2 = hits[0].headers['x-inkling-signature'] as string
    assert.ok(verify(sig2, hits[0].raw, s3))
    assert.ok(!verify(sig2, hits[0].raw, s2) && !verify(sig2, hits[0].raw, s.secret))
    const test = JSON.parse(hits[0].raw)
    assert.equal(test.type, 'test')
    assert.equal(hits[0].headers['x-inkling-event'], 'test')
    assert.match(test.id, /^test_/)
    assert.deepEqual(test.actor, { id: owner.id, name: 'owner', via: null })
    const recs = await deliveries(s.hookId)
    assert.ok(recs.every((r) => r.event === 'test' && r.id === null && !r.canResend))

    // Slack hooks have no secret to rotate.
    const slack = await req('POST', `/workspaces/${s.ws.id}/webhooks`, { url: `${base}/slack`, events: ['comment'], kind: 'slack' })
    assert.equal(slack.json().secret, null)
    assert.equal((await req('POST', `/webhooks/${slack.json().webhook.id}/secret`, {})).statusCode, 400)
  })

  it('records failures with a short response excerpt, retries, and resends with the same delivery id', async () => {
    const s = await setup()
    const c = await comment(s.shared.id, 'retry me')
    hits.length = 0
    reply = { status: 503, body: 'down for maintenance\n' + 'x'.repeat(100_000) }
    try {
      webhooks.emitWebhookEvent({ type: 'comment', workspaceId: s.ws.id, pageId: s.shared.id, actorId: owner.id, commentId: c.id })
      await settleWs(s.ws.id)
    } finally {
      reply = { status: 200 }
    }
    let [rec] = await deliveries(s.hookId)
    assert.equal(rec.status, 'retrying')
    assert.equal(rec.statusCode, 503)
    assert.equal(rec.error, 'HTTP 503')
    assert.ok(rec.responseExcerpt!.startsWith('down for maintenance x'))
    assert.ok(rec.responseExcerpt!.length <= 200)
    // nextAttemptAt is now() + backoff in the database; compare on that clock, not the app's
    // (they can be seconds apart, docs/adr/1243-*)
    const [{ dbNow }] = (await db.execute(sql`SELECT (extract(epoch from clock_timestamp()) * 1000)::float8 AS "dbNow"`)) as unknown as { dbNow: number }[]
    assert.ok(rec.nextAttemptAt && Date.parse(rec.nextAttemptAt) > Number(dbNow), 'the retry is scheduled in the future')
    const firstId = hits[0].headers['x-inkling-delivery']

    await db.execute(sql`UPDATE outbox SET available_at = now() WHERE id = ${rec.id}`)
    await settleWs(s.ws.id)
    ;[rec] = await deliveries(s.hookId)
    assert.deepEqual([rec.status, rec.attempts, rec.statusCode, rec.responseExcerpt, rec.nextAttemptAt], ['ok', 2, 200, null, null])

    // Resend: same row, same id, fresh signature.
    const r = await req('POST', `/webhooks/${s.hookId}/deliveries/${rec.id}/resend`)
    assert.equal(r.statusCode, 202, r.body)
    await settleWs(s.ws.id)
    assert.equal(hits.length, 3)
    assert.equal(hits[2].headers['x-inkling-delivery'], firstId)
    assert.equal(JSON.parse(hits[2].raw).id, firstId)
    assert.ok(verify(hits[2].headers['x-inkling-signature'] as string, hits[2].raw, s.secret))
    ;[rec] = await deliveries(s.hookId)
    assert.deepEqual([rec.status, rec.attempts], ['ok', 3])

    // A resent dead delivery gets a fresh retry budget: one failure is not the end.
    await db.execute(sql`UPDATE outbox SET state = 'dead', attempts = 4 WHERE id = ${rec.id}`)
    reply = { status: 500 }
    try {
      assert.equal((await req('POST', `/webhooks/${s.hookId}/deliveries/${rec.id}/resend`)).statusCode, 202)
      await settleWs(s.ws.id)
    } finally {
      reply = { status: 200 }
    }
    const [row] = (await db.execute(sql`SELECT state, attempts FROM outbox WHERE id = ${rec.id}`)) as unknown as { state: string; attempts: number }[]
    assert.deepEqual([row.state, row.attempts], ['pending', 5])

    assert.equal((await req('POST', `/webhooks/${s.hookId}/deliveries/999999999999/resend`)).statusCode, 410)
    // another hook's delivery id is "gone" for this hook
    const t = await setup()
    assert.equal((await req('POST', `/webhooks/${t.hookId}/deliveries/${rec.id}/resend`)).statusCode, 410)
    // a leased (in-flight) delivery cannot be resent
    await db.execute(sql`UPDATE outbox SET locked_until = now() + interval '30 seconds', available_at = now() + interval '1 hour' WHERE id = ${rec.id}`)
    assert.equal((await req('POST', `/webhooks/${s.hookId}/deliveries/${rec.id}/resend`)).statusCode, 409)
    await db.execute(sql`UPDATE outbox SET state = 'done', locked_until = NULL WHERE id = ${rec.id}`)
  })

  it('does not follow redirects', async () => {
    const s = await setup()
    const c = await comment(s.shared.id, 'redirect')
    hits.length = 0
    reply = { status: 302, headers: { location: `${base}/elsewhere` } }
    try {
      webhooks.emitWebhookEvent({ type: 'comment', workspaceId: s.ws.id, pageId: s.shared.id, actorId: owner.id, commentId: c.id })
      await settleWs(s.ws.id)
    } finally {
      reply = { status: 200 }
    }
    assert.deepEqual(hits.map((h) => h.path), ['/in'])
    const [rec] = await deliveries(s.hookId)
    assert.deepEqual([rec.status, rec.statusCode, rec.error], ['failed', 302, 'HTTP 302 (redirects are not followed)'])
  })

  it('a generic hook is disabled only after 5 failed events over at least 24 h; Slack keeps the 5-event rule', async () => {
    const s = await setup()
    const c = await comment(s.shared.id, 'fail')
    const fail = async (key: string) => {
      reply = { status: 400 }
      try {
        webhooks.emitWebhookEvent({ type: 'comment', workspaceId: s.ws.id, pageId: s.shared.id, actorId: owner.id, commentId: c.id, key })
        await settleWs(s.ws.id)
      } finally {
        reply = { status: 200 }
      }
    }
    const hook = async () => (await db.select().from(schema.workspaceWebhooks).where(eq(schema.workspaceWebhooks.id, s.hookId)))[0]
    for (let i = 0; i < 5; i++) await fail(`f${i}:${s.hookId}`)
    let h = await hook()
    assert.equal(h.failureCount, 5)
    assert.equal(h.enabled, '1', 'five failures within minutes: still enabled')
    assert.ok(h.failingSince)
    await db.update(schema.workspaceWebhooks).set({ failingSince: new Date(Date.now() - 25 * 3600_000) }).where(eq(schema.workspaceWebhooks.id, s.hookId))
    await fail(`f5:${s.hookId}`)
    h = await hook()
    assert.equal(h.enabled, '0')
    assert.ok(h.autoDisabledAt)
    const notes = await db.select().from(schema.notifications).where(eq(schema.notifications.workspaceId, s.ws.id))
    assert.deepEqual(notes.map((n) => [n.type, n.userId]), [['webhook_disabled', owner.id]])
    assert.equal((await req('POST', `/webhooks/${s.hookId}/deliveries/1/resend`)).statusCode, 409, 'disabled: enable first')
    // re-enabling clears the streak
    const re = await req('PATCH', `/webhooks/${s.hookId}`, { enabled: true })
    assert.deepEqual([re.json().webhook.enabled, re.json().webhook.failingSince, re.json().webhook.failureCount], [true, null, 0])

    // Slack: the fifth failed event disables, however short the streak.
    const ws2 = await H.makeWorkspace(owner, [], 'Slack WS')
    const pg2 = await H.makeDocPage(ws2.id, owner.id, 'Slack page', [])
    const c2 = await comment(pg2.id, 'x')
    const [sh] = await db
      .insert(schema.workspaceWebhooks)
      .values({ workspaceId: ws2.id, kind: 'slack', url: `${base}/slack`, events: ['comment'], failureCount: 4 })
      .returning()
    webhooks.invalidateWebhookCache(ws2.id)
    reply = { status: 400 }
    try {
      webhooks.emitWebhookEvent({ type: 'comment', workspaceId: ws2.id, pageId: pg2.id, actorId: owner.id, commentId: c2.id })
      await settleWs(ws2.id)
    } finally {
      reply = { status: 200 }
    }
    const [sh2] = await db.select().from(schema.workspaceWebhooks).where(eq(schema.workspaceWebhooks.id, sh.id))
    assert.equal(sh2.enabled, '0')
  })

  it('keeps the newest records per hook', async () => {
    const s = await setup()
    await db.execute(sql`
      INSERT INTO webhook_deliveries (hook_id, event, status, attempts)
      SELECT ${s.hookId}::uuid, 'test', 'ok', 1 FROM generate_series(1, ${webhooks.WEBHOOK_DELIVERY_KEEP + 30})
    `)
    // PRUNE_EVERY (20) test sends: exactly the workspace's token bucket
    for (let i = 0; i < 20; i++) assert.equal((await req('POST', `/webhooks/${s.hookId}/test`)).json().ok, true)
    await new Promise((r) => setTimeout(r, 200))
    const [n] = (await db.execute(sql`SELECT count(*)::int AS n FROM webhook_deliveries WHERE hook_id = ${s.hookId}::uuid`)) as unknown as { n: number }[]
    assert.equal(n.n, webhooks.WEBHOOK_DELIVERY_KEEP)
  })

  it('a crash after the HTTP call redelivers once, same delivery id, both signed', async () => {
    const s = await setup()
    const c = await comment(s.shared.id, 'crash')
    hits.length = 0
    const child = await runChild(
      `
      const outbox = await M('./outbox.ts')
      outbox.setOutboxAutorun(false)
      const { db } = await M('./db/index.ts')
      const webhooks = await M('./webhooks.ts')
      await webhooks.enqueueWebhookEvent(db, { type: 'comment', workspaceId: ${JSON.stringify(s.ws.id)}, pageId: ${JSON.stringify(s.shared.id)}, actorId: ${JSON.stringify(owner.id)}, commentId: ${JSON.stringify(c.id)} })
      webhooks.webhookTestHooks.afterSend = () => { process.stdout.write('sent\\n'); process.kill(process.pid, 'SIGKILL') }
      await webhooks.runWebhookPass()
      await new Promise((r) => setTimeout(r, 5000))
      `,
      { WEBHOOK_TEST_ALLOW_LOOPBACK: '1' },
    )
    assert.equal(child.signal, 'SIGKILL', child.stderr)
    assert.equal(hits.length, 1)
    assert.deepEqual(await deliveries(s.hookId), [], 'killed before the record was written')
    const [row] = (await db.execute(sql`SELECT id::text AS id FROM outbox WHERE workspace_id = ${s.ws.id} AND topic = 'webhook'`)) as unknown as { id: string }[]
    await db.execute(sql`UPDATE outbox SET locked_until = now() - interval '1 second', available_at = now() - interval '1 minute' WHERE id = ${row.id}`)
    await settleWs(s.ws.id)
    assert.equal(hits.length, 2)
    assert.equal(hits[0].headers['x-inkling-delivery'], hits[1].headers['x-inkling-delivery'])
    assert.equal(JSON.parse(hits[0].raw).id, JSON.parse(hits[1].raw).id)
    assert.ok(hits.every((h) => verify(h.headers['x-inkling-signature'] as string, h.raw, s.secret)))
    const [rec] = await deliveries(s.hookId)
    assert.deepEqual([rec.id, rec.status, rec.attempts], [row.id, 'ok', 2])
  })
})
