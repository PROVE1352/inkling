// Usage counters per connection (docs/adr/1552-*) and the changes_since waiter registry
// (docs/adr/1551-*) without a database: frames, histogram, wait time left out of the latency,
// per-workspace rows, the mark-before-read rule, limits and release.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { BoundedLru } from './lru'
import {
  _resetUsage,
  connectionKeyOf,
  noteCacheHit,
  noteWait,
  noteWorkspaces,
  runMetered,
  usageFor,
  usageList,
  workspaceUsageFor,
} from './connectionUsage'
import {
  _resumeChangeWaits,
  activeChangeWaiters,
  CHANGE_WAITERS_PER_CONNECTION,
  changeMark,
  notifyChangesCommitted,
  releaseChangeWaiters,
  waitForChanges,
} from './context/changeWait'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('connection usage', () => {
  it('keys: grant, token, nothing for a browser session', () => {
    assert.equal(connectionKeyOf({ grantId: 'g' }), 'grant:g')
    assert.equal(connectionKeyOf({ tokenId: 't' }), 'token:t')
    assert.equal(connectionKeyOf({}), null)
  })

  it('a frame collects hits, waits and workspaces; the wait is not latency', async () => {
    _resetUsage()
    const measure = (r: string) => ({ tokens: r.length, error: false })
    await runMetered('grant:a', async () => {
      noteCacheHit()
      noteWorkspaces(['w1', 'w1', 'w2'])
      const t0 = Date.now()
      await sleep(120)
      noteWait(Date.now() - t0)
      return 'abcd'
    }, measure)
    await assert.rejects(runMetered('grant:a', async () => Promise.reject(new Error('x')), measure))
    const u = usageFor('grant:a')!
    assert.equal(u.calls, 2)
    assert.equal(u.errors, 1)
    assert.equal(u.tokens, 4)
    assert.equal(u.cacheHits, 1)
    assert.ok(u.waitMs >= 100)
    assert.ok(u.maxMs < 100, `latency ${u.maxMs}`)
    assert.ok(u.p95Ms > 0)
    assert.equal(workspaceUsageFor('w1', 'a')?.calls, 1)
    assert.equal(workspaceUsageFor('w3', 'a'), null)
    // outside a frame the notes are no-ops
    noteCacheHit()
    noteWait(5)
    assert.equal(usageList().length, 1)
  })

  it('tokens have no per-workspace rows', async () => {
    _resetUsage()
    await runMetered('token:t', async () => {
      noteWorkspaces(['w1'])
      return ''
    }, () => ({ tokens: 0, error: false }))
    assert.equal(usageFor('token:t')?.calls, 1)
    assert.equal(workspaceUsageFor('w1', 't'), null)
  })

  it('BoundedLru.peek and keys leave the recency order alone', () => {
    const l = new BoundedLru<number>(2, 60_000)
    l.set('a', 1)
    l.set('b', 2)
    assert.equal(l.peek('a'), 1)
    l.set('c', 3) // 'a' is still the oldest: peek did not touch it
    assert.deepEqual([...l.keys()], ['b', 'c'])
  })
})

describe('changes_since waiters', () => {
  it('a notification after the mark ends the wait at once; before it, it does not', async () => {
    const mark = changeMark(['w1'])
    notifyChangesCommitted(['w1'])
    assert.equal(await waitForChanges({ conn: 'c', workspaces: ['w1'], mark, until: Date.now() + 5_000 }), 'changed')
    const fresh = changeMark(['w1'])
    const t0 = Date.now()
    assert.equal(await waitForChanges({ conn: 'c', workspaces: ['w1'], mark: fresh, until: Date.now() + 150 }), 'timeout')
    assert.ok(Date.now() - t0 >= 140)
  })

  it('wakes only waiters of the notified workspaces (null = all)', async () => {
    const m = changeMark(['w1', 'w2'])
    const a = waitForChanges({ conn: 'c', workspaces: ['w1'], mark: m, until: Date.now() + 2_000 })!
    const b = waitForChanges({ conn: 'c', workspaces: ['w2'], mark: m, until: Date.now() + 300 })!
    notifyChangesCommitted(['w1'])
    assert.equal(await a, 'changed')
    assert.equal(await b, 'timeout')
    const c = waitForChanges({ conn: 'c', workspaces: ['w9'], mark: changeMark(['w9']), until: Date.now() + 2_000 })!
    notifyChangesCommitted(null)
    assert.equal(await c, 'changed')
    assert.equal(activeChangeWaiters(), 0)
  })

  it('per-connection limit, abort, release', async () => {
    const until = Date.now() + 5_000
    const ac = new AbortController()
    const held = Array.from({ length: CHANGE_WAITERS_PER_CONNECTION }, (_, i) =>
      waitForChanges({ conn: 'x', workspaces: null, mark: changeMark(null), until, signal: i === 0 ? ac.signal : undefined })!,
    )
    assert.equal(waitForChanges({ conn: 'x', workspaces: null, mark: changeMark(null), until }), null)
    ac.abort()
    assert.equal(await held[0], 'aborted')
    releaseChangeWaiters()
    assert.deepEqual(await Promise.all(held.slice(1)), held.slice(1).map(() => 'released'))
    assert.equal(waitForChanges({ conn: 'y', workspaces: null, mark: changeMark(null), until }), null)
    _resumeChangeWaits()
    assert.equal(activeChangeWaiters(), 0)
  })
})
