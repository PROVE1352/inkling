import postgres from 'postgres'

/**
 * One Inkling process per database (docs/adr/1925-*).
 *
 * Live documents, debounced stores, queued index passes, the outbox consumer and many caches live
 * in process memory; two processes on one database overwrite each other's whole document states.
 * The README always said "single instance"; this makes the boot enforce it with a session-level
 * Postgres advisory lock held on a dedicated connection for the life of the process.
 *
 *  - Taken before migrations. Busy: wait (a container replacing another one, the old one still
 *    flushing documents within its 30 s stop grace period), then refuse to boot with a log line that
 *    names the holder (pid, application, client address, since when).
 *  - SINGLE_INSTANCE=0 skips the guard (a deliberate setup that runs a second process, e.g. a one-off
 *    maintenance script against a live database). SINGLE_INSTANCE_WAIT seconds sets the wait
 *    (default 60).
 *  - The dedicated connection never recycles (max_lifetime/idle_timeout off). Every 30 s it checks
 *    it still holds the lock; after a database restart it takes it again, and if another process
 *    got it first this process shuts down instead of running beside it.
 *
 * Tests never boot index.ts, so parallel test processes on one database are unaffected.
 */

/** Two-int advisory key space ('INKL', 1): distinct from the single-bigint keys used elsewhere. */
export const INSTANCE_LOCK_KEY: readonly [number, number] = [0x494e4b4c, 1]

export class InstanceLockError extends Error {}

export interface InstanceLock {
  /** Releases the lock and closes its connection (shutdown, after the documents are flushed). */
  release: () => Promise<void>
}

interface Holder {
  pid: number
  application: string | null
  client: string | null
  since: string | null
}

export function instanceLockSettings(env: NodeJS.ProcessEnv = process.env): { enabled: boolean; waitMs: number } {
  const off = /^(0|false|off|no)$/i.test(env.SINGLE_INSTANCE?.trim() ?? '')
  const wait = Number(env.SINGLE_INSTANCE_WAIT?.trim() || '60')
  return { enabled: !off, waitMs: Number.isFinite(wait) && wait >= 0 ? wait * 1000 : 60_000 }
}

function describeHolder(h: Holder | undefined): string {
  if (!h) return 'another process (it released the lock while we looked)'
  const parts = [`pid ${h.pid} on the database server`]
  if (h.application) parts.push(`application "${h.application}"`)
  if (h.client) parts.push(`from ${h.client}`)
  if (h.since) parts.push(`connected since ${h.since}`)
  return parts.join(', ')
}

export async function acquireInstanceLock(opts: {
  databaseUrl: string
  waitMs: number
  log: (level: 'info' | 'warn' | 'error', msg: string) => void
  /** The lock was lost and another process holds it now: shut down. */
  onLost: (reason: string) => void
  key?: readonly [number, number]
  pollMs?: number
  heartbeatMs?: number
}): Promise<InstanceLock> {
  const [k1, k2] = opts.key ?? INSTANCE_LOCK_KEY
  const sql = postgres(opts.databaseUrl, {
    max: 1,
    // 0 = never: a recycled connection would silently drop the session lock
    idle_timeout: 0,
    max_lifetime: 0,
    onnotice: () => {},
    connect_timeout: 10,
    connection: { application_name: 'inkling-instance-lock', statement_timeout: 5_000 },
  })
  const tryLock = async () => (await sql`SELECT pg_try_advisory_lock(${k1}::int, ${k2}::int) AS ok`)[0].ok as boolean
  const held = async () =>
    (
      await sql`SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND classid = ${k1}::int::oid
                  AND objid = ${k2}::int::oid AND objsubid = 2 AND granted AND pid = pg_backend_pid()) AS held`
    )[0].held as boolean
  const holder = async (): Promise<Holder | undefined> =>
    (
      await sql<Holder[]>`
        SELECT a.pid, a.application_name AS application, a.client_addr::text AS client, a.backend_start::text AS since
          FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
         WHERE l.locktype = 'advisory' AND l.classid = ${k1}::int::oid AND l.objid = ${k2}::int::oid
           AND l.objsubid = 2 AND l.granted AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
         LIMIT 1`
    )[0]

  const started = Date.now()
  const poll = opts.pollMs ?? 1_000
  try {
    let announced = false
    while (!(await tryLock())) {
      if (!announced) {
        announced = true
        opts.log(
          'warn',
          `[inkling] another Inkling process uses this database (${describeHolder(await holder())}); ` +
            `waiting up to ${Math.round(opts.waitMs / 1000)} s for it to stop`,
        )
      }
      if (Date.now() - started >= opts.waitMs) {
        throw new InstanceLockError(
          `[inkling] refusing to start: another Inkling process is running against this database ` +
            `(${describeHolder(await holder())}). Two processes overwrite each other's documents. ` +
            `Stop the other process first. Only for a deliberate second process (never a second web server), ` +
            `set SINGLE_INSTANCE=0; SINGLE_INSTANCE_WAIT sets the wait in seconds (docs/OPERATIONS.md).`,
        )
      }
      await new Promise((r) => setTimeout(r, poll))
    }
  } catch (err) {
    await sql.end({ timeout: 2 }).catch(() => {})
    throw err
  }
  if (Date.now() - started > poll) opts.log('info', '[inkling] the other process stopped; continuing the boot')

  let closed = false
  let checking = false
  const heartbeat = setInterval(() => {
    if (closed || checking) return
    checking = true
    void (async () => {
      try {
        if (await held()) return
        // A new session (the database restarted, or the connection dropped): take the lock again.
        if (await tryLock()) {
          opts.log('warn', '[inkling] the instance lock connection was replaced; lock taken again')
          return
        }
        const who = describeHolder(await holder())
        opts.log('error', `[inkling] lost the instance lock to another process (${who}); shutting down`)
        opts.onLost(`instance lock lost to ${who}`)
      } catch {
        // database unreachable: the next beat retries (the pool's own errors are logged elsewhere)
      } finally {
        checking = false
      }
    })()
  }, opts.heartbeatMs ?? 30_000)
  heartbeat.unref()

  return {
    release: async () => {
      if (closed) return
      closed = true
      clearInterval(heartbeat)
      try {
        await sql`SELECT pg_advisory_unlock(${k1}::int, ${k2}::int)`
      } catch {
        // the session ends below anyway, which releases it
      }
      await sql.end({ timeout: 2 }).catch(() => {})
    },
  }
}
