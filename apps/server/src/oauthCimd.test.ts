// Client ID Metadata Documents (docs/adr/2280-* .. 2282-*): URL rules, document validation, cache
// lifetime, and the fetch/cache/rate-limit behaviour against a loopback server in this process.
// Run: cd apps/server && npx tsx --test src/oauthCimd.test.ts
import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, beforeEach, describe, it } from 'node:test'
import {
  CIMD_DEFAULT_TTL_MS,
  CIMD_MAX_BYTES,
  CIMD_MAX_TTL_MS,
  CIMD_MIN_TTL_MS,
  CIMD_RETRY_GAP_MS,
  CimdError,
  cimdCacheLifetimeMs,
  cimdClientUsable,
  checkClientIdUrl,
  isJsonMediaType,
  isUrlClientId,
  resolveCimdClient,
  validateCimdDocument,
  _resetCimd,
} from './oauthCimd'
import type { CimdConfig } from './oauthCimd'

// The documents Claude published (fetched 2026-11-10 from the client_id URLs, Content-Type
// application/json, Cache-Control: public, max-age=300).
const CLAUDE_AI = {
  client_id: 'https://claude.ai/oauth/mcp-oauth-client-metadata',
  client_name: 'Claude',
  client_uri: 'https://claude.ai',
  redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
  grant_types: ['authorization_code', 'refresh_token', 'urn:ietf:params:oauth:grant-type:jwt-bearer'],
  response_types: ['code'],
  token_endpoint_auth_method: 'none',
}
const CLAUDE_CODE = {
  client_id: 'https://claude.ai/oauth/claude-code-client-metadata',
  client_name: 'Claude Code',
  client_uri: 'https://claude.ai',
  redirect_uris: ['http://localhost/callback', 'http://127.0.0.1/callback'],
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  token_endpoint_auth_method: 'none',
}

const OFF: CimdConfig = { enabled: true, allowedHosts: [], testLoopback: false }
const OWN = 'https://notes.example.com'

function throwsCode(fn: () => unknown, code: string) {
  assert.throws(fn, (e: unknown) => {
    assert.ok(e instanceof CimdError, `expected CimdError, got ${String(e)}`)
    assert.equal(e.code, code, `expected ${code}, got ${e.code} (${e.message})`)
    return true
  })
}
async function rejectsCode(p: Promise<unknown>, code: string, kind?: 'transient' | 'terminal') {
  try {
    await p
  } catch (e) {
    assert.ok(e instanceof CimdError, `expected CimdError, got ${String(e)}`)
    assert.equal(e.code, code, `expected ${code}, got ${e.code} (${e.message})`)
    if (kind) assert.equal(e.kind, kind)
    return
  }
  assert.fail(`expected rejection with ${code}`)
}

