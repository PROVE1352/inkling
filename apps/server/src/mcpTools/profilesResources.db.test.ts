// 0.16 MCP surface against a database (docs/adr/2000-* .. 2004-*): the profile in the /mcp URL over
// real HTTP with the SDK's client (initialize → tools/list per profile → resources/list →
// prompts/list), more_tools runs, page resources and the memory check under every permission rule
// (another member's private page, a range-limited connection, an agent-blocked workspace, a
// workspace whose two-step requirement blocks the person), and the instruction length note and route.
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.APP_URL ||= 'https://notes.example.com'

import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'

const HAS_DB = !!process.env.DATABASE_URL

describe('[db] MCP profiles, resources, prompts, memory check, instruction length', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const h = await import('./testHarness')
  const { db, closeDb } = await import('../db/index')
  const schema = await import('../db/schema')
  const { eq, sql } = await import('drizzle-orm')
  const Fastify = (await import('fastify')).default
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
  const { getBearerUser, sha256 } = await import('../oauth')
  const { registerMcpRoutes } = await import('../mcp')
  const { reindexPageChunks } = await import('../context/chunkIndex')
  const { reindexPageText } = await import('../md/textIndex')
  const { reindexPageLinks } = await import('../md/linkIndex')
  const { bumpAcl } = await import('../aclVersion')
  const { CORE_TOOLS } = await import('./profiles')
  const { RESOURCE_NOT_FOUND } = await import('./resources')

  const app = await h.buildTestApp()
  const mcpApp = Fastify()
  await registerMcpRoutes(mcpApp, app)
  await mcpApp.listen({ port: 0, host: '127.0.0.1' })
  const addr = mcpApp.server.address() as { port: number }
  const closers: (() => Promise<void>)[] = []
  after(async () => {
    for (const c of closers) await c()
    await mcpApp.close()
    await app.close()
    await closeDb()
  })

  type Blocks = Parameters<typeof h.makeDocPage>[3]
  const para = (...inl: unknown[]) => ({ type: 'paragraph', content: inl }) as never
  const t = (text: string) => ({ type: 'text', text, styles: {} })
  const link = (ws: string, id: string, label: string) => ({ type: 'link', href: `/w/${ws}/p/${id}`, content: [t(label)] })
  async function page(wsId: string, by: { id: string }, title: string, blocks: Blocks = [para(t(`${title} body`))], extra: Record<string, unknown> = {}) {
    const p = await h.makeDocPage(wsId, by.id, title, blocks, extra)
    await reindexPageText(p.id, blocks as never)
    await reindexPageLinks(p.id, blocks as never)
    await reindexPageChunks(p.id, blocks as never)
    return p
  }
  async function agent(user: { id: string }, opts: { profile?: 'core' | 'full'; scope?: string; range?: Record<string, unknown> } = {}) {
    const token = await h.mintToken(user, opts.scope ?? 'notes', 'Claude Code')
    if (opts.range) await db.update(schema.oauthGrants).set(opts.range).where(eq(schema.oauthGrants.accessHash, sha256(token)))
    const u = (await getBearerUser(token))!
    const c = await h.connectMcp(app, u, token, { profile: opts.profile, canWrite: opts.scope !== 'read' })
    closers.push(c.close)
    return { ...c, token }
  }

  const alice = await h.makeUser('u16-alice')
  const bob = await h.makeUser('u16-bob')
  const ws = await h.makeWorkspace(alice, [bob], 'U16 main')
  const secret = await page(ws.id, alice, 'Secret Alpha', [para(t('alice only'))], { scope: 'private' })
  const plan = await page(ws.id, alice, 'Shared Plan')
  const folder = await h.makeDocPage(ws.id, alice.id, 'Area', [], { kind: 'folder' })
  const inArea = await page(ws.id, alice, 'Area notes', undefined, { parentId: folder.id })
  const fav = await page(ws.id, alice, 'Favorite Runbook')
  await db.insert(schema.bookmarks).values({ userId: bob.id, pageId: fav.id, sortOrder: 0 })

  describe('profiles over HTTP with the SDK client', () => {
    async function httpClient(token: string, query: string) {
      const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${addr.port}/mcp${query}`), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      })
      const client = new Client({ name: 'u16-http', version: '1' })
      await client.connect(transport)
      closers.push(() => client.close())
      return client
    }

    it('initialize → tools/list (core, full, none) → resources/list → prompts/list', async () => {
      const token = await h.mintToken(bob, 'notes', 'Claude Code')
      const core = await httpClient(token, '?profile=core')
      const caps = core.getServerCapabilities()!
      assert.ok(caps.tools && caps.resources && caps.prompts, JSON.stringify(caps))
      const coreTools = (await core.listTools()).tools.map((x) => x.name)
      assert.deepEqual([...coreTools].sort(), [...CORE_TOOLS].sort())
      const full = (await (await httpClient(token, '?profile=full')).listTools()).tools.map((x) => x.name)
      const none = (await (await httpClient(token, '')).listTools()).tools.map((x) => x.name)
      assert.deepEqual(full, none, 'no profile = full')
      assert.ok(!full.includes('more_tools') && full.includes('create_chart') && full.includes('check_notes'))
      const res = await core.listResources()
      assert.ok(res.resources.some((r) => r.uri === `inkling://page/${plan.id}`))
      const prompts = await core.listPrompts()
      assert.deepEqual(prompts.prompts.map((p) => p.name), ['catch-up', 'meeting-notes', 'memory-review'])
      // a tool core hides runs through more_tools over the same HTTP path
      const r = (await core.callTool({ name: 'more_tools', arguments: { tool: 'list_templates', arguments: { workspaceId: ws.id } } })) as {
        content: { text: string }[]
        isError?: boolean
      }
      assert.ok(!r.isError, r.content[0]?.text)
      assert.match(r.content[0].text, /"builtin":true/)
    })

    it('an unknown profile is a 400 with the JSON-RPC error; the OAuth resource may carry the profile', async () => {
      const token = await h.mintToken(bob)
      const res = await fetch(`http://127.0.0.1:${addr.port}/mcp?profile=everything`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      })
      assert.equal(res.status, 400)
      assert.match(((await res.json()) as { error: { message: string } }).error.message, /profile=core or \/mcp\?profile=full/)
    })
  })

  describe('more_tools keeps the tool rules', () => {
    it('a read-only connection: a write tool run through more_tools refuses like a direct call', async () => {
      const ro = await agent(bob, { profile: 'core', scope: 'read' })
      const r = await ro.tool('more_tools', { tool: 'restore_page', arguments: { pageId: plan.id } })
      assert.ok(r.isError && /read-only/.test(r.text), r.text)
      const v = await ro.tool('more_tools', { tool: 'list_versions', arguments: { pageId: plan.id.slice(0, 8) } })
      assert.ok(!v.isError, v.text) // short ids resolve as for a direct call
    })
  })

  describe('page resources', () => {
    const list = async (c: Awaited<ReturnType<typeof agent>>) => (await c.client.listResources()).resources

    it("lists favorites first, then recent pages; another member's private page never appears", async () => {
      const b = await agent(bob)
      const rs = await list(b)
      assert.equal(rs[0].uri, `inkling://page/${fav.id}`)
      assert.equal(rs[0].description, 'Favorite')
      assert.equal(rs[0].name, 'Favorite Runbook')
      assert.equal(rs[0].title, undefined, 'the template has no title to copy over the page title')
      const all = JSON.stringify(rs)
      assert.ok(!all.includes(secret.id) && !all.includes('Secret Alpha'), 'private page of another member')
      assert.ok(!all.includes(folder.id), 'folders are not resources')
      assert.ok(rs.length <= 50)
      assert.equal(JSON.stringify(await list(b)), all, 'same answer twice')
      const a = await agent(alice)
      assert.ok(JSON.stringify(await list(a)).includes(secret.id), 'the author sees her own private page')
    })

    it('read: the read_page answer (wrapped); hidden and missing ids give the same not-found error', async () => {
      const b = await agent(bob)
      const r = await b.client.readResource({ uri: `inkling://page/${plan.id.slice(0, 8)}` })
      const text = (r.contents[0] as { text: string }).text
      assert.match(text, /^# Shared Plan/)
      assert.match(text, /<untrusted_content source="page"/)
      const errOf = async (uri: string) => {
        try {
          await b.client.readResource({ uri })
          return null
        } catch (e) {
          return e as { code: number; message: string }
        }
      }
      const hidden = await errOf(`inkling://page/${secret.id}`)
      const missing = await errOf('inkling://page/00000000-0000-4000-8000-0000000000aa')
      assert.equal(hidden?.code, RESOURCE_NOT_FOUND)
      assert.equal(missing?.code, RESOURCE_NOT_FOUND)
      assert.ok(!hidden!.message.includes('Secret'))
      assert.equal(hidden!.message.replace(secret.id, 'X'), missing!.message.replace('00000000-0000-4000-8000-0000000000aa', 'X'))
    })

    it('range, agent blocks and the two-step requirement narrow the list like every read', async () => {
      const ranged = await agent(bob, { range: { rangeKind: 'subtree', rangePageId: folder.id } })
      const inRange = (await list(ranged)).map((r) => r.uri)
      assert.deepEqual(inRange, [`inkling://page/${inArea.id}`])
      const blockedWs = await h.makeWorkspace(alice, [bob], 'U16 blocked')
      const blockedPage = await page(blockedWs.id, alice, 'Blocked page')
      const tfaWs = await h.makeWorkspace(alice, [bob], 'U16 2fa')
      const tfaPage = await page(tfaWs.id, alice, 'Two-step page')
      const b = await agent(bob)
      const before = JSON.stringify(await list(b))
      assert.ok(before.includes(blockedPage.id) && before.includes(tfaPage.id))
      await db.insert(schema.workspaceAgentBlocks).values({ workspaceId: blockedWs.id, userId: bob.id, clientId: null, createdBy: alice.id })
      await db.transaction((tx) => bumpAcl(tx, blockedWs.id))
      await db.execute(sql`UPDATE workspaces SET two_factor_required_at = now() - interval '1 day', two_factor_grace_days = 0 WHERE id = ${tfaWs.id}`)
      const now = JSON.stringify(await list(b))
      assert.ok(!now.includes(blockedPage.id), 'agent-blocked workspace')
      assert.ok(!now.includes(tfaPage.id), 'two-step requirement')
      const err = await b.client.readResource({ uri: `inkling://page/${blockedPage.id}` }).catch((e) => e as { code: number })
      assert.equal((err as { code: number }).code, RESOURCE_NOT_FOUND)
    })
  })

  // setup in the outer body: it completes before any test runs (an async describe body would interleave)
  const cw = await h.makeWorkspace(alice, [bob], 'U16 check')
  const target = await page(cw.id, alice, 'Deploy guide')
  const gone = await page(cw.id, alice, 'Old plan')
  const priv = await page(cw.id, alice, 'Alice Diary', [para(t('private'))], { scope: 'private' })
  const privLinked = await page(cw.id, alice, 'Alice Notes', [para(t('private 2'))], { scope: 'private' })
  const src = await page(cw.id, alice, 'Onboarding', [
    para(t('See [[Alice Diary]], [[Nothing Here]] and [[deploy guide]]. '), link(cw.id, gone.id, 'Old plan'), t(' '), link(cw.id, privLinked.id, 'Alice Notes')),
  ])
  const lonely = await page(cw.id, alice, 'Lonely idea')
  await page(cw.id, alice, 'Meeting Notes')
  await page(cw.id, alice, 'meeting  notes!')
  await page(cw.id, alice, 'Meeting notes', [para(t('mine'))], { scope: 'private' })
  const verified = await page(cw.id, alice, 'Runbook v1')
  await db.insert(schema.pageVerifications).values({
    pageId: verified.id,
    workspaceId: cw.id,
    verifiedBy: alice.id,
    verifiedAt: new Date('2026-01-01T00:00:00Z'),
    expiresAt: new Date('2026-02-01T00:00:00Z'),
  })
  const bigBlocks = Array.from({ length: 40 }, (_, i) => para(t(`Paragraph ${i} ${'lorem ipsum dolor sit amet '.repeat(14)}`))) as Blocks
  const big = await page(cw.id, alice, 'Old big spec', bigBlocks)
  await db.update(schema.pages).set({ updatedAt: new Date(Date.now() - 400 * 86_400_000) }).where(eq(schema.pages.id, big.id))
  // trashed through the route the web app and trash_page use: the source's page_links rows stay
  for (const id of [gone.id, privLinked.id]) {
    const del = await app.inject({ method: 'DELETE', url: `/api/pages/${id}`, headers: { cookie: alice.cookie } })
    assert.ok(del.statusCode < 300, del.body)
  }
  const trashedOn = (await db.select({ d: schema.pages.deletedAt }).from(schema.pages).where(eq(schema.pages.id, gone.id)))[0].d!
  const { localISODate } = await import('../review')

  describe('check_notes', () => {
    it("broken links, duplicates, unlinked, verification and large quiet pages, as Bob sees them; Alice's private pages never leak", async () => {
      const b = await agent(bob, { profile: 'core' })
      const r = await b.tool('more_tools', { tool: 'check_notes', arguments: { workspaceId: cw.id } })
      assert.ok(!r.isError, r.text)
      const out = r.text
      assert.match(out, new RegExp(`- ${src.id.slice(0, 8)} "Onboarding" \\(4\\): \\[\\[Alice Diary\\]\\] missing; \\[\\[Nothing Here\\]\\] missing; \\[\\[deploy guide\\]\\] not linked, page ${target.id.slice(0, 8)} has that name now; link to "Old plan" ${gone.id.slice(0, 8)} trashed ${localISODate(trashedOn)}`))
      for (const hidden of [priv.id.slice(0, 8), privLinked.id.slice(0, 8), 'Alice Notes']) assert.ok(!out.includes(hidden), hidden)
      assert.match(out, /duplicate titles: 1 group\n- "[Mm]eeting {1,2}[Nn]otes!?" ×2: /)
      assert.match(out, new RegExp(`- ${lonely.id.slice(0, 8)} "Lonely idea" updated`))
      assert.match(out, new RegExp(`- ${verified.id.slice(0, 8)} "Runbook v1" lapsed 2026-02-01`))
      assert.match(out, new RegExp(`large and quiet \\(≥ 3,000 tok, unchanged since before \\d{4}-\\d\\d-\\d\\d\\): 1\\n- ${big.id.slice(0, 8)} "Old big spec" ~[\\d,]+ tok`))
      assert.match(out, /<untrusted_content source="check">/)
      assert.equal((await b.tool('more_tools', { tool: 'check_notes', arguments: { workspaceId: cw.id } })).text, out, 'deterministic')
      // Alice: her private page resolves, so [[Alice Diary]] is a link waiting to be written
      const a = await agent(alice)
      const mine = (await a.tool('check_notes', { workspaceId: cw.id })).text
      assert.match(mine, new RegExp(`\\[\\[Alice Diary\\]\\] not linked, page ${priv.id.slice(0, 8)} has that name now`))
      assert.match(mine, /"[Mm]eeting {1,2}[Nn]otes!?" ×3/)
      assert.match(mine, new RegExp(`link to "Alice Notes" ${privLinked.id.slice(0, 8)} trashed`))
    })

    it('a subtree (parentId) and a range-limited connection see only their part', async () => {
      const area = await h.makeDocPage(cw.id, alice.id, 'Check area', [], { kind: 'folder' })
      const inner = await page(cw.id, alice, 'Inner lonely', undefined, { parentId: area.id })
      const b = await agent(bob)
      const sub = (await b.tool('check_notes', { parentId: area.id.slice(0, 8) })).text
      assert.match(sub, /2 pages you can see/)
      assert.ok(sub.includes(inner.id.slice(0, 8)) && !sub.includes(lonely.id.slice(0, 8)) && !sub.includes('Meeting'))
      const ranged = await agent(bob, { range: { rangeKind: 'subtree', rangePageId: area.id } })
      const rr = (await ranged.tool('check_notes', { workspaceId: cw.id })).text
      assert.ok(rr.includes(inner.id.slice(0, 8)) && !rr.includes(src.id.slice(0, 8)) && !rr.includes('Meeting'), rr)
      const outside = await ranged.tool('check_notes', { parentId: src.id })
      assert.ok(outside.isError, outside.text)
    })
  })

  describe('instruction length', () => {
    it('get_instructions ends with one note when the bodies it returns are long; the route gives the numbers', async () => {
      const iw = await h.makeWorkspace(alice, [bob], 'U16 instr')
      const lines = Array.from({ length: 230 }, (_, i) => para(t(`Rule ${i}: keep it short.`))) as Blocks
      const ip = await h.makeDocPage(iw.id, alice.id, 'Agent rules', lines, { editLocked: true })
      await db.insert(schema.agentInstructions).values({ pageId: ip.id, workspaceId: iw.id, mode: 'always' })
      await db.transaction((tx) => bumpAcl(tx, iw.id))
      const b = await agent(bob)
      const out = (await b.tool('get_instructions', { workspaceId: iw.id })).text
      const last = out.split('\n').at(-1)!
      assert.match(last, /^note: the instructions above are \d+ lines, [\d.]+ KB \(~\d+ tok\), past the 200 lines or 25 KB/)
      const res = await app.inject({ method: 'GET', url: `/api/workspaces/${iw.id}/agent-instructions/length`, headers: { cookie: bob.cookie } })
      assert.equal(res.statusCode, 200)
      const dto = res.json() as { limits: { lines: number; bytes: number }; always: { long: boolean; pages: number; lines: number }; pages: { pageId: string; long: boolean; truncated: boolean }[] }
      assert.deepEqual(dto.limits, { lines: 200, bytes: 25_000 })
      assert.equal(dto.always.pages, 1)
      assert.equal(dto.always.long, true)
      assert.deepEqual(dto.pages.map((p) => [p.pageId, p.long]), [[ip.id, true]])
      assert.ok(!res.body.includes('Rule 1'), 'sizes only')
      const outsider = await h.makeUser('u16-outsider')
      const denied = await app.inject({ method: 'GET', url: `/api/workspaces/${iw.id}/agent-instructions/length`, headers: { cookie: outsider.cookie } })
      assert.ok(denied.statusCode === 403 || denied.statusCode === 404, String(denied.statusCode))
    })
  })
})
