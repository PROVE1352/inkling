import { lifecycle } from '../lifecycle'
import { onOutboxAnnouncement, onOutboxCommitted } from '../outbox'

/**
 * changes_since long-poll (docs/adr/1551-*): an agent that would otherwise poll the change feed asks
 * once with `wait` seconds; the call returns as soon as the change log gains rows in one of its
 * workspaces, or empty at the deadline.
 *
 * Wake-ups reuse the existing path of the change log (docs/adr/1080-*, 1150-*): the change
 * consumer (context/changeLog.ts) calls `notifyChangesCommitted` after a pass that committed rows,
 * with their workspaces; a 'change' announcement from another process (LISTEN, outbox.ts) wakes
 * every waiter, whose next read then drains or waits for that process's pass (reserveCursor). A local
 * commit of change rows that no local pass reports within 250 ms (another process applied them) also
 * wakes every waiter. No new NOTIFY, no polling: a waiting call costs no statement until something happens.
 *
 * Race: `changeMark` is taken BEFORE the read that came back empty; a wait whose workspaces were
 * notified after that mark returns at once, so a change committed between the read and the wait is
 * never missed. A wake-up only means "read again": the caller re-reads and may wait again.
 *
 * Limits: CHANGE_WAITERS_MAX waiting calls per process and CHANGE_WAITERS_PER_CONNECTION per
 * connection; a call over a limit, or during shutdown, does not wait (the caller says so).
 */

/** Longest wait: below Fastify's 30 s socket inactivity timeout (index.ts connectionTimeout). */
export const CHANGE_WAIT_MAX_SEC = 25
export const CHANGE_WAITERS_MAX = 256
export const CHANGE_WAITERS_PER_CONNECTION = 4

export type WaitOutcome = 'changed' | 'timeout' | 'aborted' | 'released'

interface Waiter {
  conn: string
  /** null = any workspace. */
  workspaces: Set<string> | null
  done: (o: WaitOutcome) => void
}

const waiters = new Set<Waiter>()
const perConnection = new Map<string, number>()

/** Notification counter: global, per workspace, and the last "everything" (another process). */
let seq = 0
let allSeq = 0
const wsSeq = new Map<string, number>()
let released = false
/**
 * Commit fallback (end of file): local commits of change rows are numbered; a consumer pass takes the
 * number current when it starts. A pass that started after a commit and reported rows has seen it.
 */
let commitEpoch = 0
let reportedEpoch = -1

export const changeWaitStats = { waits: 0, changed: 0, timeouts: 0, aborted: 0, refused: 0, released: 0, wakeups: 0, fallbacks: 0 }

export function activeChangeWaiters(): number {
  return waiters.size
}

/** Tests: called whenever the number of waiting calls changes. */
const countListeners = new Set<() => void>()
function countChanged(): void {
  for (const fn of [...countListeners]) fn()
}

/** Tests: resolves once exactly `n` calls are waiting (an event, not a sleep). */
export function _whenWaiters(n: number, timeoutMs = 20_000): Promise<void> {
  if (waiters.size === n) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      countListeners.delete(check)
      reject(new Error(`expected ${n} waiting calls, have ${waiters.size}`))
    }, timeoutMs)
    function check() {
      if (waiters.size !== n) return
      clearTimeout(t)
      countListeners.delete(check)
      resolve()
    }
    countListeners.add(check)
  })
}

/** The notification position for `workspaces` (null = any): pass it to `waitForChanges`. */
export function changeMark(workspaces: Iterable<string> | null): number {
  if (workspaces === null) return seq
  let m = allSeq
  for (const w of workspaces) m = Math.max(m, wsSeq.get(w) ?? 0)
  return m
}

/** A consumer pass of this process is starting: pass the result to `notifyChangesCommitted`. */
export function changePassStarting(): number {
  return commitEpoch
}

/**
 * The change log committed rows of `workspaces` (null = unknown: wake every waiter). `passEpoch`:
 * what `changePassStarting` returned when the reporting pass started.
 */
