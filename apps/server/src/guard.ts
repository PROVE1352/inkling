import { BlockList, isIPv4, isIPv6 } from 'node:net'
import { desc, gt, sql } from 'drizzle-orm'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { db } from './db/index'
import { ipBans } from './db/schema'
import { env } from './env'
import { AppError } from './errors'

/**
 * Brute-force protection: temporary bans for IPs that pile up failures + per-account backoff.
 *
 * - IP: banned when failures within the window (default 15 min) reach the limit (default 10).
 *   Each re-ban climbs a level (default 15 min → 1 h → 6 h → 24 h cap). The level resets 7 days
 *   after the last ban.
 * - Account: failures are counted but the account is never locked (prevents DoS by locking
 *   someone else's account). Past the limit (default 5) only the next attempt on that account is
 *   delayed with exponential backoff (1s, 2s, 4s … up to 5 min).
 * - Success clears that IP's and account's counters. Allowlisted IPs (ALLOWLIST_IPS) are never banned.
 * - IPv6 is counted per /64 (prevents evasion by rotating addresses).
 *
 * Counters live in memory (entry cap + periodic cleanup); bans are recorded in the ip_bans table
 * so they survive restarts. This differs from request rate limiting (@fastify/rate-limit): that
 * counts "requests per second/minute", this counts "failed attempts". Both use the same 429
 * RATE_LIMITED response shape.
 */

const cfg = env.authGuard
const WINDOW_MS = cfg.windowMinutes * 60_000
const BAN_BASE_MS = cfg.banMinutes * 60_000
const BAN_MAX_MS = cfg.banMaxHours * 3_600_000
const LADDER = [1, 4, 24, 96] // 15m → 1h → 6h → 24h (with the defaults)
const STRIKE_MEMORY_MS = 7 * 24 * 3_600_000
const ACCOUNT_BACKOFF_MAX_MS = 5 * 60_000
const MAX_ENTRIES = 20_000

export const RATE_LIMIT_MESSAGE = 'Too many requests. Try again shortly.'

export const tooMany = (retryAfterSec: number) =>
  new AppError(429, 'RATE_LIMITED', RATE_LIMIT_MESSAGE, Math.max(1, Math.ceil(retryAfterSec)))

// ---------------------------------------------------------------------------
// IP normalization / allowlist
// ---------------------------------------------------------------------------

/** Expand IPv6 into 8 hex groups (null on failure). */
function expandV6(ip: string): string[] | null {
  const addr = ip.split('%')[0]
  let head: string[]
  let tail: string[]
  if (addr.includes('::')) {
    const [h, t] = addr.split('::')
    head = h ? h.split(':') : []
    tail = t ? t.split(':') : []
  } else {
    head = addr.split(':')
    tail = []
  }
  // Forms ending in IPv4 (::ffff:1.2.3.4 etc.) are filtered out before the call
  const missing = 8 - head.length - tail.length
  if (missing < 0) return null
  const groups = [...head, ...Array(missing).fill('0'), ...tail]
  if (groups.length !== 8) return null
  return groups.map((g) => (g || '0').toLowerCase().replace(/^0+(?=.)/, ''))
}

/** Counting key: IPv4 as is, IPv4-mapped IPv6 as IPv4, IPv6 as its /64 prefix. */
export function ipKey(ip: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)
  if (mapped) return mapped[1]
  if (isIPv6(ip)) {
    const g = expandV6(ip)
    if (g) return `${g.slice(0, 4).join(':')}::/64`
  }
  return ip
}

const allowlist = new BlockList()
for (const entry of env.allowlistIps) {
  const [addr, prefix] = entry.split('/')
  const type = isIPv6(addr) ? 'ipv6' : 'ipv4'
  if (!isIPv4(addr) && !isIPv6(addr)) continue
  if (prefix !== undefined) allowlist.addSubnet(addr, Number(prefix), type)
  else allowlist.addAddress(addr, type)
}

export function isAllowlisted(ip: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)
  const addr = mapped ? mapped[1] : ip
  if (isIPv4(addr)) return allowlist.check(addr, 'ipv4')
  if (isIPv6(addr)) return allowlist.check(addr, 'ipv6')
  return false
}

// ---------------------------------------------------------------------------
// In-memory state (cap + periodic cleanup)
// ---------------------------------------------------------------------------

interface Counter {
  count: number
  windowStart: number
  lastFail: number
}

const ipFails = new Map<string, Counter>()
const acctFails = new Map<string, Counter>()
/** Active bans: ipKey → release time */
const bans = new Map<string, number>()
/** Re-ban level: ipKey → { level, lastBanAt } */
const strikes = new Map<string, { level: number; lastBanAt: number }>()

/** Insert keeping most-recently-used order; past the cap, drop the oldest first. */
function put<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key)
  map.set(key, value)
  if (map.size > MAX_ENTRIES) {
    const drop = map.size - Math.floor(MAX_ENTRIES * 0.9)
    let i = 0
    for (const k of map.keys()) {
      if (i++ >= drop) break
      map.delete(k)
    }
  }
}

