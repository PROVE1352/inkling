// Slack app per workspace against a local fake Slack (docs/adr/1800-* .. 1806-*): owner-only settings
// with sealed, never-returned secrets; channel posts only for shared pages, per kind, with retry,
// backoff, Retry-After and pause on refusal; writes never wait for Slack; /inkling signatures,
// timestamps, replays, linking by email and by one-time code, permission-scoped ephemeral results;
// link unfurls under the same page rule; url_verification. Nothing here calls the real Slack.
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
process.env.PUBLIC_URL = 'https://notes.example.com/'
process.env.APP_SECRET_KEY ||= 'slack-test-key-0123456789abcdefghijklmnop'
process.env.WEBHOOK_TEST_ALLOW_LOOPBACK = '1'
process.env.DATA_DIR ||= `${process.env.TMPDIR || '/tmp'}/inkling-slack-${process.pid}`

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, describe, it } from 'node:test'

const HAS_DB = !!process.env.DATABASE_URL

const TOKEN = 'xoxb-111-222-SECRETTOKENVALUEabcdef'
const SIGNING = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
const TEAM = 'T0TEAM01'
const CHANNEL = 'C0CHAN01'

interface Call {
  method: string
  auth: string | null
  params: Record<string, string>
}
type Answer = { status?: number; headers?: Record<string, string>; json?: unknown; hang?: boolean }

