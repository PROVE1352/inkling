// Uploads by AI agents on or off (docs/adr/2065-*) against a real database: the server default
// (AGENT_UPLOADS on / off / never) × the workspace's choice (default / on / off) for MCP upload_file
// and an API token's POST /files; people's browser uploads and read_file are never affected; who may
// change the setting, its audit event, and the settings DTO.
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
import { mkdirSync } from 'node:fs'
import path from 'node:path'

const DATA = `${process.env.TMPDIR || '/tmp'}/inkling-agentuploads-${process.pid}`
process.env.DATA_DIR ||= DATA
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.APP_URL ||= 'https://notes.example.com'

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

const HAS_DB = !!process.env.DATABASE_URL

describe('[db] uploads by AI agents: server default × workspace setting', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  mkdirSync(path.join(process.env.DATA_DIR!, 'uploads'), { recursive: true })
  const h = await import('./mcpTools/testHarness')
  const { db, closeDb } = await import('./db/index')
  const schema = await import('./db/schema')
  const { and, eq } = await import('drizzle-orm')
  const collab = await import('./collab')
  const { setAgentUploadModeForTests } = await import('./agentUploads')
  const app = await h.buildTestApp()

  type U = Awaited<ReturnType<typeof h.makeUser>>
  const req = (u: U, method: 'GET' | 'PUT', url: string, payload?: unknown) =>
    app.inject({ method, url: `/api${url}`, headers: { cookie: u.cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) })
  const para = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text, styles: {} }] })

  let alice: U, bob: U, carol: U
  let wsId: string
  let pageId: string
  let B: Awaited<ReturnType<typeof h.connectMcp>>
  let secret: string

  const multipart = (headers: Record<string, string>, name: string, bytes: Buffer) => {
    const b = '----x'
    return {
      payload: Buffer.concat([
        Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: text/plain\r\n\r\n`),
        bytes,
        Buffer.from(`\r\n--${b}--\r\n`),
      ]),
      headers: { ...headers, 'content-type': `multipart/form-data; boundary=${b}` },
    }
  }
  const tokenUpload = () =>
    app.inject({ method: 'POST', url: `/api/files?workspaceId=${wsId}&pageId=${pageId}`, ...multipart({ authorization: `Bearer ${secret}` }, 'n.txt', Buffer.from('hello')) })
  const browserUpload = (u: U) =>
    app.inject({ method: 'POST', url: `/api/files?workspaceId=${wsId}&pageId=${pageId}`, ...multipart({ cookie: u.cookie }, 'n.txt', Buffer.from('hello')) })
  const setWs = async (v: 'on' | 'off' | null) => {
    await db.update(schema.workspaces).set({ agentUploads: v }).where(eq(schema.workspaces.id, wsId))
  }

  before(async () => {
    alice = await h.makeUser('Alice') // owner
    bob = await h.makeUser('Bob') // member with an agent
    carol = await h.makeUser('Carol') // admin
    wsId = (await h.makeWorkspace(alice, [bob, carol])).id
    await db
      .update(schema.workspaceMembers)
      .set({ role: 'admin' })
      .where(and(eq(schema.workspaceMembers.workspaceId, wsId), eq(schema.workspaceMembers.userId, carol.id)))
    pageId = (await h.makeDocPage(wsId, bob.id, 'Uploads', [para('x')] as never)).id
    B = await h.connectMcp(app, { ...bob, via: 'Claude' }, await h.mintToken(bob, 'notes', 'Claude'))
    const t = await app.inject({
      method: 'POST',
      url: '/api/tokens',
      headers: { cookie: bob.cookie },
      payload: { name: 'up', expiresInDays: 30, access: 'write', range: { kind: 'all' } },
    })
    secret = t.json().secret as string
  })
  after(async () => {
    setAgentUploadModeForTests('on')
    await B.close()
    await collab.destroyCollab()
    await app.close()
    await closeDb()
  })

  it('server on/off/never × workspace default/on/off decide MCP and API-token uploads; browser uploads always work', async () => {
    const table: ['on' | 'off' | 'never', 'on' | 'off' | null, boolean, RegExp | null][] = [
      ['on', null, true, null],
      ['on', 'on', true, null],
      ['on', 'off', false, /turned off in this workspace; a workspace owner or admin can turn them on/],
      ['off', null, false, /off by default on this server/],
      ['off', 'on', true, null],
      ['off', 'off', false, /turned off in this workspace/],
      ['never', null, false, /turned off on this server \(AGENT_UPLOADS=never\)/],
      ['never', 'on', false, /AGENT_UPLOADS=never/],
      ['never', 'off', false, /AGENT_UPLOADS=never/],
    ]
    for (const [mode, ws, allowed, why] of table) {
      setAgentUploadModeForTests(mode)
      await setWs(ws)
      const label = `${mode} × ${ws ?? 'default'}`
      const r = await B.tool('upload_file', { pageId, name: 'note.txt', text: 'from the agent', attachOnly: true })
      const t = await tokenUpload()
      if (allowed) {
        assert.equal(r.isError, false, `${label}: ${r.text}`)
        assert.equal(t.statusCode, 200, `${label}: ${t.body}`)
      } else {
        assert.equal(r.isError, true, label)
        assert.match(r.text, why!, label)
        assert.match(r.text, /\(AGENT_UPLOADS_OFF\)\. Nothing was stored; do not retry/, label)
        assert.equal(t.statusCode, 403, label)
        assert.equal(t.json().error.code, 'AGENT_UPLOADS_OFF', label)
        assert.match(t.json().error.message, why!, label)
      }
      const p = await browserUpload(alice)
      assert.equal(p.statusCode, 200, `${label} browser: ${p.body}`)
    }
  })

  it('read_file still reads attachments while uploads are off', async () => {
    setAgentUploadModeForTests('never')
    const up = await browserUpload(alice)
    const id = (up.json() as { file: { id: string } }).file.id
    const r = await B.tool('read_file', { file: id })
    assert.equal(r.isError, false, r.text)
    assert.match(r.text, /hello/)
    setAgentUploadModeForTests('on')
  })

  it('the daily budget counts only uploads through connections; people have none', async () => {
    setAgentUploadModeForTests('on')
    await setWs(null)
    const MB = 1024 * 1024
    const fake = (via: string | null, size: number) =>
      db.insert(schema.files).values({ workspaceId: wsId, pageId, name: 'old.bin', mime: 'text/plain', size, createdBy: bob.id, uploadedVia: via })
    // 300 MB Bob put in with the browser: no budget for people, and it does not count for his agents
    await fake(null, 300 * MB)
    const r = await B.tool('upload_file', { pageId, name: 'a.txt', text: 'ok', attachOnly: true })
    assert.equal(r.isError, false, r.text)
    const [row] = await db.select().from(schema.files).where(eq(schema.files.id, /as file ([0-9a-f-]{36})/.exec(r.text)![1]))
    assert.match(row.uploadedVia ?? '', /^grant:[0-9a-f-]{36}$/)
    const viaToken = await tokenUpload()
    const [trow] = await db.select().from(schema.files).where(eq(schema.files.id, viaToken.json().file.id))
    assert.match(trow.uploadedVia ?? '', /^token:[0-9a-f-]{36}$/)
    assert.equal((await browserUpload(bob)).statusCode, 200)
    // 200 MB through his connections in the last 24 hours: both connection paths stop, the browser does not
    await fake('grant:00000000-0000-0000-0000-000000000000', 200 * MB)
    const over = await tokenUpload()
    assert.equal(over.statusCode, 429, over.body)
    assert.equal(over.json().error.code, 'UPLOAD_BUDGET')
    assert.match((await B.tool('upload_file', { pageId, name: 'b.txt', text: 'no', attachOnly: true })).text, /UPLOAD_BUDGET|uploaded 200 MB/)
    assert.equal((await browserUpload(bob)).statusCode, 200)
    await db.delete(schema.files).where(eq(schema.files.createdBy, bob.id))
  })

  it('owners and admins change it in the browser, audited; members, tokens and "on" under never are refused', async () => {
    setAgentUploadModeForTests('on')
    await setWs(null)
    const settings = async () => (await req(alice, 'GET', `/workspaces/${wsId}/settings`)).json().settings
    assert.equal((await settings()).agentUploads, null)
    assert.equal((await settings()).agentUploadsServer, 'on')

    const off = await req(carol, 'PUT', `/workspaces/${wsId}/settings/agent-uploads`, { value: 'off' })
    assert.equal(off.statusCode, 200, off.body)
    assert.equal(off.json().settings.agentUploads, 'off')
    const on = await req(alice, 'PUT', `/workspaces/${wsId}/settings/agent-uploads`, { value: 'on' })
    assert.equal(on.json().settings.agentUploads, 'on')
    assert.equal((await req(bob, 'PUT', `/workspaces/${wsId}/settings/agent-uploads`, { value: 'off' })).statusCode, 403)
    assert.equal(
      (await app.inject({ method: 'PUT', url: `/api/workspaces/${wsId}/settings/agent-uploads`, headers: { authorization: `Bearer ${secret}` }, payload: { value: 'off' } }))
        .statusCode,
      403,
    )
    assert.equal((await req(alice, 'PUT', `/workspaces/${wsId}/settings/agent-uploads`, { value: 'maybe' })).statusCode, 400)

    const events = await db
      .select()
      .from(schema.workspaceAuditEvents)
      .where(and(eq(schema.workspaceAuditEvents.workspaceId, wsId), eq(schema.workspaceAuditEvents.action, 'settings.updated')))
    const mine = events.filter((e) => JSON.stringify(e.after ?? {}).includes('agentUploads'))
    assert.equal(mine.length, 2, JSON.stringify(events))
    assert.deepEqual(
      mine.map((e) => [e.actorId, e.before, e.after]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      [
        [alice.id, { agentUploads: 'off' }, { agentUploads: 'on' }],
        [carol.id, { agentUploads: 'default' }, { agentUploads: 'off' }],
      ].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    )
    // the same value again records nothing
    await req(alice, 'PUT', `/workspaces/${wsId}/settings/agent-uploads`, { value: 'on' })
    const again = await db.select().from(schema.workspaceAuditEvents).where(eq(schema.workspaceAuditEvents.workspaceId, wsId))
    assert.equal(again.filter((e) => JSON.stringify(e.after ?? {}).includes('agentUploads')).length, 2)

    setAgentUploadModeForTests('never')
    const refused = await req(alice, 'PUT', `/workspaces/${wsId}/settings/agent-uploads`, { value: 'on' })
    assert.equal(refused.statusCode, 409)
    assert.equal(refused.json().error.code, 'AGENT_UPLOADS_NEVER')
    assert.equal((await req(alice, 'PUT', `/workspaces/${wsId}/settings/agent-uploads`, { value: 'default' })).statusCode, 200)
    assert.equal((await settings()).agentUploadsServer, 'never')
    setAgentUploadModeForTests('on')
  })
})