function bump(map: Map<string, Counter>, key: string, now: number): Counter {
  const cur = map.get(key)
  const c: Counter =
    cur && now - cur.windowStart < WINDOW_MS
      ? { count: cur.count + 1, windowStart: cur.windowStart, lastFail: now }
      : { count: 1, windowStart: now, lastFail: now }
  put(map, key, c)
  return c
}

let sweeper: NodeJS.Timeout | null = null

function sweep(): void {
  const now = Date.now()
  for (const [k, c] of ipFails) if (now - c.windowStart >= WINDOW_MS) ipFails.delete(k)
  for (const [k, c] of acctFails) if (now - c.windowStart >= WINDOW_MS) acctFails.delete(k)
  for (const [k, until] of bans) if (until <= now) bans.delete(k)
  for (const [k, s] of strikes) if (now - s.lastBanAt >= STRIKE_MEMORY_MS) strikes.delete(k)
}

/** On boot, load active bans and recent ban levels from the DB into memory and start the cleanup timer. */
export async function initGuard(log: (msg: string) => void): Promise<void> {
  const now = Date.now()
  const rows = await db
    .select({ ip: ipBans.ip, bannedUntil: ipBans.bannedUntil, createdAt: ipBans.createdAt })
    .from(ipBans)
    .where(gt(ipBans.createdAt, new Date(now - STRIKE_MEMORY_MS)))
    .orderBy(ipBans.createdAt)
  for (const r of rows) {
    const until = r.bannedUntil.getTime()
    if (until > now) bans.set(r.ip, Math.max(until, bans.get(r.ip) ?? 0))
    const s = strikes.get(r.ip)
    strikes.set(r.ip, { level: (s?.level ?? 0) + 1, lastBanAt: r.createdAt.getTime() })
  }
  if (!sweeper) {
    sweeper = setInterval(sweep, 5 * 60_000)
    sweeper.unref()
  }
  if (bans.size) log(`[guard] restored ${bans.size} active IP ban(s)`)
}

// ---------------------------------------------------------------------------
// Checks / recording
// ---------------------------------------------------------------------------

/** Remaining ms while banned, else 0 */
export function banRemainingMs(ip: string): number {
  if (isAllowlisted(ip)) return 0
  const until = bans.get(ipKey(ip))
  if (!until) return 0
  const left = until - Date.now()
  if (left <= 0) {
    bans.delete(ipKey(ip))
    return 0
  }
  return left
}

/** 429 for a banned IP (call before expensive work) */
export function assertNotBanned(req: FastifyRequest): void {
  const left = banRemainingMs(req.ip)
  if (left > 0) throw tooMany(left / 1000)
}

/** Account backoff: an account past the failure limit cannot be retried for a while after its last failure */
export function assertAccount(account: string | null | undefined): void {
  if (!account) return
  const c = acctFails.get(account.toLowerCase())
  if (!c || Date.now() - c.windowStart >= WINDOW_MS) return
  const over = c.count - cfg.accountFailures
  if (over < 0) return
  const wait = Math.min(1000 * 2 ** over, ACCOUNT_BACKOFF_MAX_MS)
  const left = c.lastFail + wait - Date.now()
  if (left > 0) throw tooMany(left / 1000)
}

/** Record a failure. Bans the IP when the limit is reached. */
export async function recordFailure(
  req: FastifyRequest,
  reason: string,
  account?: string | null,
): Promise<void> {
  const now = Date.now()
  if (account) bump(acctFails, account.toLowerCase(), now)
  if (isAllowlisted(req.ip)) return
  const key = ipKey(req.ip)
  const c = bump(ipFails, key, now)
  if (c.count >= cfg.maxFailures) {
    await banIp(key, `auto:${reason}`, c.count, undefined, (m) => req.log.warn(m))
  }
}

/** Success: reset the failure counters of that IP and account (the ban level stays) */
export function recordSuccess(req: FastifyRequest, account?: string | null): void {
  ipFails.delete(ipKey(req.ip))
  if (account) acctFails.delete(account.toLowerCase())
}

/**
 * Ban an IP. Without durationMs the duration grows with the re-ban level. key is in ipKey form.
 * Returns the release time.
 */
export async function banIp(
  key: string,
  reason: string,
  failures: number,
  durationMs?: number,
  log?: (msg: string) => void,
): Promise<Date> {
  const now = Date.now()
  const prev = strikes.get(key)
  const level = prev && now - prev.lastBanAt < STRIKE_MEMORY_MS ? prev.level : 0
  const dur = durationMs ?? Math.min(BAN_BASE_MS * LADDER[Math.min(level, LADDER.length - 1)], BAN_MAX_MS)
  const until = now + dur
  bans.set(key, until)
  put(strikes, key, { level: level + 1, lastBanAt: now })
  ipFails.delete(key)
  log?.(`[guard] IP banned ${key} (${reason}, ${failures} failure(s), ${Math.round(dur / 60_000)} min)`)
  try {
    await db.insert(ipBans).values({ ip: key, reason, failures, bannedUntil: new Date(until) })
  } catch (err) {
    log?.(`[guard] failed to save ban record: ${String(err)}`)
  }
  return new Date(until)
}

