// Run: cd apps/server && npx tsx --test src/safeFetch.test.ts
import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, describe, it } from 'node:test'
import { embeddedIPv4, isBlockedAddress, resolvePublic, safeFetch, SafeFetchError, validateUrl } from './safeFetch'

async function rejectsWith(p: Promise<unknown> | (() => unknown), code: string) {
  try {
    await (typeof p === 'function' ? p() : p)
  } catch (e) {
    assert.ok(e instanceof SafeFetchError, `expected SafeFetchError, got ${String(e)}`)
    assert.equal(e.code, code, `expected ${code}, got ${e.code} (${e.message})`)
    return
  }
  assert.fail(`expected rejection with ${code}`)
}

describe('isBlockedAddress', () => {
  const blocked = [
    '127.0.0.1',
    '127.255.255.254',
    '0.0.0.0',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '100.127.255.255',
    '224.0.0.1',
    '255.255.255.255',
    '198.18.0.1',
    '::',
    '::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:169.254.169.254',
    '::ffff:10.0.0.1',
    '::ffff:8.8.8.8', // mapped addresses are never contacted directly
    '::127.0.0.1',
    '64:ff9b::a9fe:a9fe',
    '2002:7f00:1::',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'fe80::1%lo0',
    'ff02::1',
    '2001:db8::1',
    'not-an-ip',
  ]
  for (const ip of blocked) it(`blocks ${ip}`, () => assert.equal(isBlockedAddress(ip), true))
  const allowed = ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '100.128.0.1', '2606:4700:4700::1111', '2a00:1450:4001::1']
  for (const ip of allowed) it(`allows ${ip}`, () => assert.equal(isBlockedAddress(ip), false))

  it('extracts embedded IPv4', () => {
    assert.equal(embeddedIPv4('::ffff:7f00:1'), '127.0.0.1')
    assert.equal(embeddedIPv4('::ffff:169.254.169.254'), '169.254.169.254')
    assert.equal(embeddedIPv4('64:ff9b::0a00:0001'), '10.0.0.1')
    assert.equal(embeddedIPv4('2002:0a00:0001::'), '10.0.0.1')
    assert.equal(embeddedIPv4('2606:4700::1'), null)
  })
})

describe('validateUrl', () => {
  it('rejects 127.0.0.1', () => rejectsWith(() => validateUrl('https://127.0.0.1/'), 'blocked_address'))
  it('rejects [::1]', () => rejectsWith(() => validateUrl('https://[::1]/'), 'blocked_address'))
  it('rejects cloud metadata', () => rejectsWith(() => validateUrl('https://169.254.169.254/latest/meta-data/'), 'blocked_address'))
  it('rejects 10.x', () => rejectsWith(() => validateUrl('https://10.0.0.5/'), 'blocked_address'))
  it('rejects 0.0.0.0', () => rejectsWith(() => validateUrl('https://0.0.0.0/'), 'blocked_address'))
  it('rejects IPv4-mapped IPv6', () => rejectsWith(() => validateUrl('https://[::ffff:127.0.0.1]/'), 'blocked_address'))
  it('rejects IPv4-mapped IPv6 hex form', () => rejectsWith(() => validateUrl('https://[::ffff:a9fe:a9fe]/'), 'blocked_address'))
  it('rejects decimal IP 2130706433', () => rejectsWith(() => validateUrl('https://2130706433/'), 'blocked_address'))
  it('rejects hex IP 0x7f000001', () => rejectsWith(() => validateUrl('https://0x7f000001/'), 'blocked_address'))
  it('rejects octal IP 0177.0.0.1', () => rejectsWith(() => validateUrl('https://0177.0.0.1/'), 'blocked_address'))
  it('rejects short IP 127.1', () => rejectsWith(() => validateUrl('https://127.1/'), 'blocked_address'))
  it('rejects decimal metadata IP 2852039166', () => rejectsWith(() => validateUrl('https://2852039166/'), 'blocked_address'))
  it('rejects localhost by name', () => rejectsWith(() => validateUrl('https://localhost/'), 'blocked_address'))
  it('rejects foo.localhost', () => rejectsWith(() => validateUrl('https://foo.localhost./'), 'blocked_address'))
  it('rejects http by default', () => rejectsWith(() => validateUrl('http://example.com/'), 'scheme_not_allowed'))
  it('rejects file:', () => rejectsWith(() => validateUrl('file:///etc/passwd'), 'scheme_not_allowed'))
  it('rejects gopher:', () => rejectsWith(() => validateUrl('gopher://example.com/'), 'scheme_not_allowed'))
  it('rejects credentials', () => rejectsWith(() => validateUrl('https://u:p@example.com/'), 'credentials_in_url'))
  it('rejects odd ports', () => rejectsWith(() => validateUrl('https://example.com:6379/'), 'port_not_allowed'))
  it('allows http when opted in', () => assert.equal(validateUrl('http://example.com/', { allowHttp: true }).host, 'example.com'))
  it('enforces host allowlist', () => {
    const o = { allowedHosts: ['hooks.slack.com', '*.example.org'] }
    assert.ok(validateUrl('https://hooks.slack.com/services/x', o))
    assert.ok(validateUrl('https://a.example.org/', o))
    return rejectsWith(() => validateUrl('https://example.org.evil.com/', o), 'host_not_allowed')
  })
  it('wildcard does not match apex', () =>
    rejectsWith(() => validateUrl('https://example.org/', { allowedHosts: ['*.example.org'] }), 'host_not_allowed'))
  it('enforces path prefix', () =>
    rejectsWith(
      () => validateUrl('https://discord.com/channels/1', { allowedHosts: ['discord.com'], allowedPathPrefixes: ['/api/webhooks/'] }),
      'host_not_allowed',
    ))
  it('test loopback flag still blocks non-loopback private', () =>
    rejectsWith(() => validateUrl('http://10.0.0.1/', { unsafeAllowLoopbackForTests: true }), 'blocked_address'))
})

