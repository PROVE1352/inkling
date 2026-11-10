// Single-instance guard (docs/adr/1925-*) against a real database: a second process waits for the
// advisory lock, refuses to boot when the first one does not stop in time (naming the holder), and
// gets it once the first one releases it; SINGLE_INSTANCE / SINGLE_INSTANCE_WAIT parse as documented.
// A test-only key keeps parallel test files and a dev server on the same database out of the way.
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

const HAS_DB = !!process.env.DATABASE_URL

describe('instance lock settings', () => {
  it('reads SINGLE_INSTANCE and SINGLE_INSTANCE_WAIT', async () => {
    const { instanceLockSettings } = await import('./instanceLock')
    assert.deepEqual(instanceLockSettings({}), { enabled: true, waitMs: 60_000 })
    assert.deepEqual(instanceLockSettings({ SINGLE_INSTANCE: '0' }), { enabled: false, waitMs: 60_000 })
    assert.deepEqual(instanceLockSettings({ SINGLE_INSTANCE: 'off', SINGLE_INSTANCE_WAIT: '5' }), { enabled: false, waitMs: 5_000 })
    assert.deepEqual(instanceLockSettings({ SINGLE_INSTANCE: '1', SINGLE_INSTANCE_WAIT: 'x' }), { enabled: true, waitMs: 60_000 })
  })
})

describe('[db] single-instance guard', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const { acquireInstanceLock, InstanceLockError } = await import('./instanceLock')
  const key = [0x494e4b4c, 900_000 + (process.pid % 10_000)] as const
  const logs: string[] = []
  const base = { databaseUrl: process.env.DATABASE_URL!, key, pollMs: 100, log: (_l: string, m: string) => void logs.push(m), onLost: () => {} }

  it('a second process waits, refuses with the holder named, and boots once the first one stops', async () => {
    const first = await acquireInstanceLock({ ...base, waitMs: 0 })
    try {
      await assert.rejects(acquireInstanceLock({ ...base, waitMs: 400 }), (err: unknown) => {
        assert.ok(err instanceof InstanceLockError)
        assert.match(String((err as Error).message), /refusing to start: another Inkling process .*inkling-instance-lock/)
        return true
      })
      assert.ok(logs.some((m) => /waiting up to 0 s/.test(m)))
      // a replacement started while the old one is still shutting down: it waits, then boots
      const second = acquireInstanceLock({ ...base, waitMs: 5_000 })
      setTimeout(() => void first.release(), 300)
      const lock = await second
      assert.ok(logs.some((m) => /the other process stopped/.test(m)))
      await lock.release()
    } finally {
      await first.release()
    }
  })

  it('the holder survives a dropped connection: the heartbeat takes the lock again', async () => {
    const lost: string[] = []
    const lock = await acquireInstanceLock({ ...base, waitMs: 0, heartbeatMs: 100, onLost: (r) => void lost.push(r) })
    try {
      const postgres = (await import('postgres')).default
      const admin = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} })
      // kill the lock session from outside, as a database restart would
      await admin`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'inkling-instance-lock' AND datname = current_database() AND pid <> pg_backend_pid()`
      await new Promise((r) => setTimeout(r, 600))
      const [{ n }] = await admin<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND classid = ${key[0]}::int::oid AND objid = ${key[1]}::int::oid AND granted`
      await admin.end()
      assert.equal(n, 1, 'held again')
      assert.deepEqual(lost, [])
    } finally {
      await lock.release()
    }
  })
})