describe('client_id URL (draft §3)', () => {
  it('isUrlClientId: URLs yes, registered ids no', () => {
    assert.equal(isUrlClientId(CLAUDE_AI.client_id), true)
    assert.equal(isUrlClientId('http://127.0.0.1:9/x'), true)
    assert.equal(isUrlClientId('ink_c_AbC-123'), false)
    assert.equal(isUrlClientId('ink_tc_abc'), false)
    assert.equal(isUrlClientId('test-1234abcd'), false)
  })

  it('accepts the published Claude ids and https URLs with a path, port or query', () => {
    for (const ok of [CLAUDE_AI.client_id, CLAUDE_CODE.client_id, 'https://app.example.com/client.json', 'https://app.example.com:8443/c', 'https://app.example.com/c?v=1']) {
      assert.equal(checkClientIdUrl(ok, OWN, OFF).href.length > 0, true, ok)
    }
  })

  it('refuses http, no path, "/" only, fragments, userinfo, dot segments, spaces, length', () => {
    const cases: [string, string][] = [
      ['http://app.example.com/client.json', 'bad_url'],
      ['HTTPS://app.example.com/client.json', 'bad_url'],
      ['ftp://app.example.com/client.json', 'bad_url'],
      ['https://app.example.com', 'bad_url'],
      ['https://app.example.com/', 'bad_url'],
      ['https://app.example.com/?x=1', 'bad_url'],
      ['https://app.example.com/client.json#frag', 'bad_url'],
      ['https://app.example.com/client.json#', 'bad_url'],
      ['https://user@app.example.com/client.json', 'bad_url'],
      ['https://user:pw@app.example.com/client.json', 'bad_url'],
      ['https://app.example.com/a/../client.json', 'bad_url'],
      ['https://app.example.com/a/./client.json', 'bad_url'],
      ['https://app.example.com/%2e%2e/client.json', 'bad_url'],
      ['https://app.example.com/%2E/client.json', 'bad_url'],
      ['https://app.example.com/a b', 'bad_url'],
      ['https:app.example.com/client.json', 'bad_url'],
      [`https://app.example.com/${'a'.repeat(2000)}`, 'bad_url'],
    ]
    for (const [raw, code] of cases) throwsCode(() => checkClientIdUrl(raw, OWN, OFF), code)
  })

  it("refuses this server's own origin (§10.1)", () => {
    throwsCode(() => checkClientIdUrl('https://notes.example.com/files/x.json', OWN, OFF), 'own_origin')
    assert.ok(checkClientIdUrl('https://notes.example.com:8443/x.json', OWN, OFF))
  })

  it('OAUTH_CIMD_ALLOWED_HOSTS: exact and *.suffix, checked here (not left to safeFetch)', () => {
    const cfg: CimdConfig = { enabled: true, allowedHosts: ['claude.ai', '*.example.org'], testLoopback: true }
    assert.ok(checkClientIdUrl(CLAUDE_AI.client_id, OWN, cfg))
    assert.ok(checkClientIdUrl('https://a.example.org/c', OWN, cfg))
    throwsCode(() => checkClientIdUrl('https://example.org/c', OWN, cfg), 'host_not_allowed')
    throwsCode(() => checkClientIdUrl('https://evil.example.com/c', OWN, cfg), 'host_not_allowed')
    // the test loopback switch does not open the allowlist
    throwsCode(() => checkClientIdUrl('http://127.0.0.1:9999/c', OWN, cfg), 'host_not_allowed')
  })

  it('http on loopback only in test mode', () => {
    const test: CimdConfig = { enabled: true, allowedHosts: [], testLoopback: true }
    assert.ok(checkClientIdUrl('http://127.0.0.1:9999/c', OWN, test))
    throwsCode(() => checkClientIdUrl('http://127.0.0.1:9999/c', OWN, OFF), 'bad_url')
    throwsCode(() => checkClientIdUrl('http://app.example.com/c', OWN, test), 'bad_url')
  })
})

