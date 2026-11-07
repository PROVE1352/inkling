import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { db } from './db/index'
import { env } from './env'

/**
 * Transactional outbox: scheduling and plumbing (docs/adr/1080-*, 1081-*).
 *
 * Writers call `enqueue` with the transaction of their change (or right after it): one INSERT that
 * also fires `pg_notify('inkling_outbox', '<topic>:<origin>')` on commit. Consumers are registered per topic by
 * the modules that own the effect (context/changeLog.ts 'change', notify/engine.ts 'notify',
 * webhooks.ts 'webhook'); this module only decides WHEN they run:
 *
 *  - kick:   right after a local enqueue commits (same process, no round trip);
 *  - LISTEN: a dedicated connection wakes the topic named in the notification (other processes);
 *  - poll:   every OUTBOX_POLL_MS as a backstop (lost notification, reconnect, retry backoff);
 *  - timer:  `wakeAt` for rows that become due later (delayed webhooks, backoff).
 *
 * Per process and topic at most one consumer pass runs at a time; across processes the consumers
 * coordinate in the database (advisory lock for 'change', SKIP LOCKED / leases for the others).
 * LISTEN and the poll loop start only with `startOutboxWorker` (index.ts); without it (tests, CLI
 * scripts) kicks and `drainOutbox` still process rows in-process.
 */

export type OutboxTopic = 'change' | 'notify' | 'webhook'
export const OUTBOX_TOPICS: OutboxTopic[] = ['change', 'notify', 'webhook']
export const OUTBOX_CHANNEL = 'inkling_outbox'
/** Backstop poll: the upper bound of the consumer lag when a notification is lost. */
export const OUTBOX_POLL_MS = 1_000
/** Finished webhook rows are kept this long: a re-emitted event with the same key is a no-op. */
export const OUTBOX_DONE_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000
/** Rows that gave up are kept for inspection this long. */
export const OUTBOX_DEAD_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000
const PURGE_EVERY_MS = 60 * 60 * 1_000

/** This process (one boot). Written into every row; see `ownedOrOrphaned`. */
export const OUTBOX_ORIGIN = randomUUID()
/**
 * Another instance's 'notify'/'webhook' rows become ours once due for this long: the writer died
 * (or is draining) and its rows must not wait for it. Also the restart delay for leftovers.
 */
const TAKEOVER_MS = 10_000

/** SQL filter: rows this instance wrote, rows of no instance, or rows orphaned past the takeover delay. */
export function ownedOrOrphaned(): SQL {
  return sql`(origin IS NULL OR origin = ${OUTBOX_ORIGIN} OR available_at < now() - make_interval(secs => ${TAKEOVER_MS / 1000}))`
}

/** `db` or a transaction. */
export type Exec = Pick<typeof db, 'execute'>

export interface OutboxRow {
  topic: OutboxTopic
  payload: unknown
  workspaceId?: string | null
  /** Idempotency key: a second row with the same key is dropped (ON CONFLICT DO NOTHING). */
  dedupeKey?: string | null
  /** Not before now + delayMs. */
  delayMs?: number
  /** Affinity (default: this process). A consumer passes on the origin of the row it applies. */
  origin?: string | null
}

/**
 * Insert rows (one statement) and notify listeners on commit. Returns how many were inserted
 * (rows whose dedupe key already exists are skipped). Inside a caller's transaction nothing runs
 * before the commit; call `kickOutbox` after it (a plain `db` call kicks by itself).
 */
export async function enqueue(exec: Exec, rows: OutboxRow[]): Promise<number> {
  if (rows.length === 0) return 0
  const data = rows.map((r) => ({
    topic: r.topic,
    origin: r.origin === undefined ? OUTBOX_ORIGIN : r.origin,
    dedupe_key: r.dedupeKey ?? null,
    workspace_id: r.workspaceId ?? null,
    payload: r.payload ?? null,
    delay_s: Math.max(0, r.delayMs ?? 0) / 1000,
  }))
  const out = (await exec.execute(sql`
    WITH ins AS (
      INSERT INTO outbox (topic, origin, dedupe_key, workspace_id, payload, available_at)
      SELECT x.topic, x.origin, x.dedupe_key, x.workspace_id, x.payload, now() + make_interval(secs => x.delay_s)
        FROM jsonb_to_recordset(${JSON.stringify(data)}::jsonb)
             AS x(topic text, origin text, dedupe_key text, workspace_id uuid, payload jsonb, delay_s float8)
      ON CONFLICT (dedupe_key) DO NOTHING
      RETURNING topic
    )
    SELECT topic, count(*)::int AS n, pg_notify(${OUTBOX_CHANNEL}, topic || ':' || ${OUTBOX_ORIGIN}) AS z FROM ins GROUP BY topic
  `)) as unknown as { topic: OutboxTopic; n: number }[]
  let n = 0
  for (const r of out) n += Number(r.n)
  if (exec === db) for (const r of out) kickOutbox(r.topic)
  return n
}

