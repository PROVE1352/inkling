// Address keys of the sign-up limit and the global request limit (0.22 security fix F6, contract §14,
// docs/adr/2537-*): IPv6 counted per /56 for sign-ups and per /64 for the request limit; IPv4-mapped
// IPv6 counted as the IPv4 address; personal API tokens keep their own bucket.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { FastifyRequest } from 'fastify'
import { ipPrefixKey, signupIpKey } from './ipPrefix'
import { rateLimitKey } from './rateLimitKey'

describe('ipPrefixKey', () => {
  it('IPv6 per /64 and per /56, with the fourth group padded before its top byte is taken', () => {
    assert.equal(ipPrefixKey('2001:db8:1:2::1', 64), '2001:db8:1:2::/64')
    assert.equal(ipPrefixKey('2001:0db8:0001:0002:aaaa:bbbb:cccc:dddd', 64), '2001:db8:1:2::/64')
    assert.equal(ipPrefixKey('2001:db8:1:2::1', 56), '2001:db8:1:0::/56')
    assert.equal(ipPrefixKey('2001:db8:1:ab::1', 56), '2001:db8:1:0::/56') // 0x00ab: top byte 0x00
    assert.equal(ipPrefixKey('2001:db8:1:abcd::1', 56), '2001:db8:1:ab00::/56')
    assert.equal(ipPrefixKey('2001:db8:1:ff::1', 56), ipPrefixKey('2001:db8:1:1::9', 56)) // one /56 holds 256 /64s
    assert.notEqual(ipPrefixKey('2001:db8:1:100::1', 56), ipPrefixKey('2001:db8:1:ff::1', 56))
    assert.equal(ipPrefixKey('::1', 64), '0:0:0:0::/64')
    assert.equal(ipPrefixKey('fe80::1%en0', 64), 'fe80:0:0:0::/64')
  })

  it('IPv4 as is; IPv4-mapped IPv6 (dotted or hex) as its IPv4 address', () => {
    assert.equal(ipPrefixKey('198.51.100.7', 56), '198.51.100.7')
    assert.equal(ipPrefixKey('::ffff:198.51.100.7', 56), '198.51.100.7')
    assert.equal(ipPrefixKey('::FFFF:198.51.100.7', 64), '198.51.100.7')
    assert.equal(ipPrefixKey('::ffff:c633:6407', 64), '198.51.100.7')
    assert.equal(ipPrefixKey('0:0:0:0:0:ffff:c633:6407', 56), '198.51.100.7')
  })

  it('anything else is returned unchanged', () => {
    assert.equal(ipPrefixKey('', 64), '')
    assert.equal(ipPrefixKey('not-an-ip', 56), 'not-an-ip')
  })

  it('signupIpKey is the /56 key', () => {
    assert.equal(signupIpKey('2001:db8:9:3::1'), signupIpKey('2001:db8:9:4::1'))
    assert.equal(signupIpKey('2001:db8:9:3::1'), '2001:db8:9:0::/56')
  })
})

describe('rateLimitKey (the global request limit)', () => {
  const r = (ip: string, auth?: string) => ({ ip, headers: auth ? { authorization: auth } : {} }) as unknown as FastifyRequest
  it('IPv6 addresses of one /64 share a bucket; the next /64 has its own', () => {
    assert.equal(rateLimitKey(r('2001:db8:1:2::1')), rateLimitKey(r('2001:db8:1:2:ffff::9')))
    assert.equal(rateLimitKey(r('2001:db8:1:2::1')), '2001:db8:1:2::/64')
    assert.notEqual(rateLimitKey(r('2001:db8:1:2::1')), rateLimitKey(r('2001:db8:1:3::1')))
  })
  it('IPv4 unchanged, IPv4-mapped as IPv4, personal API tokens their own bucket', () => {
    assert.equal(rateLimitKey(r('203.0.113.9')), '203.0.113.9')
    assert.equal(rateLimitKey(r('::ffff:203.0.113.9')), '203.0.113.9')
    assert.match(rateLimitKey(r('2001:db8::1', `Bearer ink_pat_${'a'.repeat(43)}`)), /^pat:/)
  })
})