/** Lift a ban, in memory and in the DB. The re-ban level is kept. */
export async function unbanIp(key: string): Promise<void> {
  bans.delete(key)
  ipFails.delete(key)
  await db
    .update(ipBans)
    .set({ bannedUntil: new Date() })
    .where(sql`${ipBans.ip} = ${key} and ${ipBans.bannedUntil} > now()`)
}

/** For the admin list */
export async function listBans(limit = 200) {
  const now = Date.now()
  const rows = await db.select().from(ipBans).orderBy(desc(ipBans.createdAt)).limit(limit)
  return rows.map((r) => ({
    ...r,
    active: r.bannedUntil.getTime() > now && (bans.get(r.ip) ?? 0) > now,
  }))
}

export const guardPolicy = () => ({
  windowMinutes: cfg.windowMinutes,
  maxFailures: cfg.maxFailures,
  banMinutes: cfg.banMinutes,
  banMaxHours: cfg.banMaxHours,
  accountFailures: cfg.accountFailures,
})

/**
 * Paths covered by the onRequest hook that cuts off banned IPs before expensive work.
 * Regular APIs used after sign-in (/auth/me etc.) are not blocked, so a legitimate user on the
 * same IP is not kicked out mid-edit; only the sign-in attempt and token-guessing surface is.
 */
const GUARDED = [
  /^\/api\/auth\/(login|register|reset-password|forgot-password|verify-email)(\/|\?|$)/,
  /^\/api\/oauth\/authorize(\/|\?|$)/,
  /^\/oauth\/(token|register)(\/|\?|$)/,
  /^\/api\/public\//,
]

export async function guardHook(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  // Match the route pattern Fastify resolved, not the raw URL: `/api/auth/log%69n` decodes to the
  // login route but slipped past regexes on req.url (C-L1). Unmatched URLs (404) have no pattern.
  const pattern = req.routeOptions?.url
  if (!pattern || !GUARDED.some((re) => re.test(pattern))) return
  const left = banRemainingMs(req.ip)
  if (left > 0) {
    const sec = Math.max(1, Math.ceil(left / 1000))
    return reply
      .code(429)
      .header('Retry-After', String(sec))
      .send({ error: { code: 'RATE_LIMITED', message: RATE_LIMIT_MESSAGE } })
  }
}

// ---------------------------------------------------------------------------
// Client IP behind trusted proxies (collab upgrades — Fastify does this for HTTP requests)
// ---------------------------------------------------------------------------

const PROXY_PRESETS: Record<string, string[]> = {
  loopback: ['127.0.0.0/8', '::1/128'],
  linklocal: ['169.254.0.0/16', 'fe80::/10'],
  uniquelocal: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', 'fc00::/7'],
}

function buildTrustList(entries: string[] | false): BlockList | null {
  if (entries === false) return null
  const list = new BlockList()
  for (const raw of entries) {
    for (const entry of PROXY_PRESETS[raw] ?? [raw]) {
      const [addr, prefix] = entry.split('/')
      if (isIPv4(addr)) {
        if (prefix !== undefined) list.addSubnet(addr, Number(prefix), 'ipv4')
        else list.addAddress(addr, 'ipv4')
      } else if (isIPv6(addr)) {
        if (prefix !== undefined) list.addSubnet(addr, Number(prefix), 'ipv6')
        else list.addAddress(addr, 'ipv6')
      }
    }
  }
  return list
}

const trustList = buildTrustList(env.trustProxy)

function isTrustedProxy(list: BlockList, ip: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)
  const addr = mapped ? mapped[1] : ip
  if (isIPv4(addr)) return list.check(addr, 'ipv4')
  if (isIPv6(addr)) return list.check(addr, 'ipv6')
  return false
}

/**
 * Same rule as Fastify's trustProxy (proxy-addr): starting from the socket peer, walk the
 * X-Forwarded-For chain right to left while the current hop is a trusted proxy (TRUST_PROXY);
 * the first untrusted hop is the client (C-L3). A forged XFF from an untrusted peer is ignored.
 */
export function trustedClientIp(
  remoteAddress: string | undefined,
  xff: string | string[] | undefined,
  list: BlockList | null = trustList,
): string {
  const peer = remoteAddress ?? 'unknown'
  if (!list) return peer
  const header = Array.isArray(xff) ? xff.join(',') : (xff ?? '')
  const hops = header
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
  let current = peer
  for (let i = hops.length - 1; i >= 0; i--) {
    if (!isTrustedProxy(list, current)) return current
    current = hops[i]
  }
  return current
}

export const _test = { buildTrustList }