/** Fake Slack Web API on 127.0.0.1: records calls, answers from per-method queues or defaults. */
async function fakeSlack() {
  const calls: Call[] = []
  const queue = new Map<string, Answer[]>()
  const emails = new Map<string, string>()
  const hanging = new Set<ServerResponse>()
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      const method = (req.url ?? '').replace(/^\/api\//, '')
      const params = Object.fromEntries(new URLSearchParams(raw))
      calls.push({ method, auth: (req.headers.authorization as string) ?? null, params })
      const a = queue.get(method)?.shift()
      if (a?.hang) {
        hanging.add(res)
        return
      }
      const send = (status: number, json: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers })
        res.end(JSON.stringify(json))
      }
      if (a) return send(a.status ?? 200, a.json ?? { ok: true }, a.headers)
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(200, { ok: false, error: 'invalid_auth' })
      switch (method) {
        case 'auth.test':
          return send(200, { ok: true, team_id: TEAM, team: 'Team', user_id: 'U0BOT', bot_id: 'B1' })
        case 'conversations.info':
          return send(200, { ok: true, channel: { id: params.channel, name: 'inkling-news' } })
        case 'users.info': {
          const email = emails.get(params.user)
          return send(200, { ok: true, user: { id: params.user, is_email_confirmed: true, profile: email ? { email } : {} } })
        }
        default:
          return send(200, { ok: true, ts: '1.2' })
      }
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}/api`,
    calls,
    emails,
    next(method: string, ...answers: Answer[]) {
      queue.set(method, [...(queue.get(method) ?? []), ...answers])
    },
    release() {
      for (const r of hanging) r.destroy()
      hanging.clear()
    },
    of: (method: string) => calls.filter((c) => c.method === method),
    close: () =>
      new Promise<void>((r) => {
        for (const x of hanging) x.destroy()
        server.closeAllConnections()
        server.close(() => r())
      }),
  }
}

describe('[db] Slack app', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const slack = await fakeSlack()
  process.env.SLACK_TEST_API_URL = slack.url

  const h = await import('../mcpTools/testHarness')
  const { db, closeDb } = await import('../db/index')
  const schema = await import('../db/schema')
  const { eq, and, sql } = await import('drizzle-orm')
  const collab = await import('../collab')
  const Fastify = (await import('fastify')).default
  const { ZodError } = await import('zod')
  const { AppError } = await import('../errors')
  const { notify, flushNotifications, initNotifications } = await import('../notify/engine')
  const { flushSlack, initSlack, runSlackDigests } = await import('./notify')
  const { invalidateSlackCache } = await import('./config')
  const { slackSignature } = await import('./signature')
  const { registerSlackRoutes } = await import('../routes/slack')
  const { reindexPageChunks } = await import('../context/chunkIndex')
  const { reindexPageText } = await import('../md/textIndex')

  // Every log line of the app and of the Slack / notification modules, to prove no secret is printed.
  const logs: string[] = []
  initSlack((m) => logs.push(m))
  initNotifications((m) => logs.push(m))
  const origError = console.error
  const origWarn = console.warn
  console.error = (...a: unknown[]) => logs.push(a.map(String).join(' '))
  console.warn = (...a: unknown[]) => logs.push(a.map(String).join(' '))

  const app = Fastify({ logger: { level: 'trace', stream: { write: (s: string) => void logs.push(s) } } })
  await app.register(import('@fastify/cookie'))
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.code(err.status).send({ error: { ...(err.details ?? {}), code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.code(400).send({ error: { code: 'VALIDATION', message: err.issues[0]?.message ?? '' } })
    const sc = (err as { statusCode?: number }).statusCode
    return reply.code(sc && sc < 500 ? sc : 500).send({ error: { code: 'X', message: String(err) } })
  })
  await app.register(
    async (api) => {
      await registerSlackRoutes(api)
      // a write path: comments (the notification producer whose events Slack follows)
      await (await import('../routes/comments')).registerCommentRoutes(api)
    },
    { prefix: '/api' },
  )
  await app.ready()

  after(async () => {
    console.error = origError
    console.warn = origWarn
    await flushSlack().catch(() => undefined)
    await collab.destroyCollab()
    await app.close()
    await slack.close()
    await closeDb()
  })

  type U = Awaited<ReturnType<typeof h.makeUser>>
  const req = (u: U, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
    app.inject({ method, url: `/api${url}`, headers: { cookie: u.cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) })

  const settings = (events = ['mention', 'assigned', 'suggestion', 'reply', 'digest']) => ({ botToken: TOKEN, signingSecret: SIGNING, channelId: CHANNEL, events })

  async function team() {
    const owner = await h.makeUser('owner')
    const member = await h.makeUser('member')
    const other = await h.makeUser('other')
    const ws = await h.makeWorkspace(owner, [member, other])
    return { owner, member, other, ws }
  }

  async function connected(events?: string[]) {
    const t = await team()
    const res = await req(t.owner, 'PUT', `/workspaces/${t.ws.id}/slack`, settings(events))
    assert.equal(res.statusCode, 200, res.body)
    return t
  }

  const posts = () => slack.of('chat.postMessage').filter((c) => c.params.channel === CHANNEL)
  const settle = async () => {
    await flushNotifications()
    await flushSlack()
  }
  const blocks = (text: string) => [{ type: 'paragraph', content: [{ type: 'text', text, styles: {} }] }] as never

  /** A signed request as Slack sends it. */
  function signed(path: string, body: string, type: 'form' | 'json', opts: { ts?: number; secret?: string } = {}) {
    const ts = String(opts.ts ?? Math.floor(Date.now() / 1000))
    return {
      method: 'POST' as const,
      url: `/api/slack/w/${path}`,
      payload: body,
      headers: {
        'content-type': type === 'form' ? 'application/x-www-form-urlencoded' : 'application/json',
        'x-slack-request-timestamp': ts,
        'x-slack-signature': slackSignature(opts.secret ?? SIGNING, ts, body),
      },
    }
  }
  const command = (wsId: string, user: string, text: string, extra: Record<string, string> = {}) =>
    signed(`${wsId}/commands`, new URLSearchParams({ team_id: TEAM, user_id: user, command: '/inkling', text, trigger_id: `${Date.now()}.${Math.random()}`, ...extra }).toString(), 'form')

  it('settings: owners only; secrets required, checked with auth.test, sealed at rest, never returned', async () => {
    const { owner, member, ws } = await team()
    assert.equal((await req(member, 'GET', `/workspaces/${ws.id}/slack`)).statusCode, 403)
    assert.equal((await req(member, 'PUT', `/workspaces/${ws.id}/slack`, settings())).statusCode, 403)
    const empty = (await req(owner, 'GET', `/workspaces/${ws.id}/slack`)).json()
    assert.equal(empty.integration, null)
    assert.equal(empty.setup.commandUrl, `https://notes.example.com/api/slack/w/${ws.id}/commands`)

    const missing = await req(owner, 'PUT', `/workspaces/${ws.id}/slack`, { channelId: CHANNEL, events: [] })
    assert.equal(missing.json().error.code, 'SLACK_SECRETS_REQUIRED')
    // a token Slack refuses: 400 with Slack's code only, nothing stored, token not echoed
    const bad = await req(owner, 'PUT', `/workspaces/${ws.id}/slack`, { ...settings(), botToken: 'xoxb-999-WRONGTOKENxyz' })
    assert.equal(bad.statusCode, 400)
    assert.equal(bad.json().error.code, 'SLACK_AUTH_FAILED')
    assert.equal(bad.json().error.slackError, 'invalid_auth')
    assert.ok(!bad.body.includes('WRONGTOKEN'))

    const ok = await req(owner, 'PUT', `/workspaces/${ws.id}/slack`, settings(['mention']))
    assert.equal(ok.statusCode, 200)
    const dto = ok.json().integration
    assert.equal(dto.botTokenHint, `xoxb-…${TOKEN.slice(-4)}`)
    assert.equal(dto.signingSecretSet, true)
    assert.equal(dto.sealed, true)
    assert.equal(dto.secretsReadable, true)
    assert.equal(dto.teamId, TEAM)
    assert.equal(dto.channelName, 'inkling-news')
    const got = await req(owner, 'GET', `/workspaces/${ws.id}/slack`)
    for (const body of [ok.body, got.body]) {
      assert.ok(!body.includes(TOKEN) && !body.includes(TOKEN.slice(5)), 'token never returned')
      assert.ok(!body.includes(SIGNING), 'signing secret never returned')
    }
    const [row] = await db.select().from(schema.slackIntegrations).where(eq(schema.slackIntegrations.workspaceId, ws.id))
    assert.match(row.botToken, /^v1\./)
    assert.match(row.signingSecret, /^v1\./)
    assert.ok(!row.botToken.includes(TOKEN) && !row.signingSecret.includes(SIGNING))
    // the auth.test call carried the token in the header, never in the body
    const at = slack.of('auth.test').at(-1)!
    assert.equal(at.auth, `Bearer ${TOKEN}`)
    assert.ok(!JSON.stringify(at.params).includes(TOKEN))

    // a later save without secrets keeps them
    const keep = await req(owner, 'PUT', `/workspaces/${ws.id}/slack`, { channelId: CHANNEL, events: ['mention', 'reply'] })
    assert.equal(keep.statusCode, 200)
    const [row2] = await db.select().from(schema.slackIntegrations).where(eq(schema.slackIntegrations.workspaceId, ws.id))
    assert.equal(row2.botToken, row.botToken)
    assert.deepEqual(row2.events, ['mention', 'reply'])
    // the audit log says what changed, never the values
    const audit = await db.select().from(schema.workspaceAuditEvents).where(eq(schema.workspaceAuditEvents.workspaceId, ws.id))
    assert.ok(audit.length >= 2)
    const auditText = JSON.stringify(audit)
    assert.ok(!auditText.includes(TOKEN.slice(5)) && !auditText.includes(SIGNING))

    // disconnect removes the row (and the links)
    assert.equal((await req(owner, 'DELETE', `/workspaces/${ws.id}/slack`)).statusCode, 200)
    assert.equal((await req(owner, 'GET', `/workspaces/${ws.id}/slack`)).json().integration, null)
  })

  it('channel posts: shared pages only, per switched-on kind, agent mentions stay quiet', async () => {
    const { owner, member, other, ws } = await connected(['mention', 'assigned', 'suggestion'])
    const shared = await h.makeDocPage(ws.id, owner.id, 'Launch <plan> & notes', blocks('hello'))
    const priv = await h.makeDocPage(ws.id, owner.id, 'Salary review PRIVATE-TITLE', blocks('secret body'), { scope: 'private' })
    const before = posts().length

    notify({ workspaceId: ws.id, pageId: priv.id, actorId: owner.id, via: null, recipients: [{ userId: member.id, kind: 'doc_mention', reason: 'direct' }] })
    notify({ workspaceId: ws.id, pageId: shared.id, actorId: owner.id, via: null, recipients: [{ userId: member.id, kind: 'comment_reply', reason: 'direct' }] })
    notify({ workspaceId: ws.id, pageId: shared.id, actorId: owner.id, via: 'Claude', recipients: [{ userId: other.id, kind: 'doc_mention', reason: 'direct' }] })
    notify({ workspaceId: ws.id, pageId: shared.id, actorId: owner.id, via: null, recipients: [{ userId: member.id, kind: 'doc_mention', reason: 'direct' }] })
    notify({ workspaceId: ws.id, pageId: shared.id, actorId: null, via: 'Claude', recipients: [{ userId: owner.id, kind: 'approval_request', reason: 'direct' }], anchor: 'goals', excerpt: 'SUGGESTED-BODY text' })
    notify({ workspaceId: ws.id, pageId: shared.id, actorId: owner.id, via: null, recipients: [{ userId: member.id, kind: 'task_assigned', reason: 'direct' }], excerpt: 'Reviewer' })
    await settle()

    const mine = posts().slice(before)
    assert.equal(mine.length, 3, JSON.stringify(mine.map((c) => c.params.text)))
    const all = mine.map((c) => c.params.text).join('\n')
    assert.ok(!all.includes('PRIVATE-TITLE'), 'private page never named')
    assert.ok(!all.includes('SUGGESTED-BODY'), 'suggestion text never sent')
    assert.ok(all.includes('Launch &lt;plan&gt; &amp; notes'), 'title escaped')
    assert.ok(all.includes(`https://notes.example.com/w/${ws.id}/p/${shared.id}`))
    assert.match(all, /owner mentioned member in/)
    assert.match(all, /suggested an edit to .*§goals/)
    assert.match(all, /assigned member to .*\(Reviewer\)/)
    for (const c of mine) {
      assert.equal(c.auth, `Bearer ${TOKEN}`)
      assert.equal(c.params.unfurl_links, 'false')
    }

    // a page made private before delivery is dropped at delivery
    await db.update(schema.pages).set({ scope: 'private' }).where(eq(schema.pages.id, shared.id))
    const n = posts().length
    notify({ workspaceId: ws.id, pageId: shared.id, actorId: owner.id, via: null, recipients: [{ userId: other.id, kind: 'doc_mention', reason: 'direct' }] })
    await settle()
    assert.equal(posts().length, n)
  })

  it('a comment reply through the API reaches the channel with its excerpt; saving never waits for Slack', async () => {
    const { owner, member, ws } = await connected(['reply'])
    const page = await h.makeDocPage(ws.id, owner.id, 'Retro', blocks('x'))
    const first = await req(member, 'POST', `/pages/${page.id}/comments`, { blockId: 'b1', body: 'Should we move the date?' })
    assert.equal(first.statusCode, 200, first.body)
    await settle()
    // Slack hangs: the reply is saved and its notifications land without waiting
    slack.next('chat.postMessage', { hang: true })
    const t0 = Date.now()
    const reply = await req(owner, 'POST', `/pages/${page.id}/comments`, { blockId: 'b1', body: 'Yes, to Friday', threadId: first.json().comment.threadId ?? first.json().comment.id })
    assert.equal(reply.statusCode, 200, reply.body)
    await flushNotifications()
    assert.ok(Date.now() - t0 < 3_000, 'write and notifications did not wait for Slack')
    const notes = await db.select().from(schema.notifications).where(and(eq(schema.notifications.userId, member.id), eq(schema.notifications.pageId, page.id)))
    assert.ok(notes.length >= 1, 'notification row written while Slack hangs')
    slack.release()
    // the hung attempt failed; the retry goes through
    await flushSlack()
    await db.execute(sql`UPDATE outbox SET available_at = now() WHERE topic = 'slack' AND workspace_id = ${ws.id} AND state = 'pending'`)
    await flushSlack()
    const got = posts().filter((c) => c.params.text.includes('Retro'))
    assert.ok(got.some((c) => /replied in a comment thread/.test(c.params.text) && c.params.text.includes('\n> Yes, to Friday')), JSON.stringify(got.map((g) => g.params.text)))
  })

  it('delivery: 5xx retries with backoff, 429 waits Retry-After, refusals pause posts until a passing test', async () => {
    const { owner, member, ws } = await connected(['mention'])
    const page = await h.makeDocPage(ws.id, owner.id, 'Backoff', blocks('x'))
    const pending = async () =>
      (await db.execute(sql`
        SELECT attempts, state, last_error, extract(epoch from available_at - now())::float8 AS wait
          FROM outbox WHERE topic = 'slack' AND workspace_id = ${ws.id} ORDER BY id DESC LIMIT 1`)) as unknown as { attempts: number; state: string; last_error: string; wait: number }[]

    slack.next('chat.postMessage', { status: 503, json: { ok: false } })
    notify({ workspaceId: ws.id, pageId: page.id, actorId: owner.id, via: null, recipients: [{ userId: member.id, kind: 'doc_mention', reason: 'direct' }] })
    await settle()
    let [r] = await pending()
    assert.equal(r.state, 'pending')
    assert.equal(r.attempts, 1)
    assert.equal(r.last_error, 'HTTP 503')
    assert.ok(r.wait > 3 && r.wait < 7, `backoff ~5 s, got ${r.wait}`)
    await db.execute(sql`UPDATE outbox SET available_at = now() WHERE topic = 'slack' AND workspace_id = ${ws.id} AND state = 'pending'`)
    slack.next('chat.postMessage', { status: 429, headers: { 'retry-after': '42' }, json: { ok: false, error: 'ratelimited' } })
    await flushSlack()
    ;[r] = await pending()
    assert.equal(r.attempts, 2)
    assert.ok(r.wait > 38 && r.wait < 45, `Retry-After honoured, got ${r.wait}`)
    await db.execute(sql`UPDATE outbox SET available_at = now() WHERE topic = 'slack' AND workspace_id = ${ws.id} AND state = 'pending'`)
    await flushSlack()
    ;[r] = await pending()
    assert.equal(r.state, 'done')

    // the bot was removed from the channel: dead, paused, nothing more is queued
    slack.next('chat.postMessage', { json: { ok: false, error: 'not_in_channel' } })
    notify({ workspaceId: ws.id, pageId: page.id, actorId: member.id, via: null, recipients: [{ userId: owner.id, kind: 'doc_mention', reason: 'direct' }] })
    await settle()
    ;[r] = await pending()
    assert.equal(r.state, 'dead')
    const [row] = await db.select().from(schema.slackIntegrations).where(eq(schema.slackIntegrations.workspaceId, ws.id))
    assert.equal(row.blockedReason, 'not_in_channel')
    const dto = (await req(owner, 'GET', `/workspaces/${ws.id}/slack`)).json().integration
    assert.equal(dto.blockedReason, 'not_in_channel')
    const queued = async () => Number(((await db.execute(sql`SELECT count(*)::int AS n FROM outbox WHERE topic = 'slack' AND workspace_id = ${ws.id}`)) as unknown as { n: number }[])[0].n)
    const q0 = await queued()
    notify({ workspaceId: ws.id, pageId: page.id, actorId: owner.id, via: null, recipients: [{ userId: member.id, kind: 'comment_mention', reason: 'direct' }], anchor: 'later' })
    await settle()
    assert.equal(await queued(), q0, 'paused: nothing queued')
    // the admin invited the bot again; a passing test resumes
    const test = await req(owner, 'POST', `/workspaces/${ws.id}/slack/test`)
    assert.deepEqual(test.json(), { ok: true, error: null })
    const [row2] = await db.select().from(schema.slackIntegrations).where(eq(schema.slackIntegrations.workspaceId, ws.id))
    assert.equal(row2.blockedReason, null)
  })

  it('/inkling: signature, timestamp, team and replay checks', async () => {
    const { ws } = await connected()
    const body = new URLSearchParams({ team_id: TEAM, user_id: 'U0NOBODY', text: 'help' }).toString()
    assert.equal((await app.inject(signed(`${ws.id}/commands`, body, 'form', { secret: 'f'.repeat(32) }))).statusCode, 401, 'wrong secret')
    assert.equal((await app.inject(signed(`${ws.id}/commands`, body, 'form', { ts: Math.floor(Date.now() / 1000) - 301 }))).statusCode, 401, 'older than 5 minutes')
    const noSig = signed(`${ws.id}/commands`, body, 'form')
    delete (noSig.headers as Record<string, string>)['x-slack-signature']
    assert.equal((await app.inject(noSig)).statusCode, 401, 'unsigned')
    const tampered = signed(`${ws.id}/commands`, body, 'form')
    tampered.payload = body.replace('help', 'link')
    assert.equal((await app.inject(tampered)).statusCode, 401, 'body changed after signing')
    const otherTeam = new URLSearchParams({ team_id: 'T0OTHER', user_id: 'U0NOBODY', text: 'help' }).toString()
    assert.equal((await app.inject(signed(`${ws.id}/commands`, otherTeam, 'form'))).statusCode, 401, 'another Slack team')
    assert.equal((await app.inject(signed('11111111-1111-4111-8111-111111111111/commands', body, 'form'))).statusCode, 401, 'workspace without Slack')
    // Slack's periodic certificate check: signed, no team
    const ssl = new URLSearchParams({ ssl_check: '1', token: 'x' }).toString()
    assert.equal((await app.inject(signed(`${ws.id}/commands`, ssl, 'form'))).statusCode, 200)
    assert.equal((await app.inject(signed(`${ws.id}/commands`, ssl, 'form', { secret: 'e'.repeat(32), ts: Math.floor(Date.now() / 1000) + 1 }))).statusCode, 401)
    const once = signed(`${ws.id}/commands`, body, 'form')
    assert.equal((await app.inject(once)).statusCode, 200)
    assert.equal((await app.inject(once)).statusCode, 401, 'replayed request')
  })

  it('/inkling: unlinked people get only instructions; email match and one-time link give their own results', async () => {
    const { owner, member, other, ws } = await connected()
    const sharedPage = await h.makeDocPage(ws.id, owner.id, 'Deploy checklist', blocks('zebrafish rollout steps for the deploy'))
    const ownerPrivate = await h.makeDocPage(ws.id, owner.id, 'Owner diary', blocks('zebrafish owner private note'), { scope: 'private' })
    const memberPrivate = await h.makeDocPage(ws.id, member.id, 'Member notes', blocks('zebrafish member private note'), { scope: 'private' })
    await reindexPageChunks(sharedPage.id, blocks('zebrafish rollout steps for the deploy'), { log: false })
    await reindexPageChunks(ownerPrivate.id, blocks('zebrafish owner private note'), { log: false })
    await reindexPageChunks(memberPrivate.id, blocks('zebrafish member private note'), { log: false })

    // no link, no email match: instructions and nothing else
    const r1 = await app.inject(command(ws.id, 'U0STRANGER', 'zebrafish'))
    assert.equal(r1.statusCode, 200)
    assert.equal(r1.json().response_type, 'ephemeral')
    assert.match(r1.json().text, /not linked/)
    assert.ok(!r1.body.includes('Deploy checklist') && !r1.body.includes('zebrafish'))

    // the Slack email equals the member's Inkling email → linked by email, results as the member
    slack.emails.set('U0MEMBER', member.email.toUpperCase())
    const r2 = await app.inject(command(ws.id, 'U0MEMBER', 'zebrafish'))
    const text2 = r2.json().text as string
    assert.equal(typeof text2, 'string', r2.body)
    assert.equal(r2.json().response_type, 'ephemeral')
    assert.ok(text2.includes('Deploy checklist'), text2)
    assert.ok(text2.includes('Member notes'), 'their own private page')
    assert.ok(!text2.includes('Owner diary'), "someone else's private page never shown")
    const [link] = await db.select().from(schema.slackUserLinks).where(and(eq(schema.slackUserLinks.workspaceId, ws.id), eq(schema.slackUserLinks.slackUserId, 'U0MEMBER')))
    assert.equal(link.userId, member.id)
    assert.equal(link.method, 'email')

    // explicit link: /inkling link → code in the fragment → preview + confirm while signed in
    const r3 = await app.inject(command(ws.id, 'U0OTHERSLACK', 'link'))
    const m = /\/slack\/link#code=([A-Za-z0-9_-]+)/.exec(r3.json().text)
    assert.ok(m, r3.body)
    const code = m![1]
    const [stored] = await db.select().from(schema.slackLinkCodes).where(eq(schema.slackLinkCodes.slackUserId, 'U0OTHERSLACK'))
    assert.notEqual(stored.codeHash, code, 'only the hash is stored')
    const outsider = await h.makeUser('outsider')
    assert.equal((await req(outsider, 'POST', '/slack/link/preview', { code })).statusCode, 403, 'not a member')
    const prev = await req(other, 'POST', '/slack/link/preview', { code })
    assert.equal(prev.statusCode, 200)
    assert.equal(prev.json().slackUserId, 'U0OTHERSLACK')
    assert.equal((await req(other, 'POST', '/slack/link/confirm', { code })).statusCode, 200)
    assert.equal((await req(other, 'POST', '/slack/link/confirm', { code })).statusCode, 404, 'single use')
    const r4 = await app.inject(command(ws.id, 'U0OTHERSLACK', 'zebrafish'))
    assert.ok((r4.json().text as string).includes('Deploy checklist'))
    assert.ok(!(r4.json().text as string).includes('Member notes'))

    // the admin sees both links; unlink from Slack removes one
    const links = (await req(owner, 'GET', `/workspaces/${ws.id}/slack/links`)).json().links as { userId: string; method: string }[]
    assert.deepEqual(links.map((l) => l.method).sort(), ['email', 'link'])
    const r5 = await app.inject(command(ws.id, 'U0OTHERSLACK', 'unlink'))
    assert.match(r5.json().text, /no longer linked/)
    // a linked person who left the workspace gets no results
    await db.delete(schema.workspaceMembers).where(and(eq(schema.workspaceMembers.workspaceId, ws.id), eq(schema.workspaceMembers.userId, member.id)))
    const r6 = await app.inject(command(ws.id, 'U0MEMBER', 'zebrafish'))
    assert.ok(!(r6.json().text as string).includes('Deploy checklist'))
    assert.match(r6.json().text, /not a member/)
  })

  it('events: url_verification, link unfurls for shared pages only, event retries handled once', async () => {
    const { owner, ws } = await connected()
    const other = await connected()
    const shared = await h.makeDocPage(ws.id, owner.id, 'Runbook', blocks('Restart the workers before you rotate the keys every month.'))
    await reindexPageText(shared.id, blocks('Restart the workers before you rotate the keys every month.'))
    const priv = await h.makeDocPage(ws.id, owner.id, 'Hidden PRIVATE-UNFURL', blocks('PRIVATE-PARAGRAPH'), { scope: 'private' })
    await reindexPageText(priv.id, blocks('PRIVATE-PARAGRAPH'))
    const foreign = await h.makeDocPage(other.ws.id, other.owner.id, 'Foreign FOREIGN-TITLE', blocks('x'))

    const v = await app.inject(signed(`${ws.id}/events`, JSON.stringify({ type: 'url_verification', challenge: 'abc123', token: 'x' }), 'json'))
    assert.deepEqual(v.json(), { challenge: 'abc123' }, v.body)
    assert.equal((await app.inject(signed(`${ws.id}/events`, JSON.stringify({ type: 'url_verification', challenge: 'abc' }), 'json', { secret: '0'.repeat(32) }))).statusCode, 401)
    // before the app is connected (creating it from the manifest verifies the URL first): plain echo
    const fresh = await team()
    const pre = await app.inject({ method: 'POST', url: `/api/slack/w/${fresh.ws.id}/events`, payload: JSON.stringify({ type: 'url_verification', challenge: 'first' }), headers: { 'content-type': 'application/json' } })
    assert.deepEqual(pre.json(), { challenge: 'first' })
    assert.equal(
      (await app.inject({ method: 'POST', url: '/api/slack/w/11111111-1111-4111-8111-111111111111/events', payload: JSON.stringify({ type: 'url_verification', challenge: 'x' }), headers: { 'content-type': 'application/json' } })).statusCode,
      401,
      'unknown workspace',
    )
    // unsigned events of a workspace without an app do nothing
    const unsigned = await app.inject({ method: 'POST', url: `/api/slack/w/${fresh.ws.id}/events`, payload: JSON.stringify({ type: 'event_callback', team_id: TEAM, event: { type: 'link_shared' } }), headers: { 'content-type': 'application/json' } })
    assert.equal(unsigned.statusCode, 401)

    const url = (wsId: string, id: string) => `https://notes.example.com/w/${wsId}/p/${id}`
    const event = (eventId: string) =>
      JSON.stringify({
        type: 'event_callback',
        team_id: TEAM,
        event_id: eventId,
        event: { type: 'link_shared', channel: 'C0ANY', message_ts: '1700000000.000100', links: [{ url: url(ws.id, shared.id) }, { url: url(ws.id, priv.id) }, { url: url(other.ws.id, foreign.id) }] },
      })
    const before = slack.of('chat.unfurl').length
    assert.equal((await app.inject(signed(`${ws.id}/events`, event('Ev1'), 'json'))).statusCode, 200)
    // Slack's retry of the same event (re-signed with a new timestamp): accepted, not handled twice
    assert.equal((await app.inject(signed(`${ws.id}/events`, event('Ev1'), 'json', { ts: Math.floor(Date.now() / 1000) + 1 }))).statusCode, 200)
    await flushSlack()
    const calls = slack.of('chat.unfurl').slice(before)
    assert.equal(calls.length, 1)
    const unfurls = JSON.parse(calls[0].params.unfurls) as Record<string, { blocks: { text: { text: string } }[] }>
    assert.deepEqual(Object.keys(unfurls), [url(ws.id, shared.id)])
    assert.match(unfurls[url(ws.id, shared.id)].blocks[0].text.text, /Runbook[\s\S]*Restart the workers/)
    assert.equal(calls[0].params.channel, 'C0ANY')
    assert.equal(calls[0].params.ts, '1700000000.000100')
    const all = JSON.stringify(calls)
    assert.ok(!all.includes('PRIVATE') && !all.includes('FOREIGN'))

    // only private links: nothing is called at all
    const n = slack.of('chat.unfurl').length
    await app.inject(
      signed(`${ws.id}/events`, JSON.stringify({ type: 'event_callback', team_id: TEAM, event_id: 'Ev2', event: { type: 'link_shared', channel: 'C0ANY', message_ts: '1.2', links: [{ url: url(ws.id, priv.id) }] } }), 'json'),
    )
    await flushSlack()
    assert.equal(slack.of('chat.unfurl').length, n)
  })

  it('daily change summary names shared pages only, once a day', async () => {
    const { owner, ws } = await connected(['digest'])
    const shared = await h.makeDocPage(ws.id, owner.id, 'Weekly plan', blocks('x'))
    const priv = await h.makeDocPage(ws.id, owner.id, 'DIGEST-PRIVATE', blocks('x'), { scope: 'private' })
    for (const p of [{ id: shared.id, scope: 'shared' }, { id: priv.id, scope: 'private' }]) {
      await db.execute(sql`
        INSERT INTO page_changes (workspace_id, page_id, kind, scope, owner_id, heading_path)
        VALUES (${ws.id}, ${p.id}, 'section_changed', ${p.scope}, ${owner.id}, '')`)
    }
    const before = posts().length
    // a minute ahead: the database container's clock may run slightly ahead of this process
    const at = new Date(Date.now() + 60_000)
    assert.equal(await runSlackDigests(at, { workspaceIds: [ws.id] }), 1)
    assert.equal(await runSlackDigests(at, { workspaceIds: [ws.id] }), 0, 'once a day')
    await flushSlack()
    const mine = posts().slice(before)
    assert.equal(mine.length, 1)
    assert.match(mine[0].params.text, /1 shared page changed/)
    assert.ok(mine[0].params.text.includes('Weekly plan'))
    assert.ok(!mine[0].params.text.includes('DIGEST-PRIVATE'))
  })

  it('no log line or stored outbox payload ever contains the token or the signing secret', async () => {
    invalidateSlackCache('x')
    const outbox = JSON.stringify(await db.execute(sql`SELECT payload, last_error FROM outbox WHERE topic = 'slack'`))
    for (const s of [outbox, logs.join('\n')]) {
      assert.ok(!s.includes(TOKEN) && !s.includes(TOKEN.slice(5)), 'token leaked')
      assert.ok(!s.includes(SIGNING), 'signing secret leaked')
    }
    assert.ok(logs.length > 0, 'the log capture saw the requests')
  })
})