export function notifyChangesCommitted(workspaces: Iterable<string> | null, passEpoch?: number): void {
  seq++
  if (passEpoch !== undefined) reportedEpoch = Math.max(reportedEpoch, passEpoch)
  let list: string[] | null = null
  if (workspaces === null) allSeq = seq
  else {
    list = [...workspaces]
    if (list.length === 0) return
    for (const w of list) {
      // bounded by the number of workspaces; the oldest positions are the least useful
      wsSeq.delete(w)
      wsSeq.set(w, seq)
    }
    while (wsSeq.size > 50_000) wsSeq.delete(wsSeq.keys().next().value!)
  }
  for (const w of [...waiters]) {
    if (list === null || w.workspaces === null || list.some((id) => w.workspaces!.has(id))) {
      changeWaitStats.wakeups++
      w.done('changed')
    }
  }
}

/**
 * Wait until a change is committed in `workspaces` after `mark`, the deadline `until` (epoch ms),
 * an abort, or shutdown. Returns null without waiting when a limit is reached or the process is
 * shutting down.
 */
export function waitForChanges(opts: {
  conn: string
  workspaces: Iterable<string> | null
  mark: number
  until: number
  signal?: AbortSignal
}): Promise<WaitOutcome> | null {
  const workspaces = opts.workspaces === null ? null : new Set(opts.workspaces)
  if (changeMark(workspaces) > opts.mark) return Promise.resolve('changed')
  if (opts.until <= Date.now()) return Promise.resolve('timeout')
  if (opts.signal?.aborted) return Promise.resolve('aborted')
  if (released || lifecycle.shuttingDown || waiters.size >= CHANGE_WAITERS_MAX || (perConnection.get(opts.conn) ?? 0) >= CHANGE_WAITERS_PER_CONNECTION) {
    changeWaitStats.refused++
    return null
  }
  changeWaitStats.waits++
  return new Promise<WaitOutcome>((resolve) => {
    let timer: NodeJS.Timeout | null = null
    const onAbort = () => w.done('aborted')
    const w: Waiter = {
      conn: opts.conn,
      workspaces,
      done: (o) => {
        if (!waiters.delete(w)) return
        const n = (perConnection.get(w.conn) ?? 1) - 1
        if (n > 0) perConnection.set(w.conn, n)
        else perConnection.delete(w.conn)
        if (timer) clearTimeout(timer)
        opts.signal?.removeEventListener('abort', onAbort)
        changeWaitStats[o === 'timeout' ? 'timeouts' : o]++
        countChanged()
        resolve(o)
      },
    }
    waiters.add(w)
    perConnection.set(opts.conn, (perConnection.get(opts.conn) ?? 0) + 1)
    timer = setTimeout(() => w.done('timeout'), Math.max(0, opts.until - Date.now()))
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    countChanged()
  })
}

/** Shutdown: every waiting call returns now (as at its deadline) and no new call waits. */
export function releaseChangeWaiters(): void {
  released = true
  for (const w of [...waiters]) w.done('released')
}

/** Tests: accept waits again after `releaseChangeWaiters`. */
export function _resumeChangeWaits(): void {
  released = false
}

// Another process committed change rows: every waiter re-reads (the read drains them or waits for
// that process's consumer pass under the change-log lock, context/changeLog.ts reserveCursor).
onOutboxAnnouncement((topic) => {
  if (topic === 'change') notifyChangesCommitted(null)
})
// This process committed change rows: another process's consumer may apply them (it takes any pending
// row under the change-log lock, SKIP LOCKED), and then no local pass reports them. Unless a local pass
// that started after the commit reported rows within COMMIT_FALLBACK_MS, every waiter reads again; the
// read drains the rows or waits on the lock for that other pass, so it sees them. With one process the
// kicked local pass reports first and this does not fire.
const COMMIT_FALLBACK_MS = 250
let fallback: NodeJS.Timeout | null = null
onOutboxCommitted((topic) => {
  if (topic !== 'change') return
  commitEpoch++
  if (fallback) return
  fallback = setTimeout(() => {
    fallback = null
    if (reportedEpoch < commitEpoch && waiters.size) {
      changeWaitStats.fallbacks++
      notifyChangesCommitted(null)
    }
  }, COMMIT_FALLBACK_MS)
  fallback.unref?.()
})
