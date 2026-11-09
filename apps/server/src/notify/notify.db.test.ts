// Notification bundle against a real database (docs/adr/1000-* .. 1007-*): body mentions (person vs
// agent), visibility, subscription levels and the mute exception, comments and assignments, mail
// (captured by a fake SMTP server started here), webhooks (local receiver), the agent inbox and
// ack, comment tools, the activity screen's permission filter, create_page provenance and the
// per-workspace client-name rule.
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.APP_URL ||= 'https://notes.example.com'
process.env.DATA_DIR ||= `${process.env.TMPDIR || '/tmp'}/inkling-notify-${process.pid}`
// Instant mail timers must not fire during the test: it calls the senders itself.
process.env.NOTIFY_MAIL_DELAY_MS = '3600000'

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createServer as createTcpServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { after, describe, it } from 'node:test'

const HAS_DB = !!process.env.DATABASE_URL

/** Minimal SMTP sink: accepts everything, keeps each message's raw DATA. No STARTTLS offered. */
function fakeSmtp() {
  const mails: string[] = []
  const server = createTcpServer((sock) => {
    sock.write('220 localhost ESMTP test\r\n')
    let data = false
    let buf = ''
    sock.on('error', () => {})
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8')
      for (;;) {
        if (data) {
          const end = buf.indexOf('\r\n.\r\n')
          if (end < 0) return
          mails.push(buf.slice(0, end))
          buf = buf.slice(end + 5)
          data = false
          sock.write('250 OK queued\r\n')
          continue
        }
        const nl = buf.indexOf('\r\n')
        if (nl < 0) return
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 2)
        const cmd = line.slice(0, 4).toUpperCase()
        if (cmd === 'EHLO' || cmd === 'HELO') sock.write('250 localhost\r\n')
        else if (cmd === 'DATA') {
          data = true
          sock.write('354 go ahead\r\n')
        } else if (cmd === 'QUIT') {
          sock.write('221 bye\r\n')
          sock.end()
        } else sock.write('250 OK\r\n')
      }
    })
  })
  return { mails, server }
}

/** Quoted-printable soft breaks and escapes, enough to search mail text. */
const qp = (s: string) =>
  s.replace(/=\r\n/g, '').replace(/=([0-9A-F]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)))

