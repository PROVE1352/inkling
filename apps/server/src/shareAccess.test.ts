// Unlock cookies, expiry and file cache lifetimes of public links (docs/adr/1170-*, 1171-*).
process.env.APP_SECRET_KEY ||= 'test-app-secret-key-0123456789-abcdefghij'

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

describe('share link gate', async () => {
  const { publicFileCacheControl, shareExpired, shareGated, shareNotStarted, unlockCookieValue, verifyUnlockCookie, SHARE_UNLOCK_TTL_MS } =
    await import('./shareAccess')
  const { assertShareWindow, resolveShareExpiry, resolveShareStart, shareLinkFields } = await import('./shareSettings')

  const now = Date.UTC(2026, 10, 7, 12, 0, 0)
  const gate = { tokenHash: 'a'.repeat(64), expiresAt: null as Date | null, passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$x$y' }

  it('a cookie opens only the link and password it was made for, until it runs out', () => {
    const { value, expires } = unlockCookieValue(gate, now)
    assert.equal(expires.getTime(), Math.floor((now + SHARE_UNLOCK_TTL_MS) / 1000) * 1000)
    assert.equal(verifyUnlockCookie(gate, value, now), true)
    assert.equal(verifyUnlockCookie(gate, value, now + SHARE_UNLOCK_TTL_MS + 1000), false)
    assert.equal(verifyUnlockCookie({ ...gate, tokenHash: 'b'.repeat(64) }, value, now), false)
    assert.equal(verifyUnlockCookie({ ...gate, passwordHash: gate.passwordHash + 'z' }, value, now), false)
    assert.equal(verifyUnlockCookie({ ...gate, passwordHash: null }, value, now), false)
    for (const bad of ['', 'v1', 'v2.1.x', `${value}x`, value.replace('v1.', 'v1.9'), 'v1.99999999999.' + 'A'.repeat(43)]) {
      assert.equal(verifyUnlockCookie(gate, bad, now), false, bad)
    }
  })

  it('a cookie never outlives the link', () => {
    const soon = { ...gate, expiresAt: new Date(now + 3_600_000) }
    const { expires } = unlockCookieValue(soon, now)
    assert.equal(expires.getTime(), now + 3_600_000)
  })

  it('expiry is "at or after", on the given clock', () => {
    const g = { expiresAt: new Date(now) }
    assert.equal(shareExpired(g, now - 1), false)
    assert.equal(shareExpired(g, now), true)
    assert.equal(shareExpired({ expiresAt: null }, now), false)
  })

  it('file cache lifetime: five minutes, capped by the expiry, browser-only with a password', () => {
    const open = { ...gate, passwordHash: null }
    assert.equal(publicFileCacheControl(open, now), 'public, max-age=300')
    assert.equal(publicFileCacheControl({ ...open, expiresAt: new Date(now + 60_000) }, now), 'public, max-age=60')
    assert.equal(publicFileCacheControl({ ...open, expiresAt: new Date(now - 1) }, now), 'no-store')
    assert.equal(publicFileCacheControl(gate, now), 'private, max-age=300')
  })

  it('requested expiry: day counts on the server clock, instants in the future only', () => {
    assert.equal(resolveShareExpiry({}, now), undefined)
    assert.equal(resolveShareExpiry({ expiresAt: null }, now), null)
    assert.equal(resolveShareExpiry({ expiresInDays: 7 }, now)?.getTime(), now + 7 * 86_400_000)
    const at = new Date(now + 86_400_000).toISOString()
    assert.equal(resolveShareExpiry({ expiresAt: at }, now)?.toISOString(), at)
    assert.throws(() => resolveShareExpiry({ expiresAt: new Date(now - 1000).toISOString() }, now), /future/)
    assert.throws(() => resolveShareExpiry({ expiresAt: new Date(now + 3651 * 86_400_000).toISOString() }, now), /ten years/)
    assert.deepEqual(shareLinkFields({ shareExpiresAt: new Date(now - 1), sharePasswordHash: 'h' }, now), {
      expiresAt: new Date(now - 1).toISOString(),
      expired: true,
      hasPassword: true,
      startsAt: null,
      notStarted: false,
      // the Markdown download is off unless the row says otherwise (docs/adr/2362-*)
      allowDownload: false,
      // and so are charts (docs/adr/2440-*)
      includeCharts: false,
    })
  })

  it('scheduled start (docs/adr/1844-*): future only matters, before the expiry, gated until then', () => {
    assert.equal(resolveShareStart({}, now), undefined)
    assert.equal(resolveShareStart({ startsAt: null }, now), null)
    // a start already past is "at once"
    assert.equal(resolveShareStart({ startsAt: new Date(now - 1000).toISOString() }, now), null)
    const at = new Date(now + 3_600_000)
    assert.equal(resolveShareStart({ startsAt: at.toISOString() }, now)?.getTime(), at.getTime())
    assert.throws(() => resolveShareStart({ startsAt: new Date(now + 3651 * 86_400_000).toISOString() }, now), /ten years/)
    assert.throws(() => assertShareWindow(at, new Date(at.getTime())), /before the expiry/)
    assert.doesNotThrow(() => assertShareWindow(at, null))
    assert.doesNotThrow(() => assertShareWindow(null, new Date(now)))
    const open = { ...gate, passwordHash: null }
    assert.equal(shareNotStarted({ startsAt: at }, now), true)
    assert.equal(shareNotStarted({ startsAt: new Date(now) }, now), false)
    assert.equal(shareNotStarted({ startsAt: null }, now), false)
    assert.equal(shareGated({ ...open, startsAt: at }, now), true)
    assert.equal(shareGated({ ...open, startsAt: null }, now), false)
    const f = shareLinkFields({ shareExpiresAt: null, sharePasswordHash: null, shareStartsAt: at }, now)
    assert.equal(f.notStarted, true)
    assert.equal(f.startsAt, at.toISOString())
  })
})
