// Fetch limiter of article clips (docs/adr/2262-*): per minute, per person at once, per server at once.
import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { CLIP_FETCHES_GLOBAL, CLIP_FETCHES_PER_MINUTE, CLIP_FETCHES_PER_USER, _resetClipLimits, acquireClipFetch } from './limits'

describe('clip fetch limits', () => {
  afterEach(() => _resetClipLimits())
  const code = (fn: () => unknown) => {
    try {
      fn()
      return null
    } catch (e) {
      return (e as { code?: string; status?: number }).code
    }
  }

  it('a sliding minute per person', () => {
    const t = 1_000_000
    for (let i = 0; i < CLIP_FETCHES_PER_MINUTE; i++) acquireClipFetch('a', t + i)()
    assert.equal(code(() => acquireClipFetch('a', t + 30_000)), 'CLIP_RATE_LIMITED')
    assert.equal(code(() => acquireClipFetch('b', t + 30_000)()), null)
    assert.equal(code(() => acquireClipFetch('a', t + 60_001)()), null)
  })

  it('at once: per person and per server; release is idempotent', () => {
    const held = Array.from({ length: CLIP_FETCHES_PER_USER }, () => acquireClipFetch('a'))
    assert.equal(code(() => acquireClipFetch('a')), 'CLIP_RATE_LIMITED')
    held[0]()
    held[0]()
    const again = acquireClipFetch('a')
    assert.equal(code(() => acquireClipFetch('a')), 'CLIP_RATE_LIMITED')
    again()
    held[1]()
    const many = Array.from({ length: CLIP_FETCHES_GLOBAL }, (_, i) => acquireClipFetch(`u${i}`))
    assert.equal(code(() => acquireClipFetch('someone-else')), 'CLIP_RATE_LIMITED')
    for (const r of many) r()
    assert.equal(code(() => acquireClipFetch('someone-else')()), null)
  })
})
