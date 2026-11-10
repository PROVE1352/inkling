import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { api, OfflineError } from './api'
import { setLocaleChoice } from './i18n'
import { isNetworkError } from './lib/offline/runtime'

// A request that gets no answer (0.18 integration): one "no connection" error every screen can show,
// still a TypeError so the offline fallbacks (offline.isNetworkError) keep working.
const realFetch = globalThis.fetch

describe('api(): no answer at all', () => {
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  it('a fetch that rejects with a TypeError becomes OfflineError with the localized text', async () => {
    setLocaleChoice('en')
    globalThis.fetch = (async () => {
      throw new TypeError('Failed to fetch')
    }) as typeof fetch
    const err = await api('/api/x').then(
      () => null,
      (e: unknown) => e,
    )
    assert.ok(err instanceof OfflineError)
    assert.ok(err instanceof TypeError)
    assert.equal(isNetworkError(err), true)
    assert.equal((err as Error).message, 'No connection. Try again when you are back online.')
    assert.equal(String(err), 'No connection. Try again when you are back online.')
  })

  it('an abort stays an abort', async () => {
    globalThis.fetch = (async () => {
      throw new DOMException('aborted', 'AbortError')
    }) as typeof fetch
    const err = await api('/api/x').then(
      () => null,
      (e: unknown) => e,
    )
    assert.ok(err instanceof DOMException)
    assert.equal((err as DOMException).name, 'AbortError')
  })
})