describe('document validation (draft §4-§6)', () => {
  it('the published Claude documents pass', () => {
    const a = validateCimdDocument(CLAUDE_AI.client_id, CLAUDE_AI)
    assert.deepEqual(a, { clientId: CLAUDE_AI.client_id, host: 'claude.ai', name: 'Claude', redirectUris: ['https://claude.ai/api/mcp/auth_callback'] })
    const c = validateCimdDocument(CLAUDE_CODE.client_id, CLAUDE_CODE)
    assert.equal(c.name, 'Claude Code')
    assert.deepEqual(c.redirectUris, ['http://localhost/callback', 'http://127.0.0.1/callback'])
  })

  it('client_id must equal the URL exactly (no normalisation)', () => {
    throwsCode(() => validateCimdDocument(CLAUDE_AI.client_id, { ...CLAUDE_AI, client_id: 'https://claude.ai/oauth/other' }), 'client_id_mismatch')
    throwsCode(() => validateCimdDocument('https://claude.ai/oauth/mcp-oauth-client-metadata/', CLAUDE_AI), 'client_id_mismatch')
    throwsCode(() => validateCimdDocument('https://CLAUDE.ai/oauth/mcp-oauth-client-metadata', CLAUDE_AI), 'client_id_mismatch')
    const { client_id: _drop, ...noId } = CLAUDE_AI
    throwsCode(() => validateCimdDocument(CLAUDE_AI.client_id, noId), 'client_id_mismatch')
  })

  it('redirect_uris: required, usable ones kept, none usable refused', () => {
    const id = CLAUDE_AI.client_id
    throwsCode(() => validateCimdDocument(id, { ...CLAUDE_AI, redirect_uris: undefined }), 'invalid_metadata')
    throwsCode(() => validateCimdDocument(id, { ...CLAUDE_AI, redirect_uris: [] }), 'invalid_metadata')
    throwsCode(() => validateCimdDocument(id, { ...CLAUDE_AI, redirect_uris: 'https://claude.ai/cb' }), 'invalid_metadata')
    throwsCode(() => validateCimdDocument(id, { ...CLAUDE_AI, redirect_uris: ['cursor://cb', 'http://evil.example.com/cb', 'javascript:alert(1)'] }), 'invalid_metadata')
    throwsCode(() => validateCimdDocument(id, { ...CLAUDE_AI, redirect_uris: Array.from({ length: 21 }, (_, i) => `https://a.example.com/${i}`) }), 'invalid_metadata')
    const mixed = validateCimdDocument(id, { ...CLAUDE_AI, redirect_uris: ['cursor://cb', 'https://a.example.com/cb', 'https://a.example.com/cb#x', 'https://a.example.com/cb'] })
    assert.deepEqual(mixed.redirectUris, ['https://a.example.com/cb'])
  })

  it('no secrets; only "none" authentication (absent = none)', () => {
    const id = CLAUDE_AI.client_id
    throwsCode(() => validateCimdDocument(id, { ...CLAUDE_AI, client_secret: 'x' }), 'invalid_metadata')
    throwsCode(() => validateCimdDocument(id, { ...CLAUDE_AI, client_secret_expires_at: 0 }), 'invalid_metadata')
    throwsCode(() => validateCimdDocument(id, { ...CLAUDE_AI, jwks: { keys: [] }, jwks_uri: 'https://claude.ai/jwks' }), 'invalid_metadata')
    throwsCode(() => validateCimdDocument(id, { ...CLAUDE_AI, token_endpoint_auth_method: 'client_secret_basic' }), 'invalid_metadata')
    throwsCode(() => validateCimdDocument(id, { ...CLAUDE_AI, token_endpoint_auth_methods_supported: ['none', 'client_secret_post'] }), 'invalid_metadata')
    throwsCode(() => validateCimdDocument(id, { ...CLAUDE_AI, token_endpoint_auth_method: 'private_key_jwt', jwks_uri: 'https://claude.ai/jwks' }), 'unsupported_auth')
    throwsCode(() => validateCimdDocument(id, { ...CLAUDE_AI, token_endpoint_auth_method: 'none', token_endpoint_auth_methods_supported: ['private_key_jwt'] }), 'invalid_metadata')
    throwsCode(() => validateCimdDocument(id, { ...CLAUDE_AI, token_endpoint_auth_method: 3 }), 'invalid_metadata')
    const { token_endpoint_auth_method: _m, ...noMethod } = CLAUDE_AI
    assert.ok(validateCimdDocument(id, noMethod))
    assert.ok(validateCimdDocument(id, { ...noMethod, token_endpoint_auth_methods_supported: ['private_key_jwt', 'none'] }))
  })

  it('grant_types needs authorization_code, response_types needs code (refresh_token not required)', () => {
    const id = CLAUDE_AI.client_id
    throwsCode(() => validateCimdDocument(id, { ...CLAUDE_AI, grant_types: ['client_credentials'] }), 'invalid_metadata')
    throwsCode(() => validateCimdDocument(id, { ...CLAUDE_AI, grant_types: 'authorization_code' }), 'invalid_metadata')
    throwsCode(() => validateCimdDocument(id, { ...CLAUDE_AI, response_types: ['token'] }), 'invalid_metadata')
    assert.ok(validateCimdDocument(id, { ...CLAUDE_AI, grant_types: ['authorization_code'] }))
    const { grant_types: _g, response_types: _r, ...bare } = CLAUDE_AI
    assert.ok(validateCimdDocument(id, bare))
  })

  it('not an object; name falls back to the host and is capped', () => {
    const id = CLAUDE_AI.client_id
    for (const bad of [null, 'x', 3, [CLAUDE_AI]]) throwsCode(() => validateCimdDocument(id, bad), 'not_json')
    assert.equal(validateCimdDocument(id, { ...CLAUDE_AI, client_name: undefined }).name, 'claude.ai')
    assert.equal(validateCimdDocument(id, { ...CLAUDE_AI, client_name: '​\u0001 ' }).name, 'claude.ai')
    assert.equal(validateCimdDocument(id, { ...CLAUDE_AI, client_name: 'x'.repeat(300) }).name.length, 100)
  })

  it('JSON media types', () => {
    assert.equal(isJsonMediaType('application/json'), true)
    assert.equal(isJsonMediaType('application/oauth-client+json'), true)
    assert.equal(isJsonMediaType('text/json'), false)
    assert.equal(isJsonMediaType('text/html'), false)
    assert.equal(isJsonMediaType(''), false)
    assert.equal(isJsonMediaType('application/jsonx'), false)
  })
})