describe('resolvePublic (DNS path)', () => {
  it('rejects a hostname resolving to loopback', () => rejectsWith(resolvePublic('localhost'), 'blocked_address'))
  it('fails on NXDOMAIN', () => rejectsWith(resolvePublic('does-not-exist.invalid'), 'dns_failed'))
})

describe('safeFetch against a local server (test loopback mode)', () => {
  let server: http.Server
  let base = ''
  const T = { unsafeAllowLoopbackForTests: true }
  before(async () => {
    server = http.createServer((req, res) => {
      const u = new URL(req.url ?? '/', 'http://x')
      if (u.pathname === '/ok') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        return res.end('<title>hi</title>')
      }
      if (u.pathname === '/to-metadata') {
        res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' })
        return res.end()
      }
      if (u.pathname === '/to-private') {
        res.writeHead(301, { location: 'https://10.0.0.1/' })
        return res.end()
      }
      if (u.pathname === '/to-decimal') {
        res.writeHead(302, { location: 'http://2852039166/' })
        return res.end()
      }
      if (u.pathname === '/to-file') {
        res.writeHead(302, { location: 'file:///etc/passwd' })
        return res.end()
      }
      if (u.pathname === '/loop') {
        res.writeHead(302, { location: '/loop' })
        return res.end()
      }
      if (u.pathname === '/hop') {
        res.writeHead(302, { location: '/ok' })
        return res.end()
      }
      if (u.pathname === '/big') {
        res.writeHead(200, { 'content-type': 'text/html' })
        res.write('x'.repeat(5000))
        return res.end('y'.repeat(5000))
      }
      if (u.pathname === '/json') {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end('{}')
      }
      if (u.pathname === '/slow') {
        res.writeHead(200, { 'content-type': 'text/html' })
        res.write('a')
        setTimeout(() => res.end('b'), 2000)
        return
      }
      res.writeHead(404)
      res.end()
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  after(() => server.close())

  it('without the test flag, the local server is blocked', () => rejectsWith(safeFetch(`${base}/ok`, { allowHttp: true, allowedPorts: [80, 443, Number(new URL(base).port)] }), 'blocked_address'))
  it('fetches /ok', async () => {
    const r = await safeFetch(`${base}/ok`, T)
    assert.equal(r.status, 200)
    assert.equal(r.contentType, 'text/html')
    assert.equal(r.body.toString(), '<title>hi</title>')
  })
  it('follows a same-host redirect', async () => {
    const r = await safeFetch(`${base}/hop`, T)
    assert.equal(r.status, 200)
    assert.equal(r.redirects, 1)
    assert.ok(r.url.endsWith('/ok'))
  })
  it('blocks redirect to 169.254.169.254', () => rejectsWith(safeFetch(`${base}/to-metadata`, T), 'blocked_address'))
  it('blocks redirect to 10.x', () => rejectsWith(safeFetch(`${base}/to-private`, T), 'blocked_address'))
  it('blocks redirect to decimal IP', () => rejectsWith(safeFetch(`${base}/to-decimal`, T), 'blocked_address'))
  it('blocks redirect to file:', () => rejectsWith(safeFetch(`${base}/to-file`, T), 'scheme_not_allowed'))
  it('caps redirects', () => rejectsWith(safeFetch(`${base}/loop`, T), 'too_many_redirects'))
  it('size cap throws by default', () => rejectsWith(safeFetch(`${base}/big`, { ...T, maxBytes: 1000 }), 'too_large'))
  it('size cap truncates when asked', async () => {
    const r = await safeFetch(`${base}/big`, { ...T, maxBytes: 1000, truncate: true })
    assert.equal(r.truncated, true)
    assert.equal(r.body.length, 1000)
  })
  it('checks content type', () => rejectsWith(safeFetch(`${base}/json`, { ...T, allowedContentTypes: ['text/html'] }), 'content_type'))
  it('enforces total timeout', () => rejectsWith(safeFetch(`${base}/slow`, { ...T, timeoutMs: 300 }), 'timeout'))
  it('ignores the test flag in production', async () => {
    const prev = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    try {
      await rejectsWith(safeFetch(`${base}/ok`, T), 'scheme_not_allowed')
    } finally {
      if (prev === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = prev
    }
  })
})