// ---------------------------------------------------------------------------
// retry policy
// ---------------------------------------------------------------------------

export interface RetryPolicy {
  baseMs: number
  factor: number
  capMs: number
  /** Total attempts before the row is marked dead. */
  maxAttempts: number
}

/** Delay before attempt `attempt + 1` (attempt ≥ 1): base·factor^(attempt−1), capped, ±10 % jitter. */
export function backoffMs(attempt: number, p: Pick<RetryPolicy, 'baseMs' | 'factor' | 'capMs'>, jitter = true): number {
  const raw = Math.min(p.capMs, p.baseMs * Math.pow(p.factor, Math.max(0, attempt - 1)))
  if (!jitter) return Math.round(raw)
  return Math.round(Math.min(p.capMs, raw * (0.9 + Math.random() * 0.2)))
}

/**
 * Record a failed attempt of a pending row: reschedule with backoff, or mark it dead after the
 * last attempt. `attempts` is the count after this attempt. `delayMs` overrides the backoff
 * (Retry-After). Returns 'retry' | 'dead'.
 */
export async function failRow(
  exec: Exec,
  topic: OutboxTopic,
  id: number,
  attempts: number,
  error: unknown,
  policy: RetryPolicy,
  delayMs?: number,
): Promise<'retry' | 'dead'> {
  const msg = String(error instanceof Error ? error.message : error).slice(0, 300)
  if (attempts >= policy.maxAttempts) {
    await exec.execute(sql`
      UPDATE outbox SET state = 'dead', attempts = ${attempts}, last_error = ${msg}, locked_until = NULL, finished_at = now()
       WHERE id = ${id}
    `)
    return 'dead'
  }
  const wait = delayMs ?? backoffMs(attempts, policy)
  await exec.execute(sql`
    UPDATE outbox SET attempts = ${attempts}, last_error = ${msg}, locked_until = NULL,
           available_at = now() + make_interval(secs => ${wait / 1000})
     WHERE id = ${id}
  `)
  wakeAt(topic, wait)
  return 'retry'
}

// ---------------------------------------------------------------------------
// scheduling (per process)
// ---------------------------------------------------------------------------

/** One consumer pass: returns the number of rows it finished (0 = nothing left that is due). */
export type OutboxHandler = () => Promise<number>

const handlers = new Map<OutboxTopic, OutboxHandler>()
/** A pass that finishes fewer rows than this found everything that was due: no follow-up pass. */
const fullPass = new Map<OutboxTopic, number>()
const running = new Map<OutboxTopic, Promise<number>>()
const rerun = new Set<OutboxTopic>()
const timers = new Map<OutboxTopic, { t: NodeJS.Timeout; at: number }>()
let autorun = process.env.OUTBOX_AUTORUN !== '0'
let stopped = false
let log: (msg: string) => void = (m) => console.error(m)

export function registerOutboxHandler(topic: OutboxTopic, run: OutboxHandler, batch: number): void {
  handlers.set(topic, run)
  fullPass.set(topic, Math.max(1, batch))
}

const mayHaveMore = (topic: OutboxTopic, n: number) => n >= (fullPass.get(topic) ?? 1)

/**
 * Tests and the crash harness: with autorun off, nothing is processed until `drainOutbox` (or a
 * kick after it is switched back on). Simulates "committed, then the process died".
 */
export function setOutboxAutorun(on: boolean): void {
  autorun = on
}

export function setOutboxLogger(fn: (msg: string) => void): void {
  log = fn
}

/** Run one pass of `topic` after the current one (serialised per topic in this process). */
function runOnce(topic: OutboxTopic): Promise<number> {
  const handler = handlers.get(topic)
  if (!handler) return Promise.resolve(0)
  const prev = running.get(topic) ?? Promise.resolve(0)
  const next = prev
    .catch(() => 0)
    .then(() => handler())
    .catch((err) => {
      log(`[outbox] ${topic} pass failed: ${String(err)}`)
      return 0
    })
  running.set(topic, next)
  void next.finally(() => {
    if (running.get(topic) === next) running.delete(topic)
  })
  return next
}

/** Ask for a pass soon (coalesced). Never throws, never blocks. */
export function kickOutbox(topic: OutboxTopic): void {
  if (!autorun || stopped || !handlers.has(topic)) return
  rerun.add(topic)
  if (looping.has(topic)) return
  looping.add(topic)
  void loop(topic).finally(() => {
    looping.delete(topic)
    // A kick that landed between the last check and here.
    if (rerun.has(topic)) kickOutbox(topic)
  })
}

const looping = new Set<OutboxTopic>()

async function loop(topic: OutboxTopic): Promise<void> {
  // Keep going while passes make progress or another kick arrived meanwhile.
  let more = true
  for (let i = 0; i < 1_000 && !stopped && autorun; i++) {
    if (!more && !rerun.has(topic)) break
    rerun.delete(topic)
    more = mayHaveMore(topic, await runOnce(topic))
  }
}

