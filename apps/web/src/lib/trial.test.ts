// Trial accounts (docs/adr/2555-*): the button waits until the screen has been up 2 s before it sends
// (a quick click must not get 400 SIGNUP_CHECK_FAILED), the badge's hours, the error keys, the landing.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { hoursLeft, TRIAL_MIN_FORM_MS, trialDelayMs, trialErrorKey, trialFormMs, trialLandingPath } from './trial'

describe('trial button: waiting for the bot check', () => {
  it('a click before 2 s waits for the rest; after it, at once', () => {
    const shown = 1_000_000
    assert.equal(trialDelayMs(shown, shown), 2_050)
    assert.equal(trialDelayMs(shown, shown + 300), 1_750)
    assert.equal(trialDelayMs(shown, shown + 2_049), 1)
    assert.equal(trialDelayMs(shown, shown + 2_050), 0)
    assert.equal(trialDelayMs(shown, shown + 60_000), 0)
  })

  it('whenever the click comes, what is sent after the wait passes the server check (formMs ≥ 2000)', () => {
    const shown = 5_000
    for (const clickAfter of [0, 1, 500, 1_999, 2_000, 2_001, 10_000]) {
      const click = shown + clickAfter
      const sentAt = click + trialDelayMs(shown, click)
      assert.ok(trialFormMs(shown, sentAt) >= TRIAL_MIN_FORM_MS, `click after ${clickAfter} ms`)
    }
  })

  it('a clock that went backwards still waits, never sends a negative formMs', () => {
    assert.equal(trialDelayMs(10_000, 9_000), 3_050)
    assert.equal(trialFormMs(10_000, 9_000), 0)
  })
})

describe('trial badge: hours left', () => {
  const now = Date.parse('2026-11-24T12:00:00Z')
  it('rounds up, so a new account reads 24 and the last hour reads 1', () => {
    assert.equal(hoursLeft('2026-11-25T12:00:00Z', now), 24)
    assert.equal(hoursLeft('2026-11-25T11:59:00Z', now), 24)
    assert.equal(hoursLeft('2026-11-24T13:00:00Z', now), 1)
    assert.equal(hoursLeft('2026-11-24T12:00:01Z', now), 1)
  })
  it('0 once the time has passed (never negative); null for a bad date', () => {
    assert.equal(hoursLeft('2026-11-24T12:00:00Z', now), 0)
    assert.equal(hoursLeft('2026-11-24T10:00:00Z', now), 0)
    assert.equal(hoursLeft('not a date', now), null)
  })
})

describe('trial errors and landing', () => {
  it('trial codes have their own text; others fall back to the usual error text', () => {
    assert.equal(trialErrorKey('TRIAL_RESTRICTED'), 'errors.TRIAL_RESTRICTED')
    assert.equal(trialErrorKey('TRIAL_FULL'), 'errors.TRIAL_FULL')
    assert.equal(trialErrorKey('ALREADY_SIGNED_IN'), 'errors.ALREADY_SIGNED_IN')
    assert.equal(trialErrorKey('SIGNUP_IP_LIMIT'), null)
  })
  it('lands on the sample page, or the workspace without one', () => {
    assert.equal(trialLandingPath({ workspaceId: 'w', samplePageId: 'p' }), '/w/w/p/p')
    assert.equal(trialLandingPath({ workspaceId: 'w', samplePageId: null }), '/w/w')
  })
})
