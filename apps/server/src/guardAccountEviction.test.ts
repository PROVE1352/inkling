// A-F5 (0.25.4 security review, low confidence): the per-account backoff of two-step codes
// (`totp:<email>` in guard.ts acctFails) shares one map, capped at 20,000 keys with the oldest dropped
// first, with the sign-in failure keys that anyone can create with made-up emails. Someone who knows
// the victim's password and holds many /64s (one IPv6 /48) can push the victim's TOTP backoff out by
// failing 20,000 sign-ins, staying under the IP ban (9 per /64), and guess codes again at full speed.
//
// The fix (guard.ts, wired at merge): second-factor counters live in a map of their own, which only
// accounts whose password was right can fill. The map is chosen by the code (the failure reason or
// `secondFactor`), not by the key: a sign-in name is any string of 3+ characters, so "totp:…" names
// typed at the sign-in form must neither evict nor raise a two-step backoff.
// Run: cd apps/server && node ../../scripts/run-tests.mjs --test-name-pattern=TOTP
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { FastifyRequest } from 'fastify'

describe('guard: TOTP backoff under sign-in failure churn', () => {
  it('20,000 failed sign-ins with made-up emails from many /64s do not clear a TOTP backoff', async () => {
    const guard = await import('./guard')
    const { totpAccountKey } = await import('./twoFactor')
    const req = (ip: string) => ({ ip, log: { warn() {}, info() {} } }) as unknown as FastifyRequest
    const victim = totpAccountKey('victim-f5@example.com')

    // five wrong codes from one address: the next try has to wait
    for (let i = 0; i < 5; i++) await guard.recordFailure(req('2001:db8:f5:ffff::1'), 'totp', victim)
    assert.throws(() => guard.assertAccount(victim, { secondFactor: true }), /Too many requests/)

    // 20,000 sign-in failures, nine per /64 (under the ban at ten), each a different made-up account
    let n = 0
    for (let net = 0; n < 20_000; net++) {
      const ip = `2001:db8:f5:${net.toString(16)}::1`
      for (let i = 0; i < 9 && n < 20_000; i++, n++) await guard.recordFailure(req(ip), 'login', `nobody-${n}@example.com`)
    }
    assert.throws(() => guard.assertAccount(victim, { secondFactor: true }), /Too many requests/, 'the TOTP backoff was pushed out')
  })

  it('sign-in names that look like second-factor keys stay in the sign-in map', async () => {
    const guard = await import('./guard')
    const { totpAccountKey } = await import('./twoFactor')
    const req = (ip: string) => ({ ip, log: { warn() {}, info() {} } }) as unknown as FastifyRequest
    const victim = totpAccountKey('victim-f5b@example.com')
    for (let i = 0; i < 5; i++) await guard.recordFailure(req('2001:db8:f5b:ffff::1'), 'totp', victim)
    assert.throws(() => guard.assertAccount(victim, { secondFactor: true }), /Too many requests/)
    // 20,000 sign-in failures named "totp:…" (the sign-in schema takes any string of 3+ characters)
    let n = 0
    for (let net = 0; n < 20_000; net++) {
      const ip = `2001:db8:f5b:${net.toString(16)}::1`
      for (let i = 0; i < 9 && n < 20_000; i++, n++) await guard.recordFailure(req(ip), 'login', `totp:nobody-${n}@example.com`)
    }
    assert.throws(() => guard.assertAccount(victim, { secondFactor: true }), /Too many requests/, 'pushed out by totp:-named sign-ins')
    // and typing someone's "totp:<email>" at the sign-in form does not hold back their second factor
    const other = totpAccountKey('bystander-f5b@example.com')
    for (let i = 0; i < 8; i++) await guard.recordFailure(req('2001:db8:f5b:eeee::1'), 'login', other)
    assert.doesNotThrow(() => guard.assertAccount(other, { secondFactor: true }))
  })
})
