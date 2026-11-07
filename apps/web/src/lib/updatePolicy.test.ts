// @ts-nocheck — Node test file (node:test types are not part of the web tsconfig); not bundled.
// Update policy (docs/adr/0991-*, 0992-*).
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  AUTO_RELOAD_COOLDOWN_MS,
  BOOT_WINDOW_MS,
  FORCE_MAX_WAIT_MS,
  IDLE_MS,
  forceDecision,
  inCooldown,
  isBuildMismatch,
  normalizeMode,
} from './updatePolicy'

describe('isBuildMismatch', () => {
  it('flags a different server build', () => {
    assert.equal(isBuildMismatch('abc123', 'def456'), true)
    assert.equal(isBuildMismatch('abc123', 'abc123'), false)
  })
  it('never flags when either side is unknown or dev', () => {
    for (const s of [null, undefined, '', 'dev']) assert.equal(isBuildMismatch('abc123', s), false)
    assert.equal(isBuildMismatch('dev', 'abc123'), false)
    assert.equal(isBuildMismatch('', 'abc123'), false)
  })
})

describe('normalizeMode', () => {
  it('defaults to prompt', () => {
    assert.equal(normalizeMode('force'), 'force')
    for (const v of ['prompt', 'FORCE', undefined, null, 1]) assert.equal(normalizeMode(v), 'prompt')
  })
})

describe('inCooldown', () => {
  it('blocks a second automatic reload inside the window only', () => {
    const now = 1_000_000_000
    assert.equal(inCooldown(0, now), false)
    assert.equal(inCooldown(now - 1000, now), true)
    assert.equal(inCooldown(now - AUTO_RELOAD_COOLDOWN_MS, now), false)
    assert.equal(inCooldown(now + 5000, now), false) // clock moved back: ignore
  })
})

describe('forceDecision', () => {
  const t0 = 1_000_000_000
  const base = {
    now: t0 + 60_000,
    bootAt: t0,
    userActed: true,
    lastActivityAt: t0 + 60_000 - IDLE_MS - 1,
    collabPending: false,
    mutating: false,
    waitingSince: t0 + 50_000,
  }

  it('reloads an untouched tab right after load, even mid initial sync', () => {
    assert.equal(
      forceDecision({ ...base, now: t0 + 2000, userActed: false, collabPending: true, waitingSince: t0 + 2000 }),
      'reload',
    )
    assert.equal(
      forceDecision({ ...base, now: t0 + BOOT_WINDOW_MS + 1, userActed: false, collabPending: true }),
      'wait',
    )
  })

  it('reloads when synced, nothing in flight and the user is idle', () => {
    assert.equal(forceDecision(base), 'reload')
  })

  it('waits for collab acks, mutations and idleness', () => {
    assert.equal(forceDecision({ ...base, collabPending: true }), 'wait')
    assert.equal(forceDecision({ ...base, mutating: true }), 'wait')
    assert.equal(forceDecision({ ...base, lastActivityAt: base.now - 100 }), 'wait')
  })

  it('gives up (banner) after the maximum wait', () => {
    assert.equal(
      forceDecision({ ...base, collabPending: true, waitingSince: base.now - FORCE_MAX_WAIT_MS }),
      'give-up',
    )
  })
})
