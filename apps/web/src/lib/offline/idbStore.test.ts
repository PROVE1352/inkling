// @ts-nocheck — Node test file (node:test types are not part of the web tsconfig); not bundled.
// The IndexedDB open time limit: a browser whose indexedDB.open never answers must not keep a page
// on "Connecting…" (the page opens from the server), and a late answer must not leave a handle open.
import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { _setOpenTimeoutForTests, createIdbStore, OPEN_TIMEOUT_MS } from './idbStore'
import { OfflineStoreError } from './store'

type FakeDb = { closed: boolean; close(): void; onversionchange: null | (() => void); onclose: null | (() => void) }
type FakeReq = { result?: FakeDb; error?: unknown; onsuccess?: () => void; onerror?: () => void; onblocked?: () => void; onupgradeneeded?: () => void }

function fakeDb(): FakeDb {
  return {
    closed: false,
    close() {
      this.closed = true
    },
    onversionchange: null,
    onclose: null,
  }
}

/** A fake `indexedDB` whose opens answer as `answer(req)` says (or never, when it does nothing). */
function installFake(answer: (req: FakeReq, n: number) => void) {
  const requests: FakeReq[] = []
  globalThis.indexedDB = {
    open() {
      const req: FakeReq = {}
      requests.push(req)
      const n = requests.length
      setTimeout(() => answer(req, n), 0)
      return req
    },
  }
  return requests
}

const succeed = (req: FakeReq) => {
  req.result = fakeDb()
  req.onsuccess?.()
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('IndexedDB open time limit', () => {
  afterEach(() => {
    delete globalThis.indexedDB
    _setOpenTimeoutForTests(null)
  })

  it('is 5 seconds by default', () => {
    assert.equal(OPEN_TIMEOUT_MS, 5000)
  })

  it('an open that never answers rejects as unavailable after the limit', async () => {
    _setOpenTimeoutForTests(30)
    installFake(() => {})
    const t0 = Date.now()
    await assert.rejects(createIdbStore(), (err) => err instanceof OfflineStoreError && err.kind === 'unavailable' && /did not answer/.test(err.message))
    assert.ok(Date.now() - t0 < 1000)
  })

  it('a success after the limit closes that handle instead of keeping it', async () => {
    _setOpenTimeoutForTests(20)
    let late: FakeReq | null = null
    installFake((req) => {
      late = req
    })
    await assert.rejects(createIdbStore())
    succeed(late)
    assert.equal(late.result.closed, true, 'the late handle is closed (it would hold off deleteDatabase)')
  })

  it('an error or a success inside the limit is not overridden by the timer', async () => {
    _setOpenTimeoutForTests(40)
    installFake((req) => {
      req.error = Object.assign(new Error('x'), { name: 'InvalidStateError' })
      req.onerror?.()
    })
    await assert.rejects(createIdbStore(), (err) => err.kind === 'unavailable' && /InvalidStateError/.test(err.message))
    installFake(succeed)
    const store = await createIdbStore()
    await sleep(60)
    assert.ok(store, 'resolved, and the timer firing later changes nothing')
  })

  it('after a timed-out open the next attempt opens normally', async () => {
    _setOpenTimeoutForTests(20)
    installFake(() => {})
    await assert.rejects(createIdbStore())
    installFake(succeed)
    assert.ok(await createIdbStore())
  })

  it('a reopen that times out is not kept: the next write reopens', async () => {
    _setOpenTimeoutForTests(20)
    // 1st open answers; the handle is then closed by the browser; 2nd open hangs; 3rd answers
    const reqs = installFake((req, n) => {
      if (n !== 2) succeed(req)
    })
    const store = await createIdbStore()
    reqs[0].result.onclose()
    await assert.rejects(store.owner(), (err) => err instanceof OfflineStoreError && err.kind === 'unavailable')
    // the third open answers; the store reaches the database again (the fake has no transactions,
    // so the call fails past the open, not with the timeout)
    await assert.rejects(store.owner(), (err) => !/did not answer/.test(String(err.message)))
    assert.equal(reqs.length, 3, 'a new open was made instead of reusing the failed one')
  })
})