describe('cache lifetime (§6.2)', () => {
  it('max-age minus Age, clamped; no-store/no-cache → floor; none → default; Expires ignored', () => {
    assert.equal(cimdCacheLifetimeMs({}), CIMD_DEFAULT_TTL_MS)
    assert.equal(cimdCacheLifetimeMs({ 'cache-control': 'public, max-age=300' }), 300_000)
    assert.equal(cimdCacheLifetimeMs({ 'cache-control': 'public, max-age=300', age: '120' }), 180_000)
    assert.equal(cimdCacheLifetimeMs({ 'cache-control': 'max-age=300', age: '290' }), CIMD_MIN_TTL_MS)
    assert.equal(cimdCacheLifetimeMs({ 'cache-control': 'max-age=0' }), CIMD_MIN_TTL_MS)
    assert.equal(cimdCacheLifetimeMs({ 'cache-control': 'no-store' }), CIMD_MIN_TTL_MS)
    assert.equal(cimdCacheLifetimeMs({ 'cache-control': 'no-cache, max-age=600' }), CIMD_MIN_TTL_MS)
    assert.equal(cimdCacheLifetimeMs({ 'cache-control': 'max-age=31536000' }), CIMD_MAX_TTL_MS)
    assert.equal(cimdCacheLifetimeMs({ 'cache-control': ['public', 'max-age=900'] }), 900_000)
    assert.equal(cimdCacheLifetimeMs({ 'cache-control': 's-maxage=900' }), CIMD_DEFAULT_TTL_MS)
    assert.equal(cimdCacheLifetimeMs({ expires: 'Thu, 01 Jan 2099 00:00:00 GMT' }), CIMD_DEFAULT_TTL_MS)
  })
})

// ---------------------------------------------------------------------------
// fetch + cache against a loopback server (test mode)
// ---------------------------------------------------------------------------