/** Arm a one-shot wake-up for `topic` in `ms` (the earliest one wins). */
export function wakeAt(topic: OutboxTopic, ms: number): void {
  if (!handlers.has(topic) || stopped || !autorun) return
  const at = Date.now() + Math.max(0, ms)
  const cur = timers.get(topic)
  if (cur && cur.at <= at) return
  if (cur) clearTimeout(cur.t)
  const t = setTimeout(() => {
    timers.delete(topic)
    kickOutbox(topic)
  }, Math.max(0, ms))
  t.unref?.()
  timers.set(topic, { t, at })
}

/**
 * Process `topic` until a pass finishes nothing (bounded by `maxPasses`). Used by readers that
 * need their own writes (changes_since), by tests and at shutdown. Runs even with autorun off.
 */
export async function drainOutbox(topic: OutboxTopic, maxPasses = 50): Promise<number> {
  let total = 0
  for (let i = 0; i < maxPasses; i++) {
    const n = await runOnce(topic)
    total += n
    if (!mayHaveMore(topic, n)) break
  }
  return total
}

/** Rows not finished yet, per topic (diagnostics, tests). */
export async function pendingOutbox(exec: Exec = db): Promise<Record<OutboxTopic, number>> {
  const rows = (await exec.execute(sql`
    SELECT topic, count(*)::int AS n FROM outbox WHERE state = 'pending' GROUP BY topic
  `)) as unknown as { topic: OutboxTopic; n: number }[]
  const out: Record<OutboxTopic, number> = { change: 0, notify: 0, webhook: 0 }
  for (const r of rows) out[r.topic] = Number(r.n)
  return out
}

/** Delete finished rows past their retention (hourly from the worker; tests call it directly). */
export async function purgeOutbox(now = new Date()): Promise<number> {
  const done = new Date(now.getTime() - OUTBOX_DONE_RETENTION_MS).toISOString()
  const dead = new Date(now.getTime() - OUTBOX_DEAD_RETENTION_MS).toISOString()
  const rows = (await db.execute(sql`
    DELETE FROM outbox WHERE id IN (
      SELECT id FROM outbox
       WHERE (state = 'done' AND finished_at < ${done}::timestamptz)
          OR (state = 'dead' AND finished_at < ${dead}::timestamptz)
       ORDER BY finished_at LIMIT 10000)
    RETURNING id
  `)) as unknown as unknown[]
  return rows.length
}

// ---------------------------------------------------------------------------
// worker (LISTEN + poll), started by index.ts
// ---------------------------------------------------------------------------

let listenClient: postgres.Sql | null = null
let pollTimer: NodeJS.Timeout | null = null
let lastPurge = 0

/** Start LISTEN and the backstop poll. Idempotent. */
export async function startOutboxWorker(logger?: (msg: string) => void): Promise<void> {
  if (logger) log = logger
  stopped = false
  autorun = true
  if (!pollTimer) {
    pollTimer = setInterval(() => {
      for (const t of OUTBOX_TOPICS) kickOutbox(t)
      if (Date.now() - lastPurge > PURGE_EVERY_MS) {
        lastPurge = Date.now()
        purgeOutbox().catch((err) => log(`[outbox] purge failed: ${String(err)}`))
      }
    }, OUTBOX_POLL_MS)
    pollTimer.unref?.()
  }
  if (!listenClient) {
    listenClient = postgres(env.databaseUrl, {
      max: 1,
      onnotice: () => {},
      connect_timeout: 10,
      connection: { application_name: 'inkling-outbox' },
    })
    try {
      await listenClient.listen(
        OUTBOX_CHANNEL,
        (msg) => {
          // "<topic>:<origin>". Our own commits were kicked locally already.
          const [topic, origin] = msg.split(':')
          if (origin === OUTBOX_ORIGIN) return
          if ((OUTBOX_TOPICS as string[]).includes(topic)) kickOutbox(topic as OutboxTopic)
        },
        // (Re)connected: anything committed while we were not listening is picked up now.
        () => {
          for (const t of OUTBOX_TOPICS) kickOutbox(t)
        },
      )
    } catch (err) {
      log(`[outbox] LISTEN failed, polling only: ${String(err)}`)
    }
  }
  for (const t of OUTBOX_TOPICS) kickOutbox(t)
}

/** Stop waking consumers and wait for passes in flight (shutdown, tests). Pending rows stay. */
export async function stopOutboxWorker(): Promise<void> {
  stopped = true
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = null
  for (const { t } of timers.values()) clearTimeout(t)
  timers.clear()
  const c = listenClient
  listenClient = null
  if (c) await c.end({ timeout: 2 }).catch(() => undefined)
  await Promise.allSettled([...running.values()])
}

/** Re-enable kicks after `stopOutboxWorker` (tests that restart a "process"). */
export function resumeOutbox(): void {
  stopped = false
}
