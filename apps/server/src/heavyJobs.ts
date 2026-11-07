import { AppError } from './errors'

/**
 * Concurrency cap for heavy jobs (docs/adr/1240-*, KNOWN-ISSUES B-M9).
 *
 * Folder/zip/Notion imports, zip exports and subtree duplicates each hold tens of MB (upload
 * buffer, JSZip state, rendered pages, page copies). Several at once could push the 768 MB app
 * container into the OOM killer. Every such route takes a slot here first:
 *
 *  - at most `max` jobs run at once in this process (HEAVY_JOBS_MAX, default 2);
 *  - the rest wait in one queue of at most `queueMax` entries (HEAVY_JOBS_QUEUE_MAX, default 16);
 *    a waiter that gets no slot within `waitMs` (HEAVY_JOBS_WAIT_MS, default 60 s) is refused with
 *    503 HEAVY_JOBS_BUSY and Retry-After, and so is a request that finds the queue full;
 *  - one person may have at most `perUser` jobs running or waiting (HEAVY_JOBS_PER_USER, default 2);
 *    one more is refused with 429 HEAVY_JOBS_PER_USER and Retry-After;
 *  - a free slot goes to the waiter whose person has the fewest running jobs, then the one served
 *    longest ago, then the oldest request: one person's batch of exports does not starve others.
 *
 * A waiter whose client disconnects (AbortSignal) leaves the queue without running.
 * The cap is per process; one instance is the supported deployment (docs/OPERATIONS.md §3).
 */

export type HeavyJobKind = 'import' | 'import-folder' | 'export-zip' | 'duplicate'
export const HEAVY_JOB_KINDS: HeavyJobKind[] = ['import', 'import-folder', 'export-zip', 'duplicate']

export interface HeavyJobLimits {
  /** Jobs running at once. */
  max: number
  /** Requests waiting for a slot; beyond this a new request is refused at once (503). */
  queueMax: number
  /** Longest wait for a slot before a 503. */
  waitMs: number
  /** Jobs one person may have running or waiting; one more is refused (429). */
  perUser: number
}

function positiveInt(v: string | undefined, fallback: number): number {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : fallback
}

function nonNegativeInt(v: string | undefined, fallback: number): number {
  if (v == null || v.trim() === '') return fallback
  const n = Number(v)
  return Number.isInteger(n) && n >= 0 ? n : fallback
}

export function readHeavyJobLimits(e: NodeJS.ProcessEnv = process.env): HeavyJobLimits {
  return {
    max: positiveInt(e.HEAVY_JOBS_MAX, 2),
    queueMax: nonNegativeInt(e.HEAVY_JOBS_QUEUE_MAX, 16),
    waitMs: positiveInt(e.HEAVY_JOBS_WAIT_MS, 60_000),
    perUser: positiveInt(e.HEAVY_JOBS_PER_USER, 2),
  }
}

/** Ends the job; idempotent (the export stream calls it from several teardown paths). */
export type HeavyJobRelease = () => void

/** What the admin server status shows (exported for it; no route of its own). */
export interface HeavyJobStatus {
  limits: HeavyJobLimits
  running: number
  queued: number
  byKind: Record<HeavyJobKind, { running: number; queued: number }>
  /** Age of the longest-running job and of the oldest waiter, ms (0 when none). */
  oldestRunningMs: number
  oldestQueuedMs: number
  /** Since process start. */
  totals: {
    started: number
    /** Refused: queue full or no slot within waitMs (503). */
    busy: number
    /** Refused: the person already had `perUser` jobs (429). */
    perUser: number
    /** Waiters whose client went away before they got a slot. */
    abandoned: number
  }
}

interface Waiter {
  seq: number
  userId: string
  kind: HeavyJobKind
  at: number
  grant: (release: HeavyJobRelease) => void
  refuse: (err: Error) => void
}

interface Running {
  userId: string
  kind: HeavyJobKind
  at: number
}

export class HeavyJobGate {
  private readonly running = new Map<number, Running>()
  private waiting: Waiter[] = []
  /** Grant sequence of each person's last slot (fairness); dropped when the person has nothing left. */
  private readonly lastGrant = new Map<string, number>()
  private seq = 0
  private grants = 0
  private readonly totals = { started: 0, busy: 0, perUser: 0, abandoned: 0 }