describe('resolveCimdClient', () => {
  let server: http.Server
  let base = ''
  const hits = new Map<string, number>()
  /** path → handler */
  const routes = new Map<string, (res: http.ServerResponse, id: string) => void>()
  const json = (body: unknown, headers: Record<string, string> = {}) => (res: http.ServerResponse) => {
    res.writeHead(200, { 'content-type': 'application/json', ...headers })
    res.end(JSON.stringify(body))
  }
  const doc = (id: string, extra: Record<string, unknown> = {}) => ({ ...CLAUDE_CODE, client_id: id, client_name: 'Local App', ...extra })
  let clock = 1_000_000
  const saved: Record<string, string | undefined> = {}

  before(async () => {
    for (const k of ['OAUTH_CIMD', 'OAUTH_CIMD_ALLOWED_HOSTS', 'OAUTH_CIMD_TEST_ALLOW_LOOPBACK', 'NODE_ENV']) saved[k] = process.env[k]
    server = http.createServer((req, res) => {
      const path = (req.url ?? '').split('?')[0]
      hits.set(path, (hits.get(path) ?? 0) + 1)
      const h = routes.get(path)
      if (!h) {
        res.writeHead(404)
        res.end()
        return
      }
      h(res, `${base}${req.url}`)
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  after(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    _resetCimd()
    await new Promise<void>((r) => server.close(() => r()))
  })
  beforeEach(() => {
    process.env.OAUTH_CIMD = '1'
    process.env.OAUTH_CIMD_TEST_ALLOW_LOOPBACK = '1'
    delete process.env.OAUTH_CIMD_ALLOWED_HOSTS
    if (process.env.NODE_ENV === 'production') delete process.env.NODE_ENV
    clock = 1_000_000
    _resetCimd(() => clock)
  })

  let n = 0
  const fresh = (handler: (id: string) => (res: http.ServerResponse) => void) => {
    const path = `/c${++n}/client.json`
    routes.set(path, (res, id) => handler(id)(res))
    return { id: `${base}${path}`, path }
  }

  it('off → disabled, and nothing is fetched', async () => {
    process.env.OAUTH_CIMD = '0'
    const { id, path } = fresh((i) => json(doc(i)))
    await rejectsCode(resolveCimdClient(id, OWN), 'disabled', 'terminal')
    assert.equal(hits.get(path) ?? 0, 0)
    assert.equal(cimdClientUsable(id, OWN), false)
  })

  it('fetches, caches for max-age, re-fetches after it', async () => {
    const { id, path } = fresh((i) => json(doc(i), { 'cache-control': 'max-age=120' }))
    const a = await resolveCimdClient(id, OWN)
    assert.equal(a.name, 'Local App')
    assert.equal(a.host, '127.0.0.1')
    await resolveCimdClient(id, OWN)
    assert.equal(hits.get(path), 1)
    clock += 119_000
    await resolveCimdClient(id, OWN)
    assert.equal(hits.get(path), 1)
    clock += 2_000
    await resolveCimdClient(id, OWN)
    assert.equal(hits.get(path), 2)
    assert.equal(cimdClientUsable(id, OWN), true)
  })

  it('concurrent requests share one fetch', async () => {
    const { id, path } = fresh((i) => json(doc(i)))
    await Promise.all([resolveCimdClient(id, OWN), resolveCimdClient(id, OWN), resolveCimdClient(id, OWN)])
    assert.equal(hits.get(path), 1)
  })

  it('terminal: 404, redirect (not followed), not JSON, too large, mismatch', async () => {
    await rejectsCode(resolveCimdClient(`${base}/missing/client.json`, OWN), 'status', 'terminal')
    const target = fresh((i) => json(doc(i)))
    const redir = fresh(() => (res) => {
      res.writeHead(302, { location: target.id })
      res.end()
    })
    await rejectsCode(resolveCimdClient(redir.id, OWN), 'redirect', 'terminal')
    assert.equal(hits.get(target.path) ?? 0, 0, 'the redirect target is never fetched')
    const html = fresh(() => (res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<html></html>')
    })
    await rejectsCode(resolveCimdClient(html.id, OWN), 'content_type', 'terminal')
    const broken = fresh(() => (res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"client_id":')
    })
    await rejectsCode(resolveCimdClient(broken.id, OWN), 'not_json', 'terminal')
    const big = fresh((i) => json(doc(i, { client_uri: `https://a.example.com/${'x'.repeat(CIMD_MAX_BYTES)}` })))
    await rejectsCode(resolveCimdClient(big.id, OWN), 'too_large', 'terminal')
    const other = fresh(() => json(doc('https://claude.ai/oauth/claude-code-client-metadata')))
    await rejectsCode(resolveCimdClient(other.id, OWN), 'client_id_mismatch', 'terminal')
  })

  it('a document that turns invalid is dropped at once (never served from cache)', async () => {
    let valid = true
    const { id } = fresh((i) => json(valid ? doc(i) : doc(i, { redirect_uris: [] }), { 'cache-control': 'max-age=60' }))
    await resolveCimdClient(id, OWN)
    valid = false
    clock += 61_000
    await rejectsCode(resolveCimdClient(id, OWN), 'invalid_metadata', 'terminal')
    // later failures do not bring the old one back
    clock += CIMD_RETRY_GAP_MS + 1
    await rejectsCode(resolveCimdClient(id, OWN), 'invalid_metadata', 'terminal')
  })

  it('transient failure: last valid document stands in; without one → transient error; retry gap', async () => {
    let mode: 'ok' | 'down' = 'ok'
    const { id, path } = fresh((i) => (res) => {
      if (mode === 'down') {
        res.writeHead(503)
        res.end()
        return
      }
      json(doc(i), { 'cache-control': 'max-age=60' })(res)
    })
    await resolveCimdClient(id, OWN)
    mode = 'down'
    clock += 61_000
    assert.equal((await resolveCimdClient(id, OWN)).name, 'Local App') // stale stands in
    assert.equal(hits.get(path), 2)
    await resolveCimdClient(id, OWN) // within the retry gap: no new fetch, stale again
    assert.equal(hits.get(path), 2)

    const never = fresh(() => (res) => {
      res.writeHead(500)
      res.end()
    })
    await rejectsCode(resolveCimdClient(never.id, OWN), 'unavailable', 'transient')
    await rejectsCode(resolveCimdClient(never.id, OWN), 'rate_limited', 'transient')
    assert.equal(hits.get(never.path), 1)
    clock += CIMD_RETRY_GAP_MS + 1
    await rejectsCode(resolveCimdClient(never.id, OWN), 'unavailable', 'transient')
    assert.equal(hits.get(never.path), 2)
  })

  it('the per-minute fetch budget', async () => {
    const ids = Array.from({ length: 61 }, () => fresh((i) => json(doc(i))).id)
    for (const id of ids.slice(0, 60)) await resolveCimdClient(id, OWN)
    await rejectsCode(resolveCimdClient(ids[60], OWN), 'rate_limited', 'transient')
    clock += 60_001
    assert.ok(await resolveCimdClient(ids[60], OWN))
  })

  it('private and link-local literals are refused even in test mode; loopback only in test mode', async () => {
    await rejectsCode(resolveCimdClient('https://10.0.0.1/client.json', OWN), 'blocked', 'terminal')
    await rejectsCode(resolveCimdClient('https://169.254.169.254/latest/meta-data', OWN), 'blocked', 'terminal')
    await rejectsCode(resolveCimdClient('https://[fd00::1]/client.json', OWN), 'blocked', 'terminal')
    process.env.OAUTH_CIMD_TEST_ALLOW_LOOPBACK = '0'
    const { id, path } = fresh((i) => json(doc(i)))
    await rejectsCode(resolveCimdClient(id, OWN), 'bad_url', 'terminal')
    await rejectsCode(resolveCimdClient(id.replace('http://', 'https://'), OWN), 'blocked', 'terminal')
    assert.equal(hits.get(path) ?? 0, 0)
  })

  it('NODE_ENV=production ignores the test switch', async () => {
    process.env.NODE_ENV = 'production'
    try {
      const { id } = fresh((i) => json(doc(i)))
      await rejectsCode(resolveCimdClient(id, OWN), 'bad_url', 'terminal')
    } finally {
      delete process.env.NODE_ENV
    }
  })

  it('the allowlist applies before any fetch', async () => {
    process.env.OAUTH_CIMD_ALLOWED_HOSTS = 'claude.ai'
    const { id, path } = fresh((i) => json(doc(i)))
    await rejectsCode(resolveCimdClient(id, OWN), 'host_not_allowed', 'terminal')
    assert.equal(hits.get(path) ?? 0, 0)
    assert.equal(cimdClientUsable(id, OWN), false)
  })
})
