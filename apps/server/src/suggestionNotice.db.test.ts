// The suggestions notice (docs/adr/2557-*) against the real server and real collab clients: every
// change of a page's section claims or suggestions (claim, release, the expired-claim sweep, a
// suggestion made, accepted, accepted in part, rejected, withdrawn) sends exactly {"t":"suggestions"}
// on the page's collab document, with no suggestion text, section, connection or user name in it.
// A non-member's provider is refused at onAuthenticate (collab.ts) and receives nothing.
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
// run-tests: db-exclusive
// (exclusive because the sweep deletes every expired claim, other files' back-dated ones too)
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.APP_URL ||= 'https://notes.example.com'

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { after, before, describe, it } from 'node:test'

const HAS_DB = !!process.env.DATABASE_URL

// The browser's provider, loaded by path (it resolves `yjs` to the same store path as the server).
const webDir = path.resolve(process.cwd(), '../web')
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadProvider(): Promise<any> {
  const req = createRequire(path.join(webDir, 'package.json'))
  const main = req.resolve('@hocuspocus/provider')
  return import(pathToFileURL(path.join(path.dirname(main), 'hocuspocus-provider.esm.js')).href)
}

describe('[db] suggestions notice on the page collab document', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const h = await import('./mcpTools/testHarness')
  const { db, closeDb } = await import('./db/index')
  const { sql } = await import('drizzle-orm')
  const collab = await import('./collab')
  const Y = await import('yjs')
  const { WebSocket } = await import('ws')
  const { reindexPageChunks } = await import('./context/chunkIndex')
  const { drainChangeLog } = await import('./context/changeLog')
  const { sweepExpiredLeases } = await import('./leases')
  const { SUGGESTIONS_NOTICE } = await import('./suggestionNotice')
  const { HocuspocusProvider, HocuspocusProviderWebsocket } = await loadProvider()
  const app = await h.buildTestApp()

  type U = Awaited<ReturnType<typeof h.makeUser>>
  const req = (u: U, method: 'GET' | 'POST', url: string, payload?: unknown) =>
    app.inject({ method, url: `/api${url}`, headers: { cookie: u.cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) })
  const para = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text, styles: {} }] })
  const heading = (text: string) => ({ type: 'heading', props: { level: 2 }, content: [{ type: 'text', text, styles: {} }] })
  const suggestionId = (t: string) => {
    const m = /suggestion ([0-9a-f-]{36})/.exec(t)
    assert.ok(m, t)
    return m[1]
  }

  // Words that must never travel in a notice: the agent's connection name, the headings, the text.
  const SECRET_NAME = 'Zebra Claimer'
  const SECRET_HEADING = 'Quokka Budget'
  const SECRET_TEXT = 'pelican payroll figures'

  let alice: U, bob: U, carol: U
  let wsId: string
  let B: Awaited<ReturnType<typeof h.connectMcp>> // bob's agent
  let port = 0
  let server: ReturnType<typeof createServer>
  const tabs: { close: () => void }[] = []

  before(async () => {
    alice = await h.makeUser('Alice')
    bob = await h.makeUser('Bob')
    carol = await h.makeUser('Carol')
    wsId = (await h.makeWorkspace(alice, [bob])).id
    B = await h.connectMcp(app, bob, await h.mintToken(bob, 'notes', SECRET_NAME))
    server = createServer((_r, s) => s.end())
    collab.attachCollab(server)
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    port = (server.address() as AddressInfo).port
  })
  after(async () => {
    for (const t of tabs) t.close()
    await B.close()
    await new Promise<void>((r) => server.close(() => r()))
    await collab.destroyCollab()
    await app.close()
    await closeDb()
  })

  async function newPage(title: string) {
    const blocks = [heading(SECRET_HEADING), para('rent 100'), heading('Timeline'), para('q1'), para('keep'), para('q3')]
    const pg = await h.makeDocPage(wsId, alice.id, title, blocks as never)
    await reindexPageChunks(pg.id, blocks as never)
    await drainChangeLog()
    return pg.id
  }

  async function until(cond: () => boolean, what: string, ms = 5000) {
    const end = Date.now() + ms
    while (!cond()) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
      await new Promise((r) => setTimeout(r, 20))
    }
  }

  /** A browser tab with the page open: every stateless payload it receives, raw. */
  async function openTab(u: U, pageId: string, expectSync = true) {
    class CookieSocket extends WebSocket {
      constructor(url: string, protocols?: string | string[]) {
        super(url, protocols, { headers: { cookie: u.cookie } })
      }
    }
    const tab = {
      payloads: [] as string[],
      synced: false,
      authFailed: false,
      notices: () => tab.payloads.filter((p) => JSON.parse(p)?.t === 'suggestions').length,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      socket: null as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      provider: null as any,
      close() {
        tab.provider?.destroy()
        tab.socket?.destroy()
      },
    }
    tab.socket = new HocuspocusProviderWebsocket({ url: `ws://127.0.0.1:${port}/collab`, WebSocketPolyfill: CookieSocket, delay: 50, minDelay: 50, maxDelay: 200 })
    tab.provider = new HocuspocusProvider({
      websocketProvider: tab.socket,
      name: pageId,
      document: new Y.Doc(),
      token: 'cookie',
      broadcast: false,
      onStateless: ({ payload }: { payload: string }) => void tab.payloads.push(payload),
      onSynced: () => {
        tab.synced = true
      },
      onAuthenticationFailed: () => {
        tab.authFailed = true
      },
    })
    tabs.push(tab)
    if (expectSync) await until(() => tab.synced, 'the tab to sync')
    return tab
  }

  /** Runs `act` and waits for one more notice on every tab in `on`. */
  async function expectNotice(on: Awaited<ReturnType<typeof openTab>>[], what: string, act: () => Promise<unknown>) {
    const before = on.map((t) => t.notices())
    await act()
    await until(() => on.every((t, k) => t.notices() > before[k]), `a notice after ${what}`)
  }

  function assertContentless(payloads: string[]) {
    const notices = payloads.filter((p) => JSON.parse(p)?.t === 'suggestions')
    assert.ok(notices.length > 0)
    for (const p of notices) {
      assert.equal(p, JSON.stringify(SUGGESTIONS_NOTICE))
      assert.equal(p, '{"t":"suggestions"}')
    }
    // nothing the page holds or the agent is called travels in any stateless payload
    const all = payloads.join('\n').toLowerCase()
    for (const w of [SECRET_NAME, SECRET_HEADING, 'quokka-budget', SECRET_TEXT, 'Bob', 'Alice', 'Timeline']) {
      assert.equal(all.includes(w.toLowerCase()), false, `"${w}" in ${all}`)
    }
  }

  it('claim, release and the expired-claim sweep notify the open tabs; a non-member gets nothing', async () => {
    const P = await newPage('Claims page')
    const a1 = await openTab(alice, P)
    const a2 = await openTab(bob, P) // a second viewer (a member)
    const outsider = await openTab(carol, P, false)
    await until(() => outsider.authFailed, 'the non-member to be refused')

    await expectNotice([a1, a2], 'claim_section', async () => {
      const r = await B.tool('claim_section', { pageId: P, section: SECRET_HEADING, minutes: 10 })
      assert.equal(r.isError, false, r.text)
    })
    // what the notice makes the browser read: the claim is there
    assert.equal((await req(alice, 'GET', `/pages/${P}/suggestions?preview=1`)).json().claims.length, 1)
    await expectNotice([a1, a2], 'release_section', async () => {
      assert.equal((await B.tool('release_section', { pageId: P, section: SECRET_HEADING })).isError, false)
    })
    // releasing nothing changes nothing: no notice
    const n = a1.notices()
    await B.tool('release_section', { pageId: P, section: SECRET_HEADING }) // answers that it held none
    // the sweep deletes a claim that ended over a minute ago
    assert.equal((await B.tool('claim_section', { pageId: P, section: 'Timeline' })).isError, false)
    await until(() => a1.notices() > n, 'the second claim')
    await db.execute(sql`UPDATE section_leases SET expires_at = now() - interval '2 minutes' WHERE page_id = ${P}`)
    await expectNotice([a1, a2], 'the sweep', async () => assert.ok((await sweepExpiredLeases()) >= 1))
    // exactly one notice each for claim, release, claim, sweep (the empty release sent none)
    await new Promise((r) => setTimeout(r, 150))
    assert.equal(a1.notices(), 4)

    assert.equal(outsider.synced, false)
    assert.equal(outsider.payloads.length, 0)
    assertContentless(a1.payloads)
    assertContentless(a2.payloads)
  })

  it('a suggestion made, accepted, accepted in part, rejected and withdrawn notifies the open tab', async () => {
    const P = await newPage('Suggestions page')
    const tab = await openTab(alice, P)
    const outsider = await openTab(carol, P, false)
    await until(() => outsider.authFailed, 'the non-member to be refused')
    const versionOf = async (anchor: string) =>
      ((await req(alice, 'GET', `/pages/${P}/outline`)).json().sections as { anchor: string; version: string }[]).find((x) => x.anchor === anchor)!.version
    const suggest = async (markdown: string, mode = 'append', section = SECRET_HEADING) => {
      let id = ''
      const baseVersion = mode === 'replace' ? await versionOf(section) : undefined
      await expectNotice([tab], `a ${mode} suggestion`, async () => {
        const r = await B.tool('patch_section', { pageId: P, section, mode, markdown, suggest: true, ...(baseVersion ? { baseVersion } : {}) })
        assert.equal(r.isError, false, r.text)
        id = suggestionId(r.text)
      })
      return id
    }

    const s1 = await suggest(SECRET_TEXT)
    await expectNotice([tab], 'accept', async () => {
      const r = await req(alice, 'POST', `/suggestions/${s1}/accept`, {})
      assert.equal(r.statusCode, 200, r.body)
    })
    const s2 = await suggest(`${SECRET_TEXT} two`)
    await expectNotice([tab], 'reject', async () => assert.equal((await req(alice, 'POST', `/suggestions/${s2}/reject`, {})).statusCode, 200))
    const s3 = await suggest(`${SECRET_TEXT} three`)
    await expectNotice([tab], 'withdraw', async () => assert.equal((await B.tool('withdraw_suggestion', { suggestionId: s3 })).isError, false))

    // accepting some hunks of a replace (the merge path)
    const s4 = await suggest('q2\n\nkeep\n\nq4', 'replace', 'timeline')
    const pv = (await req(alice, 'GET', `/suggestions/${s4}?preview=1`)).json().suggestion.preview
    const merge = pv?.merge as { key: string; hunks: { id: number; same: boolean }[] } | undefined
    assert.ok(merge, 'the replace suggestion splits into hunks')
    const effective = merge.hunks.filter((x) => !x.same)
    assert.ok(effective.length >= 2, JSON.stringify(merge.hunks))
    await expectNotice([tab], 'accept in part', async () => {
      const r = await req(alice, 'POST', `/suggestions/${s4}/accept`, { hunks: [effective[0].id], mergeKey: merge.key })
      assert.equal(r.statusCode, 200, r.body)
      assert.equal(r.json().suggestion.status, 'accepted_partial')
    })

    assert.equal(outsider.payloads.length, 0)
    assertContentless(tab.payloads)
  })
})
