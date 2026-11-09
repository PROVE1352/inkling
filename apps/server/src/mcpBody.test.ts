// POST /mcp bodies (B-L10, docs/adr/1526-*): the value count before JSON.parse, and the HTTP
// order (token before body, value cap, Fastify's prototype-poisoning rules).
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db (the HTTP part)
import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'
import { countJsonValues, MCP_MAX_JSON_VALUES } from './mcpBody'

const HAS_DB = !!process.env.DATABASE_URL

describe('countJsonValues', () => {
  const count = (v: unknown) => countJsonValues(Buffer.from(JSON.stringify(v)))
  it('counts values outside strings and ignores commas and brackets inside them', () => {
    assert.equal(count([1, 2, 3]), 4) // three commas+bracket+1 ≈ values (upper bound)
    assert.equal(count({ a: 'x, y, [z] {w}', b: 'say \\"hi\\", ok' }), 3)
    assert.equal(count('just a string, with commas'), 1)
    assert.ok(count({ rows: Array.from({ length: 1000 }, (_, i) => ({ i })) }) > 2000)
  })

  it('stops at the limit and survives unterminated strings', () => {
    const big = Buffer.from(`[${'1,'.repeat(1_000_000)}1]`)
    assert.equal(countJsonValues(big, 100), 101)
    assert.equal(countJsonValues(Buffer.from('{"a": "never closed, [ {')), 2)
  })

  it('a large string-heavy import_folder body stays far below the cap', () => {
    const files = Array.from({ length: 300 }, (_, i) => ({ path: `n/${i}.md`, markdown: '## 회의록, "인용"\n\n- a, b, c [x] {y}\n'.repeat(500) }))
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'import_folder', arguments: { workspaceId: 'w', folderName: 'f', files } } }))
    assert.ok(body.length > 5_000_000)
    assert.ok(countJsonValues(body, MCP_MAX_JSON_VALUES) < 1_000)
  })
})

describe('[db] POST /mcp body handling', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const Fastify = (await import('fastify')).default
  const h = await import('./mcpTools/testHarness')
  const { closeDb } = await import('./db/index')
  const api = await h.buildTestApp()
  const app = Fastify()
  await app.register(async (root) => {
    await (await import('./mcp')).registerMcpRoutes(root, api)
  })
  await app.ready()
  after(async () => {
    await app.close()
    await api.close()
    await closeDb()
  })
  const u = await h.makeUser('Body')
  const token = await h.mintToken(u)
  const post = (payload: string, auth = true) =>
    app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { ...(auth ? { authorization: `Bearer ${token}` } : {}), accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
      payload,
    })

  it('no token: 401 before the body is parsed (malformed JSON does not matter)', async () => {
    const r = await post('{"jsonrpc": "2.0", broken', false)
    assert.equal(r.statusCode, 401)
    assert.match(String(r.headers['www-authenticate']), /resource_metadata=/)
    const bad = await app.inject({ method: 'POST', url: '/mcp', headers: { authorization: 'Bearer nope', 'content-type': 'application/json' }, payload: '{' })
    assert.equal(bad.statusCode, 401)
  })

  it('too many values: 413 with a next step; a normal call works; prototype poisoning is refused', async () => {
    const dense = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ack', arguments: { ids: Array.from({ length: 30_000 }, (_, i) => String(i)) } } })
    const r = await post(dense)
    assert.equal(r.statusCode, 413, r.body)
    assert.match(r.body, /TOO_MANY_VALUES|more than 20000 JSON values/)
    const ok = await post(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }))
    assert.equal(ok.statusCode, 200, ok.body)
    assert.match(ok.body, /catch_up/)
    const proto = await post('{"jsonrpc":"2.0","id":3,"method":"tools/list","__proto__":{"x":1}}')
    assert.equal(proto.statusCode, 400)
  })
})
