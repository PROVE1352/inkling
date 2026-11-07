// Heavy-job gate (docs/adr/1240-*, KNOWN-ISSUES B-M9): cap, queue, fairness, refusals, status.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { AppError } from './errors'
import { HeavyJobGate, readHeavyJobLimits } from './heavyJobs'
import type { HeavyJobRelease } from './heavyJobs'

const limits = (o: Partial<ReturnType<typeof readHeavyJobLimits>> = {}) => ({ max: 1, queueMax: 8, waitMs: 5_000, perUser: 3, ...o })
const flush = () => new Promise((r) => setImmediate(r))

describe('heavy-job gate', () => {
  it('reads its limits from the environment, with defaults', () => {
    assert.deepEqual(readHeavyJobLimits({}), { max: 2, queueMax: 16, waitMs: 60_000, perUser: 2 })
    assert.deepEqual(
      readHeavyJobLimits({ HEAVY_JOBS_MAX: '1', HEAVY_JOBS_QUEUE_MAX: '0', HEAVY_JOBS_WAIT_MS: '250', HEAVY_JOBS_PER_USER: '4' }),
      { max: 1, queueMax: 0, waitMs: 250, perUser: 4 },
    )
    assert.deepEqual(readHeavyJobLimits({ HEAVY_JOBS_MAX: '0', HEAVY_JOBS_WAIT_MS: 'x' }), { max: 2, queueMax: 16, waitMs: 60_000, perUser: 2 })
  })

  it('runs at most `max` jobs; the next one starts when a slot is released', async () => {
    const g = new HeavyJobGate(limits({ max: 2 }))
    const a = await g.acquire('u1', 'import')
    const b = await g.acquire('u2', 'export-zip')
    let started = false
    const c = g.acquire('u3', 'duplicate').then((r) => ((started = true), r))
    await flush()
    assert.equal(started, false)
    assert.deepEqual([g.status().running, g.status().queued], [2, 1])
    assert.deepEqual(g.status().byKind.duplicate, { running: 0, queued: 1 })
    a()
    a() // idempotent: frees one slot only
    const rc = await c
    assert.equal(started, true)
    assert.deepEqual([g.status().running, g.status().queued], [2, 0])
    b()
    rc()
    assert.equal(g.status().running, 0)
    assert.equal(g.status().totals.started, 3)
  })

  it('a free slot goes to the person served longest ago, not to the one with the longest queue', async () => {
    const g = new HeavyJobGate(limits({ max: 1, perUser: 5 }))
    const order: string[] = []
    const releases = new Map<string, HeavyJobRelease>()
    const first = await g.acquire('alice', 'export-zip')
    const wait = (label: string, user: string) =>
      void g.acquire(user, 'export-zip').then((r) => {
        order.push(label)
        releases.set(label, r)
      })
    wait('alice2', 'alice')
    wait('alice3', 'alice')
    wait('bob1', 'bob')
    wait('carol1', 'carol')
    wait('alice4', 'alice')
    await flush()
    let current = first
    for (let i = 0; i < 5; i++) {
      current()
      while (order.length === i) await flush()
      current = releases.get(order[i])!
    }
    current()
    assert.deepEqual(order, ['bob1', 'carol1', 'alice2', 'alice3', 'alice4'])
    assert.equal(g.status().running, 0)
  })

  it('refuses a person over the per-user cap at once with 429 and Retry-After', async () => {
    const g = new HeavyJobGate(limits({ max: 1, perUser: 2, waitMs: 30_000 }))
    const a = await g.acquire('u1', 'import')
    const queued = g.acquire('u1', 'import')
    await assert.rejects(g.acquire('u1', 'duplicate'), (e: unknown) => {
      assert.ok(e instanceof AppError)
      assert.equal(e.status, 429)
      assert.equal(e.code, 'HEAVY_JOBS_PER_USER')
      assert.equal(e.retryAfter, 30)
      return true
    })
    // someone else is still queued normally, and goes first: u1 was served, u2 not yet
    const other = g.acquire('u2', 'import')
    a()
    ;(await other)()
    ;(await queued)()
    assert.equal(g.status().totals.perUser, 1)
  })

  it('refuses with 503 when the queue is full, and when no slot frees up within waitMs', async () => {
    const g = new HeavyJobGate(limits({ max: 1, queueMax: 1, waitMs: 40 }))
    const a = await g.acquire('u1', 'import')
    const waiting = g.acquire('u2', 'import')
    await assert.rejects(g.acquire('u3', 'import'), (e: unknown) => e instanceof AppError && e.status === 503 && e.code === 'HEAVY_JOBS_BUSY' && e.retryAfter === 1)
    await assert.rejects(waiting, (e: unknown) => e instanceof AppError && e.status === 503 && e.code === 'HEAVY_JOBS_BUSY')
    assert.deepEqual([g.status().running, g.status().queued, g.status().totals.busy], [1, 0, 2])
    a()
    assert.equal(g.status().running, 0)
  })

  it('a waiter whose client went away leaves the queue without running', async () => {
    const g = new HeavyJobGate(limits({ max: 1 }))
    const a = await g.acquire('u1', 'import')
    const ac = new AbortController()
    const gone = g.acquire('u2', 'export-zip', ac.signal)
    const next = g.acquire('u3', 'duplicate')
    ac.abort()
    await assert.rejects(gone, { code: 'CLIENT_CLOSED_REQUEST' })
    assert.equal(g.status().queued, 1)
    a()
    ;(await next)()
    assert.equal(g.status().totals.abandoned, 1)
    assert.equal(g.status().totals.started, 2)
    await assert.rejects(g.acquire('u4', 'import', ac.signal), { code: 'CLIENT_CLOSED_REQUEST' })
  })

  it('run() releases the slot when the job throws', async () => {
    const g = new HeavyJobGate(limits({ max: 1 }))
    await assert.rejects(g.run('u1', 'import', async () => { throw new Error('boom') }), /boom/)
    assert.equal(g.status().running, 0)
    assert.equal(await g.run('u1', 'import', async () => 7), 7)
  })

  it('status reports ages of the oldest running job and waiter', async () => {
    let now = 1_000
    const g = new HeavyJobGate(limits({ max: 1 }), () => now)
    const a = await g.acquire('u1', 'import')
    now = 1_500
    const b = g.acquire('u2', 'import')
    now = 2_000
    const s = g.status()
    assert.deepEqual([s.oldestRunningMs, s.oldestQueuedMs], [1_000, 500])
    a()
    ;(await b)()
    assert.deepEqual([g.status().oldestRunningMs, g.status().oldestQueuedMs], [0, 0])
  })
})