  constructor(
    public readonly limits: HeavyJobLimits,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Wait for a slot. Resolves with the release function, or rejects with a 429/503 AppError (499
   * CLIENT_CLOSED_REQUEST when `signal` fires while waiting). The caller must release exactly when the job's
   * memory is gone (for a streamed export: when the stream ends or is destroyed).
   */
  acquire(userId: string, kind: HeavyJobKind, signal?: AbortSignal): Promise<HeavyJobRelease> {
    if (signal?.aborted) return Promise.reject(abortError())
    if (this.countOf(userId) >= this.limits.perUser) {
      this.totals.perUser++
      return Promise.reject(
        new AppError(
          429,
          'HEAVY_JOBS_PER_USER',
          `You already have ${this.limits.perUser} imports, exports or copies in progress; wait for one to finish`,
          this.retryAfterSec(),
        ),
      )
    }
    const seq = ++this.seq
    if (this.running.size < this.limits.max && this.waiting.length === 0) {
      return Promise.resolve(this.start(seq, userId, kind))
    }
    if (this.waiting.length >= this.limits.queueMax) {
      this.totals.busy++
      return Promise.reject(busyError(this.retryAfterSec()))
    }
    return new Promise<HeavyJobRelease>((resolve, reject) => {
      let timer: NodeJS.Timeout | null = null
      const leave = (): boolean => {
        const i = this.waiting.indexOf(w)
        if (i < 0) return false
        this.waiting.splice(i, 1)
        if (timer) clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        this.forget(userId)
        return true
      }
      const onAbort = (): void => {
        if (!leave()) return
        this.totals.abandoned++
        reject(abortError())
        this.pump()
      }
      const w: Waiter = {
        seq,
        userId,
        kind,
        at: this.now(),
        grant: (release) => {
          if (timer) clearTimeout(timer)
          signal?.removeEventListener('abort', onAbort)
          resolve(release)
        },
        refuse: reject,
      }
      this.waiting.push(w)
      timer = setTimeout(() => {
        if (!leave()) return
        this.totals.busy++
        reject(busyError(this.retryAfterSec()))
      }, this.limits.waitMs)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  /** Run `fn` inside a slot (released when it settles). */
  async run<T>(userId: string, kind: HeavyJobKind, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(userId, kind, signal)
    try {
      return await fn()
    } finally {
      release()
    }
  }

  status(): HeavyJobStatus {
    const byKind = Object.fromEntries(HEAVY_JOB_KINDS.map((k) => [k, { running: 0, queued: 0 }])) as HeavyJobStatus['byKind']
    const now = this.now()
    let oldestRunning = now
    for (const r of this.running.values()) {
      byKind[r.kind].running++
      oldestRunning = Math.min(oldestRunning, r.at)
    }
    let oldestQueued = now
    for (const w of this.waiting) {
      byKind[w.kind].queued++
      oldestQueued = Math.min(oldestQueued, w.at)
    }
    return {
      limits: { ...this.limits },
      running: this.running.size,
      queued: this.waiting.length,
      byKind,
      oldestRunningMs: now - oldestRunning,
      oldestQueuedMs: now - oldestQueued,
      totals: { ...this.totals },
    }
  }

  private start(seq: number, userId: string, kind: HeavyJobKind): HeavyJobRelease {
    this.running.set(seq, { userId, kind, at: this.now() })
    this.lastGrant.set(userId, ++this.grants)
    this.totals.started++
    let done = false
    return () => {
      if (done) return
      done = true
      this.running.delete(seq)
      this.forget(userId)
      this.pump()
    }
  }

  /** Hand free slots to waiters: fewest running jobs of the person, then served longest ago, then oldest. */
  private pump(): void {
    while (this.running.size < this.limits.max && this.waiting.length > 0) {
      let best = 0
      for (let i = 1; i < this.waiting.length; i++) {
        if (this.before(this.waiting[i], this.waiting[best])) best = i
      }
      const [w] = this.waiting.splice(best, 1)
      w.grant(this.start(w.seq, w.userId, w.kind))
    }
  }

  private before(a: Waiter, b: Waiter): boolean {
    const ra = this.runningOf(a.userId)
    const rb = this.runningOf(b.userId)
    if (ra !== rb) return ra < rb
    const ga = this.lastGrant.get(a.userId) ?? 0
    const gb = this.lastGrant.get(b.userId) ?? 0
    if (ga !== gb) return ga < gb
    return a.seq < b.seq
  }

  private runningOf(userId: string): number {
    let n = 0
    for (const r of this.running.values()) if (r.userId === userId) n++
    return n
  }

  private countOf(userId: string): number {
    let n = this.runningOf(userId)
    for (const w of this.waiting) if (w.userId === userId) n++
    return n
  }

  /** Keep the fairness record only while the person has something running or waiting. */
  private forget(userId: string): void {
    if (this.countOf(userId) === 0) this.lastGrant.delete(userId)
  }

  /** Seconds a refused client should wait: the queue wait bound, at least 1 s, at most 2 min. */
  private retryAfterSec(): number {
    return Math.min(120, Math.max(1, Math.ceil(this.limits.waitMs / 1000)))
  }
}

function busyError(retryAfter: number): AppError {
  return new AppError(
    503,
    'HEAVY_JOBS_BUSY',
    'The server is busy with other imports, exports or copies; try again shortly',
    retryAfter,
  )
}

/**
 * The client went away while waiting. An AppError so the error handlers answer it quietly (the
 * socket is gone; nobody reads the 499) instead of logging a 500.
 */
function abortError(): AppError {
  return new AppError(499, 'CLIENT_CLOSED_REQUEST', 'The request was closed while waiting for a heavy-job slot')
}

/** The process-wide gate the routes use. */
export const heavyJobs = new HeavyJobGate(readHeavyJobLimits())

/** For the admin server status (running and queued heavy jobs, limits, refusals since start). */
export function heavyJobStatus(): HeavyJobStatus {
  return heavyJobs.status()
}

/**
 * AbortSignal that fires when the client goes away before the response finished (a waiter then
 * leaves the queue). `reply.raw` is the Node ServerResponse; injected requests never abort.
 */
export function clientGoneSignal(raw: { once(ev: 'close', fn: () => void): unknown; writableFinished?: boolean }): AbortSignal {
  const ac = new AbortController()
  raw.once('close', () => {
    if (!raw.writableFinished) ac.abort()
  })
  return ac.signal
}
