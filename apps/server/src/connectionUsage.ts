import { AsyncLocalStorage } from 'node:async_hooks'
import type { FastifyInstance } from 'fastify'
import type { AuthUser } from './auth'
import { BoundedLru } from './lru'
import { MCP_INTERNAL_HEADER } from './oauth'

/**
 * Usage per connection (docs/adr/1552-*): for every agent connection (OAuth grant) and personal API
 * token, since this process started: calls, an estimate of the tokens returned, errors, find_context
 * cache hits, time spent waiting in changes_since, latency without that wait, last use.
 *
 * Numbers only: no tool arguments, queries, page ids or text are kept. Kept in memory (no schema
 * change); the durable "last used" stays in the existing columns (oauth_grants.last_used_at,
 * api_tokens.last_used_at, workspace_agent_access.last_used_at). Lost on restart, per process.
 *
 * A call runs inside a frame (AsyncLocalStorage) so code far below the tool can add to it without
 * new parameters: the find_context cache marks a hit, the long-poll adds its wait, access checks add
 * the workspaces the call reached (for the per-workspace numbers in "Connected agents").
 */

/** Latency histogram bucket upper bounds (ms); the last bucket is open. */
const BUCKETS = [5, 10, 20, 50, 100, 200, 500, 1_000, 2_000, 5_000, 10_000, 30_000]

export interface UsageCounters {
  calls: number
  errors: number
  /** Estimated tokens of the text returned (MCP: tool result text; REST: body bytes / 4). */
  tokens: number
  cacheHits: number
  /** Time spent waiting for changes (changes_since wait), left out of the latency below. */
  waitMs: number
  latencyMsSum: number
  maxMs: number
  hist: number[]
  firstUsedAt: number
  lastUsedAt: number
}

export interface UsageView extends Omit<UsageCounters, 'hist' | 'latencyMsSum'> {
  avgMs: number
  /** Upper bound of the bucket holding the 95th percentile (0 without calls). */
  p95Ms: number
}

/** Entries kept: connections plus (workspace, grant) pairs. Old ones fall out first (LRU). */
const MAX_CONNECTIONS = 5_000
const MAX_WORKSPACE_ROWS = 20_000
const KEEP_MS = 365 * 24 * 60 * 60 * 1_000

const connections = new BoundedLru<UsageCounters>(MAX_CONNECTIONS, KEEP_MS)
/** key `${workspaceId}|${grantId}` */
const perWorkspace = new BoundedLru<UsageCounters>(MAX_WORKSPACE_ROWS, KEEP_MS)
let since = Date.now()

/** When the counters started (process start, or the last reset in tests). */
export function usageSince(): Date {
  return new Date(since)
}

function empty(now: number): UsageCounters {
  return { calls: 0, errors: 0, tokens: 0, cacheHits: 0, waitMs: 0, latencyMsSum: 0, maxMs: 0, hist: new Array(BUCKETS.length + 1).fill(0), firstUsedAt: now, lastUsedAt: now }
}

function add(c: UsageCounters, s: CallSample, now: number): void {
  c.calls++
  if (s.error) c.errors++
  c.tokens += s.tokens
  if (s.cacheHit) c.cacheHits++
  c.waitMs += s.waitMs
  c.latencyMsSum += s.latencyMs
  c.maxMs = Math.max(c.maxMs, s.latencyMs)
  let i = BUCKETS.findIndex((b) => s.latencyMs <= b)
  if (i < 0) i = BUCKETS.length
  c.hist[i]++
  c.lastUsedAt = now
}

function view(c: UsageCounters): UsageView {
  let p95 = 0
  const target = Math.ceil(c.calls * 0.95)
  let seen = 0
  for (let i = 0; i < c.hist.length; i++) {
    seen += c.hist[i]
    if (seen >= target && c.calls > 0) {
      p95 = i < BUCKETS.length ? BUCKETS[i] : c.maxMs
      break
    }
  }
  const { hist: _h, latencyMsSum, ...rest } = c
  return { ...rest, avgMs: c.calls ? Math.round(latencyMsSum / c.calls) : 0, p95Ms: p95 }
}

/** 'grant:<id>' for an agent connection, 'token:<id>' for a personal API token, null otherwise. */
export function connectionKeyOf(user: Pick<AuthUser, 'grantId' | 'tokenId'> | null | undefined): string | null {
  if (user?.grantId) return `grant:${user.grantId}`
  if (user?.tokenId) return `token:${user.tokenId}`
  return null
}