describe('[db] notifications, inbox, comment tools and activity', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const smtp = fakeSmtp()
  await new Promise<void>((r) => smtp.server.listen(0, '127.0.0.1', () => r()))
  process.env.SMTP_HOST = '127.0.0.1'
  process.env.SMTP_PORT = String((smtp.server.address() as AddressInfo).port)
  process.env.MAIL_FROM = 'Inkling <noreply@example.com>'
  process.env.WEBHOOK_TEST_ALLOW_LOOPBACK = '1'

  const hooks: string[] = []
  let hookWaiters: (() => void)[] = []
  const hookServer = createServer((req, res) => {
    let b = ''
    req.on('data', (c) => (b += c))
    req.on('end', () => {
      hooks.push(b)
      res.writeHead(200).end('ok')
      for (const w of hookWaiters) w()
      hookWaiters = []
    })
  })
  await new Promise<void>((r) => hookServer.listen(0, '127.0.0.1', () => r()))
  const waitHook = (match: RegExp) =>
    new Promise<string>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`no webhook matching ${match}; got ${hooks.join(' | ')}`)), 8000)
      const check = () => {
        const hit = hooks.find((x) => match.test(x))
        if (hit) {
          clearTimeout(t)
          resolve(hit)
        } else hookWaiters.push(check)
      }
      check()
    })

  const h = await import('../mcpTools/testHarness')
  const { db, closeDb } = await import('../db/index')
  const schema = await import('../db/schema')
  const { eq, and, sql } = await import('drizzle-orm')
  const collab = await import('../collab')
  const Y = await import('yjs')
  const { blocksToStateBuffer } = await import('../md/convert')
  const { scheduleDocIndex, flushDocIndexes } = await import('../docIndexer')
  const { noteLiveEdit, withEditActor } = await import('../context/attribution')
  const engine = await import('./engine')
  const mailer = await import('./mailer')
  const digest = await import('./digest')
  const { invalidateWebhookCache } = await import('../webhooks')
  const { memberNameClash, memberNameClashes } = await import('../clientName')
  const { _resetAgentTouches } = await import('../agentAccess')
  const { mailEnabled } = await import('../env')
  const app = await h.buildTestApp()

  after(async () => {
    mailer.clearMailTimers()
    await engine.flushNotifications()
    await collab.destroyCollab()
    await app.close()
    await closeDb()
    await new Promise<void>((r) => smtp.server.close(() => r()))
    await new Promise<void>((r) => hookServer.close(() => r()))
  })

  type U = Awaited<ReturnType<typeof h.makeUser>>
  const req = (u: U, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
    app.inject({ method, url: `/api${url}`, headers: { cookie: u.cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) })
  const para = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text, styles: {} }] })
  const heading = (text: string) => ({ type: 'heading', props: { level: 2 }, content: [{ type: 'text', text, styles: {} }] })
  const settle = async () => {
    await flushDocIndexes()
    await engine.flushNotifications()
  }
  const notifs = (u: { id: string }) =>
    db.select().from(schema.notifications).where(eq(schema.notifications.userId, u.id)).orderBy(schema.notifications.seq)

  /** Document state of `blocks` with person mention chips appended to paragraph number `at`. */
  function withChips(blocks: unknown[], at: number, people: { id: string; label: string }[]): Buffer {
    const doc = new Y.Doc()
    Y.applyUpdate(doc, blocksToStateBuffer(blocks as never))
    const paras: InstanceType<typeof Y.XmlElement>[] = []
    const walk = (n: InstanceType<typeof Y.XmlElement> | InstanceType<typeof Y.XmlFragment>) => {
      for (const c of n.toArray()) {
        if (c instanceof Y.XmlElement) {
          if (c.nodeName === 'paragraph') paras.push(c)
          walk(c)
        }
      }
    }
    walk(doc.getXmlFragment('document'))
    const p = paras[at]
    for (const person of people) {
      const m = new Y.XmlElement('mention')
      p.insert(p.length, [m])
      m.setAttribute('kind', 'user')
      m.setAttribute('id', person.id)
      m.setAttribute('label', person.label)
    }
    const out = Buffer.from(Y.encodeStateAsUpdate(doc))
    doc.destroy()
    return out
  }
  async function storeAndIndex(pageId: string, state: Buffer): Promise<void> {
    await db.update(schema.pageDocs).set({ state }).where(eq(schema.pageDocs.pageId, pageId))
    await scheduleDocIndex(pageId, state, true)
    await settle()
  }

  // Team: owner O, Alice, Bob, Carol; outsider X.
  const O = await h.makeUser('Owner')
  const A = await h.makeUser('Alice')
  const B = await h.makeUser('Bob')
  const C = await h.makeUser('Carol')
  const X = await h.makeUser('Xavier')
  const ws = await h.makeWorkspace(O, [A, B, C])
  const baseBlocks = [para('Intro text'), heading('Goals'), para('Please review ')]

  it('mail is configured for this suite (fake SMTP)', () => {
    assert.equal(mailEnabled, true)
  })

  describe('body mentions', () => {
    it('a person typing a mention chip notifies the person mentioned, right away', async () => {
      const P = await h.makeDocPage(ws.id, O.id, 'Plan', baseBlocks as never)
      await storeAndIndex(P.id, blocksToStateBuffer(baseBlocks as never))
      noteLiveEdit(P.id, A.id)
      await storeAndIndex(P.id, withChips(baseBlocks, 1, [{ id: B.id, label: 'Bob' }]))
      const [n] = await notifs(B)
      assert.equal(n.type, 'doc_mention')
      assert.equal(n.delivery, 'now')
      assert.equal(n.actorId, A.id)
      assert.equal(n.viaClient, null)
      assert.equal(n.anchor, 'goals')
      assert.match(n.excerpt ?? '', /Please review @Bob/)
      assert.equal(n.mailState, 'instant')
      assert.equal((await notifs(A)).length, 0, 'never the actor')
      // the same mention indexed again does not notify again
      await storeAndIndex(P.id, withChips(baseBlocks, 1, [{ id: B.id, label: 'Bob' }]))
      assert.equal((await notifs(B)).length, 1)
      assert.equal((await notifs(B))[0].count, 1)
    })

    it('a mention written through an agent connection is quiet and waits for the digest', async () => {
      const P = await h.makeDocPage(ws.id, O.id, 'Agent plan', baseBlocks as never)
      await storeAndIndex(P.id, blocksToStateBuffer(baseBlocks as never))
      await withEditActor([P.id], { userId: A.id, via: 'Claude' }, () =>
        storeAndIndex(P.id, withChips(baseBlocks, 1, [{ id: C.id, label: 'Carol' }])),
      )
      const [n] = (await notifs(C)).filter((x) => x.pageId === P.id)
      assert.equal(n.type, 'doc_mention')
      assert.equal(n.delivery, 'quiet')
      assert.equal(n.viaClient, 'Claude')
      assert.equal(n.mailState, 'digest')
      // quiet rows do not count as unread
      const list = (await req(C, 'GET', '/notifications')).json() as { unread: number; notifications: { quiet: boolean; via: string }[] }
      assert.ok(list.notifications.some((x) => x.quiet && x.via === 'Claude'))
      assert.equal(list.unread, (await notifs(C)).filter((x) => x.read === '0' && x.delivery === 'now').length)
    })

    it('plain "@Name" an agent writes through MCP is a quiet mention; a person\'s plain text is not', async () => {
      const Q = await h.makeDocPage(ws.id, O.id, 'Agent text', [para('start')] as never)
      const mcp = await h.connectMcp(app, { ...A, via: 'Test Agent' }, await h.mintToken(A))
      const r = await mcp.tool('update_page', { pageId: Q.id, markdown: '@Carol please check the totals', mode: 'append' })
      assert.equal(r.isError, false, r.text)
      await settle()
      const rows = (await notifs(C)).filter((x) => x.pageId === Q.id)
      assert.equal(rows.length, 1)
      assert.equal(rows[0].delivery, 'quiet')
      assert.equal(rows[0].viaClient, 'Test Agent')
      await mcp.close()
      // a person (browser) appending the same text: no notification (people use mention chips)
      const res = await req(O, 'POST', `/pages/${Q.id}/content`, { markdown: '@Bob plain text', mode: 'append' })
      assert.equal(res.statusCode, 200, res.body)
      await settle()
      assert.equal((await notifs(B)).filter((x) => x.pageId === Q.id).length, 0)
    })

    it('pages from before the upgrade (baseline unknown) do not replay old mentions', async () => {
      const P = await h.makeDocPage(ws.id, O.id, 'Old page', baseBlocks as never)
      await db.insert(schema.pageMentions).values({ pageId: P.id, userIds: null })
      await storeAndIndex(P.id, withChips(baseBlocks, 1, [{ id: C.id, label: 'Carol' }]))
      assert.equal((await notifs(C)).filter((x) => x.pageId === P.id).length, 0)
      const [row] = await db.select().from(schema.pageMentions).where(eq(schema.pageMentions.pageId, P.id))
      assert.deepEqual(row.userIds, [C.id])
    })

    it('nobody hears about a page they cannot see (private page, outsider)', async () => {
      const P = await h.makeDocPage(ws.id, O.id, 'Secret', baseBlocks as never, { scope: 'private' })
      await storeAndIndex(P.id, blocksToStateBuffer(baseBlocks as never))
      noteLiveEdit(P.id, O.id)
      await storeAndIndex(P.id, withChips(baseBlocks, 1, [{ id: B.id, label: 'Bob' }, { id: X.id, label: 'Xavier' }]))
      assert.equal((await notifs(B)).filter((x) => x.pageId === P.id).length, 0)
      assert.equal((await notifs(X)).length, 0)
    })
  })

  describe('subscriptions', () => {
    let F: string
    let R: string
    it('levels: all gets edits, a nearer mute wins, nothing keeps direct items quiet', async () => {
      F = (await req(O, 'POST', '/pages', { workspaceId: ws.id, title: 'Folder', kind: 'folder' })).json().page.id
      const r = await h.makeDocPage(ws.id, O.id, 'Report', [heading('Numbers'), para('one')] as never, { parentId: F })
      R = r.id
      await storeAndIndex(R, blocksToStateBuffer([heading('Numbers'), para('one')] as never))
      assert.equal((await req(B, 'PUT', `/pages/${F}/subscription`, { level: 'all', subtree: true })).statusCode, 200)
      assert.equal((await req(C, 'PUT', `/pages/${F}/subscription`, { level: 'all' })).statusCode, 200)
      const muted = (await req(C, 'PUT', `/pages/${R}/subscription`, { level: 'mute' })).json()
      assert.equal(muted.effective.level, 'mute')
      assert.equal(muted.effective.source, 'page')
      const inherited = (await req(B, 'GET', `/pages/${R}/subscription`)).json()
      assert.deepEqual(inherited.effective, { level: 'all', source: 'ancestor', fromPageId: F, fromTitle: 'Folder' })
      assert.equal((await req(A, 'PUT', `/workspaces/${ws.id}/notification-level`, { level: 'nothing' })).statusCode, 200)

      await req(O, 'POST', `/pages/${R}/content`, { markdown: 'two', mode: 'append' })
      await settle()
      await req(O, 'POST', `/pages/${R}/content`, { markdown: 'three', mode: 'append' })
      await settle()
      const b = (await notifs(B)).filter((x) => x.pageId === R)
      assert.equal(b.length, 1, 'collapsed per page while unread')
      assert.equal(b[0].type, 'page_update')
      assert.equal(b[0].count, 2)
      assert.equal(b[0].delivery, 'now')
      assert.equal((await notifs(C)).filter((x) => x.pageId === R).length, 0, 'mute on the page beats all on the folder')
      assert.equal((await notifs(A)).filter((x) => x.pageId === R).length, 0, 'activity needs level all')

      // direct items at "nothing" are kept quietly; at "mute" dropped
      const cm = await req(O, 'POST', `/pages/${R}/comments`, { blockId: 'b-numbers', body: 'hi @Alice @Carol', mentionUserIds: [A.id, C.id] })
      assert.equal(cm.statusCode, 200, cm.body)
      await settle()
      const a = (await notifs(A)).filter((x) => x.pageId === R)
      assert.equal(a.length, 1)
      assert.equal(a[0].type, 'comment_mention')
      assert.equal(a[0].delivery, 'quiet')
      assert.equal(a[0].mailState, null, 'level nothing never mails')
      assert.equal((await notifs(C)).filter((x) => x.pageId === R).length, 0)
    })

    it('an approval request addressed to you passes mute (reserved kind)', async () => {
      const res = await engine.processEvent({
        workspaceId: ws.id,
        pageId: R,
        actorId: O.id,
        via: null,
        recipients: [{ userId: C.id, kind: 'approval_request', reason: 'direct' }],
      })
      assert.deepEqual(res.delivered.get(C.id), { kind: 'approval_request', delivery: 'now' })
    })

    it('agent edits reach followers quietly', async () => {
      await req(B, 'POST', '/notifications/read', {})
      const mcp = await h.connectMcp(app, { ...O, via: 'Claude' }, await h.mintToken(O, 'notes', 'Claude'))
      assert.equal((await mcp.tool('update_page', { pageId: R, markdown: 'four', mode: 'append' })).isError, false)
      await mcp.close()
      await settle()
      const fresh = (await notifs(B)).filter((x) => x.pageId === R && x.read === '0')
      assert.equal(fresh.length, 1)
      assert.equal(fresh[0].delivery, 'quiet')
      assert.equal(fresh[0].viaClient, 'Claude')
    })

    it('settings list my subscriptions; level null inherits again', async () => {
      const s = (await req(C, 'GET', '/me/notification-settings')).json()
      assert.equal(s.mailAvailable, true)
      assert.equal(s.emailInstant, true)
      assert.equal(s.emailDigest, 'daily')
      assert.ok(s.subscriptions.some((x: { rootPageId: string; level: string }) => x.rootPageId === R && x.level === 'mute'))
      const back = (await req(C, 'PUT', `/pages/${R}/subscription`, { level: null })).json()
      assert.equal(back.own, null)
      assert.equal(back.effective.source, 'ancestor')
      // agents cannot change a person's notification settings
      const mcpTokenReq = await app.inject({ method: 'GET', url: '/api/me/notification-settings', headers: { authorization: 'Bearer nope' } })
      assert.notEqual(mcpTokenReq.statusCode, 200)
    })
  })

  describe('comments and assignments', () => {
    it('replies reach thread participants; the page creator hears about new threads', async () => {
      const P = await h.makeDocPage(ws.id, O.id, 'Thread page', baseBlocks as never)
      const doc = (await db.select({ s: schema.pageDocs.state }).from(schema.pageDocs).where(eq(schema.pageDocs.pageId, P.id)))[0]
      const { stateToBlocks } = await import('../md/convert')
      const first = stateToBlocks(doc.s)[0].id as string
      const root = (await req(B, 'POST', `/pages/${P.id}/comments`, { blockId: first, body: 'Is this right?' })).json().comment
      await req(A, 'POST', `/pages/${P.id}/comments`, { blockId: first, threadId: root.id, body: 'Yes, fixed it' })
      await settle()
      const toB = (await notifs(B)).filter((x) => x.pageId === P.id)
      assert.deepEqual(toB.map((x) => x.type), ['comment_reply'])
      assert.match(toB[0].excerpt ?? '', /Yes, fixed it/)
      const toO = (await notifs(O)).filter((x) => x.pageId === P.id)
      assert.deepEqual(toO.map((x) => x.type), ['comment'])
      assert.equal(toO[0].count, 2, 'both comments of the thread collapse into one item')
    })

    it('document owner and person-cell assignment notify the assignee and the channel', async () => {
      const port = (hookServer.address() as AddressInfo).port
      await db.insert(schema.workspaceWebhooks).values({ workspaceId: ws.id, kind: 'slack', url: `http://127.0.0.1:${port}/hook`, events: ['assigned', 'mention'] })
      invalidateWebhookCache(ws.id)
      const P = await h.makeDocPage(ws.id, O.id, 'Owned doc', baseBlocks as never)
      const own = await req(O, 'PUT', `/pages/${P.id}/owner`, { ownerId: C.id })
      assert.equal(own.statusCode, 200, own.body)
      await settle()
      assert.deepEqual((await notifs(C)).filter((x) => x.pageId === P.id).map((x) => x.type), ['page_owner'])
      const hook = await waitHook(/assigned Carol to \\"Owned doc\\"|assigned Carol to "Owned doc"/)
      assert.match(hook, /Owner assigned Carol/)

      const coll = (await req(O, 'POST', '/pages', { workspaceId: ws.id, title: 'Tasks', kind: 'collection' })).json().page.id
      const fields = (await req(O, 'GET', `/pages/${coll}/collection`)).json().collection?.fields ?? (await req(O, 'GET', `/pages/${coll}/collection`)).json().fields
      const person = (fields as { id: string; type: string }[]).find((f) => f.type === 'person')!
      const row = (await req(O, 'POST', '/pages', { workspaceId: ws.id, parentId: coll, title: 'Write intro' })).json().page.id
      const patch = await req(O, 'PATCH', `/pages/${row}/props`, { props: { [person.id]: B.id } })
      assert.equal(patch.statusCode, 200, patch.body)
      await settle()
      const t = (await notifs(B)).filter((x) => x.pageId === row)
      assert.deepEqual(t.map((x) => x.type), ['task_assigned'])
      // same person again: no new item
      await req(O, 'PATCH', `/pages/${row}/props`, { props: { [person.id]: B.id } })
      await settle()
      assert.equal((await notifs(B)).filter((x) => x.pageId === row).length, 1)
    })
  })

  describe('webhook digests', () => {
    it('the daily agent_digest webhook names shared pages agents changed, not private ones', async () => {
      const port = (hookServer.address() as AddressInfo).port
      await db.insert(schema.workspaceWebhooks).values({ workspaceId: ws.id, kind: 'slack', url: `http://127.0.0.1:${port}/ai`, events: ['agent_digest'] })
      invalidateWebhookCache(ws.id)
      const secret = await h.makeDocPage(ws.id, O.id, 'Private AI scratch', [para('x')] as never, { scope: 'private' })
      await storeAndIndex(secret.id, blocksToStateBuffer([para('x')] as never))
      const mcp = await h.connectMcp(app, { ...O, via: 'Claude' }, await h.mintToken(O, 'notes', 'Claude'))
      await mcp.tool('update_page', { pageId: secret.id, markdown: 'agent wrote here', mode: 'append' })
      await mcp.close()
      await settle()
      assert.ok((await digest.runAgentWebhookDigests(new Date(), { force: true })) >= 1)
      const msg = await waitHook(/AI connections edited/)
      assert.match(msg, /Report/)
      assert.doesNotMatch(msg, /Private AI scratch/)
    })

    it('a body mention of a non-member never names them in the channel', async () => {
      const P = await h.makeDocPage(ws.id, O.id, 'Hook mention', baseBlocks as never)
      await storeAndIndex(P.id, blocksToStateBuffer(baseBlocks as never))
      noteLiveEdit(P.id, O.id)
      await storeAndIndex(P.id, withChips(baseBlocks, 1, [{ id: X.id, label: 'Xavier' }, { id: A.id, label: 'Alice' }]))
      const msg = await waitHook(/mentioned .*Hook mention/)
      assert.match(msg, /mentioned Alice/)
      assert.doesNotMatch(msg, /Xavier/)
    })
  })

  describe('mail', () => {
    it('instant mail: one per person, title and a short excerpt, link from APP_URL; reading first cancels it', async () => {
      const before = smtp.mails.length
      assert.ok((await mailer.sendInstantMails(B.id)) >= 1)
      const mail = qp(smtp.mails[before])
      assert.match(mail, new RegExp(`To: ${B.email.replace('.', '\\.')}`))
      assert.match(mail, /Subject: \[Inkling\]/)
      assert.match(mail, /https:\/\/notes\.example\.com\/w\//)
      assert.doesNotMatch(mail, /Intro text/, 'no page body')
      assert.equal((await notifs(B)).filter((x) => x.mailState === 'instant').length, 0)
      // Carol's owner item: read in the app before the mail goes out → no mail
      await req(C, 'POST', '/notifications/read', {})
      const n = smtp.mails.length
      assert.equal(await mailer.sendInstantMails(C.id), 0)
      assert.equal(smtp.mails.length, n)
    })

    it('digest mail collects quiet and activity items, then marks them sent', async () => {
      const pendingC = (await notifs(C)).filter((x) => x.mailState === 'digest')
      assert.ok(pendingC.length >= 1, 'the agent mention waits for the digest')
      const before = smtp.mails.length
      assert.ok((await mailer.runMailDigests(new Date(), { force: true })) >= 1)
      const mails = smtp.mails.slice(before).map(qp)
      const toC = mails.find((m) => m.includes(`To: ${C.email}`))
      assert.ok(toC, 'Carol gets a digest')
      assert.match(toC!, /Daily summary/)
      assert.match(toC!, /via Claude/)
      assert.equal((await notifs(C)).filter((x) => x.mailState === 'digest').length, 0)
      // turning the digest off clears what waits for it
      await req(B, 'PATCH', '/me/notification-settings', { emailDigest: 'off' })
      assert.equal((await notifs(B)).filter((x) => x.mailState === 'digest').length, 0)
    })

    it('no mail about a workspace whose 2FA requirement blocks the recipient (docs/adr/1300-*)', async () => {
      const owner = await h.makeUser('mail-2fa-owner')
      const member = await h.makeUser('mail-2fa-member')
      const ws2 = await h.makeWorkspace(owner, [member])
      const page = await h.makeDocPage(ws2.id, owner.id, 'Blocked mail title', [para('x')])
      await db.execute(sql`UPDATE workspaces SET two_factor_required_at = now() - interval '1 day', two_factor_grace_days = 0 WHERE id = ${ws2.id}`)
      const base = { userId: member.id, pageId: page.id, workspaceId: ws2.id, actorId: owner.id }
      await db.insert(schema.notifications).values([
        { ...base, type: 'comment_mention', mailState: 'instant' },
        { ...base, type: 'comment', mailState: 'digest' },
        // a workspace-level item of the same workspace (no page)
        { userId: member.id, workspaceId: ws2.id, type: 'workspace_added', actorId: owner.id, mailState: 'digest' },
      ] as never)
      const before = smtp.mails.length
      assert.equal(await mailer.sendInstantMails(member.id), 0)
      await mailer.runMailDigests(new Date(), { force: true })
      const toMember = smtp.mails.slice(before).map(qp).filter((m) => m.includes(`To: ${member.email}`))
      assert.deepEqual(toMember, [])
      // dropped from mail, still in the app once 2FA is on
      const rows = await notifs(member)
      assert.equal(rows.length, 3)
      assert.deepEqual(rows.map((r) => r.mailState), [null, null, null])
    })

    it('AI summaries: a daily in-app item for subscribed folders', async () => {
      await req(C, 'PUT', `/pages/${(await db.select({ id: schema.pages.id }).from(schema.pages).where(and(eq(schema.pages.workspaceId, ws.id), eq(schema.pages.title, 'Folder'))))[0].id}/subscription`, { level: 'all', agentDigest: true })
      const made = await digest.runAgentSummaries(new Date(), { force: true })
      await engine.flushNotifications()
      assert.ok(made >= 1)
      const s = (await notifs(C)).filter((x) => x.type === 'agent_digest')
      assert.equal(s.length, 1)
      assert.match(s[0].excerpt ?? '', /Report/)
    })
  })

  describe('agent inbox', () => {
    it('lists direct items deterministically, respects the lock, and ack(cursor) consumes them', async () => {
      const token = await h.mintToken(B, 'notes', 'Inbox Agent')
      const mcp = await h.connectMcp(app, { ...B, via: 'Inbox Agent' }, token)
      const a = (await mcp.tool('inbox')).text
      assert.equal(a, (await mcp.tool('inbox')).text, 'same state, same bytes')
      assert.match(a, /^inbox: \d+ item\(s\)/)
      assert.match(a, /\| mention \(body\) \| page [0-9a-f-]+ "Plan" §goals \| Alice \|/)
      assert.match(a, /\| reply \|/)
      assert.match(a, /\| assigned \|/)
      assert.match(a, /<untrusted_content source="inbox"/)
      assert.doesNotMatch(a, /page_update/, 'followed-page edits are not inbox items')
      const cursor = /cursor: (\d+)$/.exec(a)![1]
      // kinds filter
      const onlyAssigned = (await mcp.tool('inbox', { kinds: ['assigned'] })).text
      assert.doesNotMatch(onlyAssigned, /\| mention/)
      // lock: agents may not edit or comment on "Plan" → can: read
      const plan = (await db.select({ id: schema.pages.id }).from(schema.pages).where(and(eq(schema.pages.workspaceId, ws.id), eq(schema.pages.title, 'Plan'))))[0].id
      await db.update(schema.pages).set({ editLocked: true }).where(eq(schema.pages.id, plan))
      await db.insert(schema.pageAccessOverrides).values({ pageId: plan, subject: 'agents', deny: 3 })
      assert.match((await mcp.tool('inbox')).text, /"Plan" §goals \| Alice \| can: read/)
      // nothing newer than the cursor yet
      assert.match((await mcp.tool('inbox', { cursor })).text, /^inbox: empty/)
      assert.match((await mcp.tool('ack', { cursor })).text, /Acknowledged \d+ item/)
      assert.match((await mcp.tool('inbox')).text, /^inbox: empty \(0 unacknowledged/)
      // the person's bell is untouched by the agent's ack
      assert.ok((await notifs(B)).some((x) => x.read === '0'))
      await mcp.close()
    })
  })

  describe('comment tools', () => {
    it('add (by section), list (section/status), reply, and resolve only own threads', async () => {
      const S = await h.makeDocPage(ws.id, O.id, 'Spec', [para('intro'), heading('Goals'), para('g'), heading('Risks'), para('r')] as never)
      await storeAndIndex(S.id, blocksToStateBuffer([para('intro'), heading('Goals'), para('g'), heading('Risks'), para('r')] as never))
      const mcp = await h.connectMcp(app, { ...A, via: 'Test Agent' }, await h.mintToken(A))
      const added = JSON.parse((await mcp.tool('add_comment', { pageId: S.id, section: 'Risks', text: 'Risk 2 is missing' })).text)
      assert.equal(added.section, 'risks')
      // legacy argument name still works
      const legacy = JSON.parse((await mcp.tool('add_comment', { pageId: S.id, body: 'old style' })).text)
      assert.ok(legacy.id)
      const bad = await mcp.tool('add_comment', { pageId: S.id, section: 'Nope', text: 'x' })
      assert.equal(bad.isError, true)
      assert.match(bad.text, /current sections: .*§risks/)
      const list = (await mcp.tool('list_comments', { pageId: S.id, section: 'risks' })).text
      assert.match(list, /· 1 thread\(s\) \(open, §risks\)/)
      assert.match(list, new RegExp(`t:${added.threadId} \\| §risks \\| open \\| Alice \\(via Test Agent\\) \\| 0 replies`))
      assert.match(list, /Risk 2 is missing/)
      // a person's thread
      const doc = (await db.select({ s: schema.pageDocs.state }).from(schema.pageDocs).where(eq(schema.pageDocs.pageId, S.id)))[0]
      const { stateToBlocks } = await import('../md/convert')
      const goalsBlock = stateToBlocks(doc.s)[1].id as string
      const bob = (await req(B, 'POST', `/pages/${S.id}/comments`, { blockId: goalsBlock, body: 'Goals unclear' })).json().comment
      assert.match((await mcp.tool('reply_comment', { threadId: bob.id, text: 'Clarified goal 1' })).text, /"threadId"/)
      const refused = await mcp.tool('resolve_comment', { threadId: bob.id })
      assert.equal(refused.isError, true)
      assert.match(refused.text, /AGENT_RESOLVE_NOT_ALLOWED/)
      assert.equal((await mcp.tool('resolve_comment', { threadId: added.threadId })).isError, false)
      const all = (await mcp.tool('list_comments', { pageId: S.id, status: 'all' })).text
      assert.match(all, /§risks \| resolved/)
      assert.match(all, /§goals \| open \| Bob \| 1 reply/)
      assert.match((await mcp.tool('list_comments', { pageId: S.id, status: 'resolved' })).text, /· 1 thread\(s\)/)
      await mcp.close()
      await settle()
      // the agent's reply reached Bob (replies are answers, not broadcasts)
      const reply = (await notifs(B)).find((x) => x.pageId === S.id && x.type === 'comment_reply')
      assert.equal(reply?.delivery, 'now')
      assert.equal(reply?.viaClient, 'Test Agent')
    })
  })

  describe('activity and provenance', () => {
    it('create_page through MCP records via; the badge and the AI filters see it', async () => {
      const mcp = await h.connectMcp(app, { ...A, via: 'Claude' }, await h.mintToken(A, 'notes', 'Claude'))
      const created = JSON.parse((await mcp.tool('create_page', { workspaceId: ws.id, title: 'AI notes', markdown: '# Hello\n\ntext' })).text)
      await mcp.close()
      await settle()
      const [p] = await db.select({ v: schema.pages.createdVia }).from(schema.pages).where(eq(schema.pages.id, created.id))
      assert.equal(p.v, 'Claude')
      const [added] = await db
        .select({ via: schema.pageChanges.viaClient, actor: schema.pageChanges.actorId })
        .from(schema.pageChanges)
        .where(and(eq(schema.pageChanges.pageId, created.id), eq(schema.pageChanges.kind, 'page_added')))
      assert.equal(added.via, 'Claude')
      assert.equal(added.actor, A.id)
      const prov = (await req(B, 'GET', `/pages/${created.id}/provenance`)).json()
      assert.equal(prov.createdVia, 'Claude')
      assert.equal(prov.lastAgentEdit.via, 'Claude')
      const aiOnly = (await req(B, 'GET', `/workspaces/${ws.id}/activity?aiPagesOnly=1`)).json()
      assert.ok(aiOnly.items.length >= 1)
      assert.ok(aiOnly.items.every((i: { pageCreatedVia: string | null }) => i.pageCreatedVia !== null))
      assert.ok(aiOnly.clients.includes('Claude'))
    })

    it('filters by actor and hides other people\'s private pages; diffs need visibility', async () => {
      const priv = await h.makeDocPage(ws.id, O.id, 'Owner diary', [para('a')] as never, { scope: 'private' })
      await storeAndIndex(priv.id, blocksToStateBuffer([para('a')] as never))
      await req(O, 'POST', `/pages/${priv.id}/content`, { markdown: 'secret line', mode: 'append' })
      await settle()
      const forO = (await req(O, 'GET', `/workspaces/${ws.id}/activity`)).json()
      const privRow = forO.items.find((i: { pageId: string; kind: string }) => i.pageId === priv.id && i.kind !== 'page_added')
      assert.ok(privRow, 'the owner sees their private edits')
      const forB = (await req(B, 'GET', `/workspaces/${ws.id}/activity?limit=100`)).json()
      assert.ok(!forB.items.some((i: { pageId: string }) => i.pageId === priv.id))
      assert.equal((await req(B, 'GET', `/changes/${privRow.seq}/diff`)).statusCode, 404)
      const d = (await req(O, 'GET', `/changes/${privRow.seq}/diff`)).json()
      assert.ok(d.ops.some((o: { t: string; s: string }) => o.t === '+' && /secret line/.test(o.s)))
      const ai = (await req(B, 'GET', `/workspaces/${ws.id}/activity?actor=ai&limit=100`)).json()
      assert.ok(ai.items.length > 0 && ai.items.every((i: { via: string | null }) => i.via !== null))
      const people = (await req(B, 'GET', `/workspaces/${ws.id}/activity?actor=human&kind=edit&limit=100`)).json()
      assert.ok(people.items.every((i: { via: string | null; kind: string }) => i.via === null && !i.kind.startsWith('page_')))
      // paging
      const p1 = (await req(B, 'GET', `/workspaces/${ws.id}/activity?limit=2`)).json()
      const p2 = (await req(B, 'GET', `/workspaces/${ws.id}/activity?limit=2&before=${p1.next}`)).json()
      assert.ok(BigInt(p2.items[0].seq) < BigInt(p1.items[1].seq))
      // outsiders get nothing
      assert.equal((await req(X, 'GET', `/workspaces/${ws.id}/activity`)).statusCode, 403)
    })

    it('history diff compares a snapshot with the current document', async () => {
      const P = await h.makeDocPage(ws.id, O.id, 'Versioned', [para('first line')] as never)
      await req(O, 'POST', `/pages/${P.id}/snapshots`, { label: 'v1' })
      const sid = (await req(O, 'GET', `/pages/${P.id}/snapshots`)).json().snapshots[0].id
      await req(O, 'POST', `/pages/${P.id}/content`, { markdown: 'second line', mode: 'append' })
      await settle()
      const d = (await req(O, 'GET', `/pages/${P.id}/snapshots/${sid}/diff`)).json()
      assert.equal(d.to.id, 'current')
      assert.ok(d.ops.some((o: { t: string; s: string }) => o.t === '+' && /second line/.test(o.s)))
    })
  })

  describe('client names', () => {
    it('member names match exactly; a clash is refused only in that workspace, common app names pass', async () => {
      assert.equal(await memberNameClash('carol', A.id), 'Carol')
      assert.equal(await memberNameClash('C4rol', A.id), null, 'no look-alike folding for member names')
      const clash = await memberNameClashes('Carol', A.id)
      assert.deepEqual(clash?.workspaces.map((w) => w.id), [ws.id])
      const ws2 = await h.makeWorkspace(A, [], 'Solo')
      _resetAgentTouches()
      const mcp = await h.connectMcp(app, { ...A, via: 'Carol' }, await h.mintToken(A, 'notes', 'Carol'))
      const here = await mcp.tool('list_pages', { workspaceId: ws.id })
      assert.equal(here.isError, true)
      assert.match(here.text, /CLIENT_NAME_CLASH/)
      assert.equal((await mcp.tool('list_pages', { workspaceId: ws2.id })).isError, false)
      await mcp.close()
      // a member called "Claude" does not lock the Claude app out
      await db.update(schema.users).set({ name: 'Claude' }).where(eq(schema.users.id, C.id))
      const claude = await h.connectMcp(app, { ...A, via: 'Claude' }, await h.mintToken(A, 'notes', 'Claude'))
      assert.equal((await claude.tool('list_pages', { workspaceId: ws.id })).isError, false)
      await claude.close()
      await db.update(schema.users).set({ name: 'Carol' }).where(eq(schema.users.id, C.id))
      void sql
    })
  })
})
