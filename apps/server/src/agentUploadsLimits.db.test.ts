// Raised limits for uploads by AI agents (docs/adr/2065-*): AGENT_UPLOAD_MAX_MB=20 lets a 15 MB file
// through upload_file over HTTP (the /mcp body follows the cap, for upload_file calls only) and a 20 MB
// file through an API token; AGENT_UPLOAD_DAILY_MB=0 means no daily budget. The env is read at import,
// so this file sets it before anything loads.
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
import { mkdirSync } from 'node:fs'
import path from 'node:path'

process.env.AGENT_UPLOAD_MAX_MB = '20'
process.env.AGENT_UPLOAD_DAILY_MB = '0'
const DATA = `${process.env.TMPDIR || '/tmp'}/inkling-agentuploads-limits-${process.pid}`
process.env.DATA_DIR ||= DATA
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.APP_URL ||= 'https://notes.example.com'

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

const HAS_DB = !!process.env.DATABASE_URL
const MB = 1024 * 1024

describe('[db] uploads by AI agents: raised limits', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  mkdirSync(path.join(process.env.DATA_DIR!, 'uploads'), { recursive: true })
  const h = await import('./mcpTools/testHarness')
  const { db, closeDb } = await import('./db/index')
  const schema = await import('./db/schema')
  const Fastify = (await import('fastify')).default
  const { registerMcpRoutes } = await import('./mcp')
  const collab = await import('./collab')
  const { agentUploadEnv } = await import('./agentUploads')
  const app = await h.buildTestApp()
  const mcpApp = Fastify()
  await registerMcpRoutes(mcpApp, app)
  await mcpApp.ready()

  type U = Awaited<ReturnType<typeof h.makeUser>>
  let bob: U
  let wsId: string
  let pageId: string
  let token: string
  let secret: string

  const rpc = (body: unknown) =>
    mcpApp.inject({
      method: 'POST',
      url: '/mcp',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      payload: JSON.stringify(body),
    })
  const toolText = (res: Awaited<ReturnType<typeof rpc>>) => {
    const j = res.json() as { result?: { content: { text: string }[]; isError?: boolean } }
    return { text: j.result?.content.map((c) => c.text).join('\n') ?? res.body, isError: j.result?.isError === true }
  }
  const call = (name: string, args: Record<string, unknown>) => rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })

  before(async () => {
    bob = await h.makeUser('Bob')
    wsId = (await h.makeWorkspace(bob)).id
    pageId = (await h.makeDocPage(wsId, bob.id, 'Big', [{ type: 'paragraph', content: [{ type: 'text', text: 'x', styles: {} }] }] as never)).id
    token = await h.mintToken(bob, 'notes', 'Claude')
    const t = await app.inject({
      method: 'POST',
      url: '/api/tokens',
      headers: { cookie: bob.cookie },
      payload: { name: 'up', expiresInDays: 30, access: 'write', range: { kind: 'all' } },
    })
    secret = t.json().secret as string
  })
  after(async () => {
    await collab.destroyCollab()
    await mcpApp.close()
    await app.close()
    await closeDb()
  })

  it('reads the raised limits', () => {
    assert.equal(agentUploadEnv.maxBytes, 20 * MB)
    assert.equal(agentUploadEnv.dailyBytes, null)
    assert.equal(agentUploadEnv.mcpUploadBodyBytes, Math.ceil((20 * MB) / 3) * 4 + MB)
  })

  it('a 15 MB file goes through upload_file over HTTP; other calls stay at 12 MB; past the cap it is refused', async () => {
    const ok = toolText(await call('upload_file', { pageId, name: 'big.txt', text: 'x'.repeat(15 * MB), attachOnly: true }))
    assert.equal(ok.isError, false, ok.text.slice(0, 300))
    assert.match(ok.text, /^Uploaded "big\.txt" \(text\/plain, 15\.0 MB\)/)
    // the same body size for any other tool is refused before it runs
    const other = await call('create_page', { workspaceId: wsId, title: 'Huge', markdown: 'x'.repeat(13 * MB) })
    assert.equal(other.statusCode, 413, other.body.slice(0, 300))
    assert.match(other.body, /only upload_file calls may be larger/)
    // over the per-file cap: the tool names the limit
    const big = toolText(await call('upload_file', { pageId, name: 'big.txt', text: 'x'.repeat(20 * MB + 10), attachOnly: true }))
    assert.equal(big.isError, true)
    assert.match(big.text, /at most 20\.0 MB/)
  })

  it('an API token uploads up to the raised 20 MB, not more', async () => {
    const multipart = (bytes: Buffer) => {
      const b = '----x'
      return {
        payload: Buffer.concat([
          Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="t.txt"\r\nContent-Type: text/plain\r\n\r\n`),
          bytes,
          Buffer.from(`\r\n--${b}--\r\n`),
        ]),
        headers: { authorization: `Bearer ${secret}`, 'content-type': `multipart/form-data; boundary=${b}` },
      }
    }
    const ok = await app.inject({ method: 'POST', url: `/api/files?workspaceId=${wsId}&pageId=${pageId}`, ...multipart(Buffer.alloc(19 * MB, 0x61)) })
    assert.equal(ok.statusCode, 200, ok.body)
    const over = await app.inject({ method: 'POST', url: `/api/files?workspaceId=${wsId}&pageId=${pageId}`, ...multipart(Buffer.alloc(21 * MB, 0x61)) })
    assert.equal(over.statusCode, 413, over.body)
    assert.match(over.json().error.message, /max 20 MB through a connection/)
  })

  it('no daily budget: 1 GB of earlier agent uploads does not stop the next one', async () => {
    await db.insert(schema.files).values({ workspaceId: wsId, pageId, name: 'old', mime: 'text/plain', size: 1024 * MB, createdBy: bob.id, uploadedVia: 'grant:x' })
    const r = toolText(await call('upload_file', { pageId, name: 'n.txt', text: 'still fine', attachOnly: true }))
    assert.equal(r.isError, false, r.text)
  })
})
