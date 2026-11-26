// D-5 (0.25.4 security fix): with Client ID Metadata Documents on, one signed-in account (or one
// address at /oauth/token) used to be able to spend the whole per-minute fetch budget with documents
// of its own, so nobody else's new MCP client could be loaded. Each requester now has a share of the
// budget; the global cap stays.
// Run: cd apps/server && npx tsx --test src/oauthCimdShare.test.ts
import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, beforeEach, describe, it } from 'node:test'
import { CIMD_FETCHES_PER_MINUTE, CIMD_FETCHES_PER_REQUESTER_PER_MINUTE, CimdError, resolveCimdClient, _resetCimd } from './oauthCimd'

const OWN = 'https://notes.example.com'

describe('CIMD fetch budget: one requester cannot spend everyone\'s share', () => {
  let server: http.Server
  let base = ''
  let n = 0
  let clock = 1_000_000
  const saved: Record<string, string | undefined> = {}
  const doc = (id: string) => ({
    client_id: id,
    client_name: 'Local App',
    redirect_uris: ['http://localhost/callback'],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  })
  const fresh = () => `${base}/c${++n}/client.json`

  before(async () => {
    for (const k of ['OAUTH_CIMD', 'OAUTH_CIMD_ALLOWED_HOSTS', 'OAUTH_CIMD_TEST_ALLOW_LOOPBACK', 'NODE_ENV']) saved[k] = process.env[k]
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(doc(`${base}${(req.url ?? '').split('?')[0]}`)))
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

  const rateLimited = async (p: Promise<unknown>) =>
    assert.rejects(p, (e: unknown) => e instanceof CimdError && e.code === 'rate_limited' && e.kind === 'transient')

  it('an account that fetches document after document runs out of its own share; another account still loads its client', async () => {
    assert.ok(CIMD_FETCHES_PER_REQUESTER_PER_MINUTE < CIMD_FETCHES_PER_MINUTE)
    for (let i = 0; i < CIMD_FETCHES_PER_REQUESTER_PER_MINUTE; i++) await resolveCimdClient(fresh(), OWN, 'user:attacker')
    // the attacker keeps going: refused without a fetch, and the global budget is not spent
    for (let i = 0; i < CIMD_FETCHES_PER_MINUTE; i++) await rateLimited(resolveCimdClient(fresh(), OWN, 'user:attacker'))
    // someone else connects a new client in the same minute
    assert.equal((await resolveCimdClient(fresh(), OWN, 'user:victim')).name, 'Local App')
    // a minute later the attacker has a share again
    clock += 60_001
    assert.ok(await resolveCimdClient(fresh(), OWN, 'user:attacker'))
  })

  it('a cached document costs nothing from the share', async () => {
    const id = fresh()
    await resolveCimdClient(id, OWN, 'user:a')
    for (let i = 0; i < CIMD_FETCHES_PER_REQUESTER_PER_MINUTE * 3; i++) await resolveCimdClient(id, OWN, 'user:a')
  })

  it('the global cap still holds across many requesters', async () => {
    let r = 0
    for (let i = 0; i < CIMD_FETCHES_PER_MINUTE; i++) await resolveCimdClient(fresh(), OWN, `user:${r++}`)
    await rateLimited(resolveCimdClient(fresh(), OWN, `user:${r++}`))
  })
})