export interface CallSample {
  latencyMs: number
  waitMs: number
  tokens: number
  error: boolean
  cacheHit: boolean
}

/** Record one finished call of `key`; `workspaces` = the workspaces it reached (agent grants). */
export function recordCall(key: string, s: CallSample, workspaces: Iterable<string> = []): void {
  const now = Date.now()
  let c = connections.get(key)
  if (!c) {
    c = empty(now)
    connections.set(key, c)
  }
  add(c, s, now)
  if (!key.startsWith('grant:')) return
  const grantId = key.slice(6)
  for (const ws of workspaces) {
    const k = `${ws}|${grantId}`
    let w = perWorkspace.get(k)
    if (!w) {
      w = empty(now)
      perWorkspace.set(k, w)
    }
    add(w, s, now)
  }
}

export function usageFor(key: string): UsageView | null {
  const c = connections.get(key)
  return c ? view(c) : null
}

export function workspaceUsageFor(workspaceId: string, grantId: string): UsageView | null {
  const c = perWorkspace.get(`${workspaceId}|${grantId}`)
  return c ? view(c) : null
}

/** Every connection with numbers, most recently used first. */
export function usageList(): { key: string; usage: UsageView }[] {
  const out: { key: string; usage: UsageView }[] = []
  for (const key of [...connections.keys()]) {
    const c = connections.peek(key)
    if (c) out.push({ key, usage: view(c) })
  }
  return out.sort((a, b) => b.usage.lastUsedAt - a.usage.lastUsedAt)
}

/** Tests: forget everything and restart the "since" clock. */
export function _resetUsage(): void {
  connections.clear()
  perWorkspace.clear()
  since = Date.now()
}

// ---------------------------------------------------------------------------
// call frame
// ---------------------------------------------------------------------------

interface Frame {
  waitMs: number
  cacheHit: boolean
  workspaces: Set<string>
}

const frames = new AsyncLocalStorage<Frame>()

/**
 * Run one call of connection `key` and record it. `measure` turns the result into the returned
 * token estimate and the error flag; a throw counts as an error with no tokens.
 */
export async function runMetered<T>(key: string, fn: () => Promise<T>, measure: (r: T) => { tokens: number; error: boolean }): Promise<T> {
  const frame: Frame = { waitMs: 0, cacheHit: false, workspaces: new Set() }
  const t0 = performance.now()
  let sample: { tokens: number; error: boolean } = { tokens: 0, error: true }
  try {
    const r = await frames.run(frame, fn)
    sample = measure(r)
    return r
  } finally {
    const elapsed = performance.now() - t0
    recordCall(
      key,
      {
        latencyMs: Math.max(0, Math.round(elapsed - frame.waitMs)),
        waitMs: Math.round(frame.waitMs),
        tokens: sample.tokens,
        error: sample.error,
        cacheHit: frame.cacheHit,
      },
      frame.workspaces,
    )
  }
}

/** The find_context cache answered this call (docs/adr/1550-*). */
export function noteCacheHit(): void {
  const f = frames.getStore()
  if (f) f.cacheHit = true
}

/** Time this call spent waiting for changes (docs/adr/1551-*): not latency. */
export function noteWait(ms: number): void {
  const f = frames.getStore()
  if (f) f.waitMs += Math.max(0, ms)
}

/** Workspaces this call reached through an access check. */
export function noteWorkspaces(ids: Iterable<string>): void {
  const f = frames.getStore()
  if (f) for (const id of ids) f.workspaces.add(id)
}

// ---------------------------------------------------------------------------
// REST calls of personal API tokens
// ---------------------------------------------------------------------------

/**
 * Counts REST requests made with a personal API token (docs/adr/1201-*): calls, status ≥ 400 as
 * errors, body bytes / 4 as returned tokens, Fastify's elapsed time as latency. The MCP server's own
 * internal requests (app.inject with the internal header) are counted as tool calls instead.
 */
export function registerUsageHooks(app: FastifyInstance): void {
  app.addHook('onResponse', async (req, reply) => {
    const tokenId = req.user?.tokenId
    if (!tokenId || req.headers[MCP_INTERNAL_HEADER] !== undefined) return
    const len = Number(reply.getHeader('content-length') ?? 0)
    const key = `token:${tokenId}`
    recordCall(key, {
      latencyMs: Math.round(reply.elapsedTime),
      waitMs: 0,
      tokens: Number.isFinite(len) ? Math.ceil(len / 4) : 0,
      error: reply.statusCode >= 400,
      cacheHit: false,
    })
  })
}
