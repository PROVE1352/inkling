/**
 * Cache replacement simulator (docs/adr/1124-*). Not part of CI; no database, no server.
 *
 *   cd apps/server
 *   npx tsx scripts/cache-sim.ts                 all traces, Markdown tables on stdout
 *   npx tsx scripts/cache-sim.ts --json out.json also write every number as JSON
 *   npx tsx scripts/cache-sim.ts --trace mcp     one trace (zipf | zipf+scan | loop | mcp | mcp-chars | acl | math | bench)
 *   npx tsx scripts/cache-sim.ts --seed 2        another seed (traces are deterministic per seed)
 *
 * Policies, all on the same trace and the same capacity:
 *   LRU      Map in recency order (what `BoundedLru` and the section cache do). Checked against the
 *            real `BoundedLru` class on every count-based trace (the script fails on a mismatch).
 *   SIEVE    Zhang et al., NSDI '24: one FIFO queue, a "visited" bit per object, and a hand that
 *            moves from the oldest object towards the newest; a visited object loses its bit and
 *            stays in place, the first unvisited one is evicted. A hit only sets a bit (no move).
 *   S3-FIFO  Yang et al., SOSP '23: small FIFO S (10 % of the capacity), main FIFO M (90 %), ghost
 *            FIFO G of keys only (as many as M holds). New keys go to S (to M when found in G).
 *            A 2-bit frequency counter per object (max 3). Evicting from S moves an object to M
 *            when its counter reached the threshold, otherwise drops it and remembers its key in G.
 *            Evicting from M reinserts objects with counter > 0 (counter − 1). Threshold 1 (moved
 *            when re-read once in S) and 2 (the strict reading of the paper's pseudocode) are both run.
 *   OPT      Belady's MIN: evict the object whose next use is farthest in the future. Needs the
 *            whole trace in advance, so it is an upper bound, not a policy. With unit sizes it is
 *            optimal; with variable sizes (the `mcp-chars` trace) "farthest next use" is only a
 *            strong heuristic (optimal caching with sizes is NP-hard), so that column is labelled.
 *
 * Hit ratio = hits / requests, misses counting the cold (first) access of every key, the same way
 * for every policy. Objects bigger than a quarter of the capacity are never admitted (the rule of
 * the section cache, sectionSource.ts), for every policy.
 */
import { writeFileSync } from 'node:fs'
import { BoundedLru } from '../src/lru'

// ---------------------------------------------------------------------------
// trace model
// ---------------------------------------------------------------------------

interface Trace {
  name: string
  description: string
  keys: string[]
  /** Size of each request's object (units of the capacity). Unit sizes when absent. */
  sizes?: number[]
  /** Capacities to run, in the same units. */
  capacities: number[]
  /** Label of the capacity unit. */
  unit: string
  /** Capacity the real cache uses, if one maps to this trace. */
  current?: number
}

function rng(seed: number): () => number {
  // mulberry32
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Zipf(α) sampler over 0..n-1 (rank 0 most popular), by inverse CDF + binary search. */
function zipf(n: number, alpha: number, r: () => number): () => number {
  const cdf = new Float64Array(n)
  let sum = 0
  for (let i = 0; i < n; i++) {
    sum += 1 / Math.pow(i + 1, alpha)
    cdf[i] = sum
  }
  for (let i = 0; i < n; i++) cdf[i] /= sum
  return () => {
    const u = r()
    let lo = 0
    let hi = n - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (cdf[mid] < u) lo = mid + 1
      else hi = mid
    }
    return lo
  }
}

/** A permutation so popularity rank is not the key order (keys are opaque strings anyway). */
function shuffle(n: number, r: () => number): Int32Array {
  const p = new Int32Array(n)
  for (let i = 0; i < n; i++) p[i] = i
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1))
    const t = p[i]
    p[i] = p[j]
    p[j] = t
  }
  return p
}

const CAPS_SMALL = [50, 100, 200, 500, 1_000, 2_000, 5_000]

function traceZipf(seed: number, alpha: number): Trace {
  const r = rng(seed)
  const n = 20_000
  const z = zipf(n, alpha, r)
  const perm = shuffle(n, r)
  const keys: string[] = []
  for (let i = 0; i < 200_000; i++) keys.push(`k${perm[z()]}`)
  return {
    name: `zipf-${alpha}`,
    description: `Zipf α=${alpha} over 20,000 keys, 200,000 requests (independent requests, no time locality beyond popularity)`,
    keys,
    capacities: CAPS_SMALL,
    unit: 'entries',
  }
}

function traceScan(seed: number): Trace {
  // Zipf 1.0 working set + one-hit-wonder scans: every 2,000 requests a burst of 1,000 new keys
  // read once (an export, a crawler, a bulk re-index) — the case LRU is known to handle badly.
  const r = rng(seed)
  const n = 20_000
  const z = zipf(n, 1.0, r)
  const perm = shuffle(n, r)
  const keys: string[] = []
  let scanId = 0
  for (let i = 0; i < 200_000; i++) {
    keys.push(`k${perm[z()]}`)
    if (i % 2_000 === 1_999) for (let s = 0; s < 1_000; s++) keys.push(`scan${scanId++}`)
  }
  return {
    name: 'zipf+scan',
    description: 'Zipf α=1.0 over 20,000 keys (200,000 requests) with a burst of 1,000 never-repeated keys after every 2,000 requests (100,000 scan requests)',
    keys,
    capacities: CAPS_SMALL,
    unit: 'entries',
  }
}

function traceLoop(seed: number): Trace {
  // Ping-pong / loop: a cyclic sweep over L keys, mixed with Zipf noise. LRU's worst case: with
  // capacity < L every cyclic access misses.
  const r = rng(seed)
  const z = zipf(5_000, 1.0, r)
  const keys: string[] = []
  const L = 1_000
  for (let i = 0; i < 200_000; i++) {
    if (r() < 0.5) keys.push(`loop${i % L}`)
    else keys.push(`z${z()}`)
  }
  return {
    name: 'loop+zipf',
    description: 'Half the requests sweep 1,000 keys in a fixed cycle, half Zipf α=1.0 over 5,000 keys; 200,000 requests',
    keys,
    capacities: [100, 200, 500, 800, 1_000, 1_500, 2_000],
    unit: 'entries',
  }
}

/**
 * MCP agents reading sections (the section Markdown cache, sectionSource.ts, ADR 1041). Key =
 * (page, stored state, anchor), as the real cache keys it, so an edit makes every key of that page
 * new. Shape taken from how agents use the tools (ADR 0927, 0928, 1041) and the large-page bench:
 * - 3,000 pages, popularity Zipf α=0.9; 85 % have 3–15 sections, 15 % 30–180 (long logs).
 * - 12 agents at a time, requests interleaved at random. A session: one page, 1–8 section reads —
 *   first the section find_context pointed at (Zipf α=1.0 over the page's sections), then mostly
 *   neighbours (anchor ± 1..2); 30 % of reads go back to a section read earlier in the session
 *   (the "two alternating sections" pattern of the bench).
 * - 4 % of sessions sweep a long page section by section (summarise / review a log): a scan.
 * - An edit lands on a page (popularity-weighted) with probability 0.03 per request; the page's
 *   state changes, so all of its cached sections become dead keys.
 * Section sizes (for the `mcp-chars` variant): lognormal around 1,500 characters for short pages,
 * around 12,000 for long ones (the 4.5 MB page: ≈ 26 KB of Markdown per section on average).
 */
function traceMcp(seed: number, withSizes: boolean): Trace {
  const r = rng(seed)
  const P = 3_000
  const pagePick = zipf(P, 0.9, r)
  const perm = shuffle(P, r)
  const nSec = new Int32Array(P)
  const long = new Uint8Array(P)
  for (let p = 0; p < P; p++) {
    if (r() < 0.15) {
      long[p] = 1
      nSec[p] = 30 + Math.floor(r() * 151)
    } else nSec[p] = 3 + Math.floor(r() * 13)
  }
  const version = new Int32Array(P)
  const gauss = () => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r())
  const sizeOf = new Map<string, number>()
  const secSize = (p: number, s: number) => {
    const k = `${p}:${s}`
    let v = sizeOf.get(k)
    if (v === undefined) {
      v = Math.max(80, Math.round(Math.exp(Math.log(long[p] ? 12_000 : 1_500) + 0.8 * gauss())))
      sizeOf.set(k, v)
    }
    return v
  }
  type Session = { page: number; left: number; read: number[]; cur: number; sweep: boolean }
  const secPickers = new Map<number, () => number>()
  const newSession = (): Session => {
    const sweep = r() < 0.04
    let page = perm[pagePick()]
    if (sweep) {
      // a long page
      for (let g = 0; g < 50 && !long[page]; g++) page = perm[pagePick()]
    }
    if (!secPickers.has(nSec[page])) secPickers.set(nSec[page], zipf(nSec[page], 1.0, r))
    const first = secPickers.get(nSec[page])!()
    return { page, left: sweep ? nSec[page] : 1 + Math.floor(r() * 8), read: [], cur: sweep ? 0 : first, sweep }
  }
  const agents: Session[] = Array.from({ length: 12 }, newSession)
  const keys: string[] = []
  const sizes: number[] = []
  const REQ = 200_000
  while (keys.length < REQ) {
    if (r() < 0.03) {
      const p = perm[pagePick()]
      version[p]++
      continue
    }
    const ai = Math.floor(r() * agents.length)
    const a = agents[ai]
    let s: number
    if (a.sweep) s = a.cur++
    else if (a.read.length && r() < 0.3) s = a.read[Math.floor(r() * a.read.length)]
    else if (a.read.length) s = Math.min(nSec[a.page] - 1, Math.max(0, a.cur + (r() < 0.5 ? -1 : 1) * (1 + Math.floor(r() * 2))))
    else s = a.cur
    a.cur = s
    a.read.push(s)
    keys.push(`${a.page}@${version[a.page]}#${s}`)
    sizes.push(secSize(a.page, s))
    if (--a.left <= 0) agents[ai] = newSession()
  }
  if (!withSizes) {
    return {
      name: 'mcp',
      description: 'MCP agents reading sections (model in the script header), 200,000 section reads, unit sizes',
      keys,
      capacities: [25, 50, 100, 200, 400, 800, 1_600],
      unit: 'entries',
    }
  }
  return {
    name: 'mcp-chars',
    description: 'Same trace with section sizes in characters; capacity in characters like the real cache (4,000,000)',
    keys,
    sizes,
    capacities: [125_000, 250_000, 500_000, 1_000_000, 2_000_000, 4_000_000, 8_000_000],
    unit: 'chars',
    current: 4_000_000,
  }
}

/**
 * Lock-chain cache of the write path (editLock.ts chainCache, ADR 1071): key = (page, access
 * version). Writes hit pages with Zipf popularity; an access-version bump (lock change, move,
 * member change…) makes every key of the workspace new. 40 workspaces, 2,000 pages each, Zipf 1.1
 * across workspaces; a bump in a workspace with probability 0.0005 per write.
 */
function traceAcl(seed: number): Trace {
  const r = rng(seed)
  const W = 40
  const wsPick = zipf(W, 1.1, r)
  const pagePick = zipf(2_000, 1.0, r)
  const ver = new Int32Array(W)
  const keys: string[] = []
  for (let i = 0; i < 200_000; i++) {
    const w = wsPick()
    if (r() < 0.0005) ver[w]++
    keys.push(`${w}:${pagePick()}@${ver[w]}`)
  }
  return {
    name: 'acl',
    description: 'Write path lock-chain lookups: 40 workspaces × 2,000 pages, Zipf 1.1 / 1.0, access-version bump p=0.0005 per write; 200,000 writes',
    keys,
    capacities: [500, 1_000, 2_000, 5_000, 10_000, 20_000, 50_000],
    unit: 'entries',
    current: 50_000,
  }
}

/**
 * Web math render cache (mathScheduler.ts RenderCache, 2,000 entries, ADR 0998): a reader scrolls
 * a long page of 4,000 distinct formulas (more than the cache holds) — a random walk of the
 * viewport (≈ 30 formulas on screen, ± 0–60 per step, 2 % jumps anywhere: the outline / search),
 * plus another open page of 300 formulas visited between reading sessions.
 */
function traceMath(seed: number): Trace {
  const r = rng(seed)
  const F = 4_000
  const keys: string[] = []
  let top = 0
  while (keys.length < 200_000) {
    if (r() < 0.02) top = Math.floor(r() * F)
    else top = Math.min(F - 30, Math.max(0, top + Math.round((r() - 0.45) * 120)))
    for (let i = 0; i < 30; i++) keys.push(`f${top + i}`)
    if (r() < 0.005) for (let i = 0; i < 300; i++) keys.push(`other${i}`)
  }
  return {
    name: 'math-scroll',
    description: 'Scrolling a page of 4,000 formulas (random-walk viewport of 30, 2 % jumps) and now and then another page of 300 formulas',
    keys,
    capacities: [250, 500, 1_000, 2_000, 3_000, 4_000],
    unit: 'entries',
    current: 2_000,
  }
}

/** The access pattern of apps/server/scripts/large-page-bench.ts itself (two alternating anchors, then 32 concurrent reads of anchors (i·7+3) mod 181). */
function traceBench(): Trace {
  const keys: string[] = []
  for (let i = 0; i < 31; i++) keys.push(`A#${i % 2 ? 'mid' : 'last'}`)
  for (let i = 0; i < 32; i++) keys.push(`A#${(i * 7 + 3) % 181}`)
  for (let i = 0; i < 16; i++) keys.push(`A#${i % 2 ? 'mid' : 'last'}`)
  return {
    name: 'bench',
    description: 'The large-page bench\'s own read sequence (79 reads, 34 distinct sections)',
    keys,
    capacities: [1, 2, 4, 8, 16, 32, 64],
    unit: 'entries',
  }
}

// ---------------------------------------------------------------------------
// policies
// ---------------------------------------------------------------------------

interface Policy {
  /** Returns true on a hit. */
  access(key: string, size: number, t: number): boolean
}

class Lru implements Policy {
  private readonly m = new Map<string, number>()
  private used = 0
  constructor(private readonly cap: number) {}
  access(key: string, size: number): boolean {
    const s = this.m.get(key)
    if (s !== undefined) {
      this.m.delete(key)
      this.m.set(key, s)
      return true
    }
    if (size > this.cap / 4 && this.cap >= 4) return false
    this.m.set(key, size)
    this.used += size
    while (this.used > this.cap) {
      const [k, v] = this.m.entries().next().value as [string, number]
      this.m.delete(k)
      this.used -= v
    }
    return false
  }
}

/** Doubly linked FIFO over integer slots (head = newest, tail = oldest). */
class Fifo {
  prev: Int32Array
  next: Int32Array
  head = -1
  tail = -1
  len = 0
  constructor(n: number) {
    this.prev = new Int32Array(n).fill(-1)
    this.next = new Int32Array(n).fill(-1)
  }
  pushHead(i: number): void {
    this.prev[i] = -1
    this.next[i] = this.head
    if (this.head >= 0) this.prev[this.head] = i
    this.head = i
    if (this.tail < 0) this.tail = i
    this.len++
  }
  remove(i: number): void {
    const p = this.prev[i]
    const n = this.next[i]
    if (p >= 0) this.next[p] = n
    else this.head = n
    if (n >= 0) this.prev[n] = p
    else this.tail = p
    this.prev[i] = this.next[i] = -1
    this.len--
  }
}

/** Interns keys to dense integers so policies can use typed arrays. */
class Slots {
  readonly id = new Map<string, number>()
  constructor(readonly n: number) {}
}

class Sieve implements Policy {
  private readonly at = new Map<string, number>()
  private readonly q: Fifo
  private readonly visited: Uint8Array
  private readonly size: Float64Array
  private readonly keyOf: string[] = []
  private hand = -1
  private used = 0
  constructor(private readonly cap: number, private readonly slots: Slots) {
    this.q = new Fifo(slots.n)
    this.visited = new Uint8Array(slots.n)
    this.size = new Float64Array(slots.n)
  }
  access(key: string, size: number): boolean {
    const i = this.at.get(key)
    if (i !== undefined) {
      this.visited[i] = 1
      return true
    }
    if (size > this.cap / 4 && this.cap >= 4) return false
    while (this.used + size > this.cap && this.q.len > 0) this.evict()
    const s = this.slots.id.get(key)!
    this.keyOf[s] = key
    this.at.set(key, s)
    this.visited[s] = 0
    this.size[s] = size
    this.q.pushHead(s)
    this.used += size
    return false
  }
  private evict(): void {
    let o = this.hand >= 0 ? this.hand : this.q.tail
    while (this.visited[o]) {
      this.visited[o] = 0
      o = this.q.prev[o] >= 0 ? this.q.prev[o] : this.q.tail
    }
    this.hand = this.q.prev[o]
    this.q.remove(o)
    this.at.delete(this.keyOf[o])
    this.used -= this.size[o]
  }
}

class S3Fifo implements Policy {
  private readonly where = new Map<string, number>() // slot
  private readonly inS: Uint8Array
  private readonly freq: Uint8Array
  private readonly size: Float64Array
  private readonly keyOf: string[] = []
  private readonly S: Fifo
  private readonly M: Fifo
  private usedS = 0
  private usedM = 0
  private readonly ghost = new Map<string, number>() // key → size, insertion order = FIFO
  private ghostUsed = 0
  private readonly capS: number
  private readonly capM: number
  constructor(private readonly cap: number, slots: Slots, private readonly threshold: number) {
    this.inS = new Uint8Array(slots.n)
    this.freq = new Uint8Array(slots.n)
    this.size = new Float64Array(slots.n)
    this.S = new Fifo(slots.n)
    this.M = new Fifo(slots.n)
    this.capS = Math.max(1, cap * 0.1)
    this.capM = cap - this.capS
    this.slots = slots
  }
  private readonly slots: Slots
  access(key: string, size: number): boolean {
    const i = this.where.get(key)
    if (i !== undefined) {
      if (this.freq[i] < 3) this.freq[i]++
      return true
    }
    if (size > this.cap / 4 && this.cap >= 4) return false
    while (this.usedS + this.usedM + size > this.cap && this.S.len + this.M.len > 0) this.evict()
    const s = this.slots.id.get(key)!
    this.keyOf[s] = key
    this.where.set(key, s)
    this.freq[s] = 0
    this.size[s] = size
    if (this.ghost.has(key)) {
      this.ghostUsed -= this.ghost.get(key)!
      this.ghost.delete(key)
      this.inS[s] = 0
      this.M.pushHead(s)
      this.usedM += size
    } else {
      this.inS[s] = 1
      this.S.pushHead(s)
      this.usedS += size
    }
    return false
  }
  private evict(): void {
    if (this.usedS >= this.capS || this.M.len === 0) this.evictS()
    else this.evictM()
  }
  /** Frees at least one object (from S, or from M when moving S's tail overfills M). */
  private evictS(): void {
    while (this.S.len > 0) {
      const t = this.S.tail
      this.S.remove(t)
      this.usedS -= this.size[t]
      if (this.freq[t] >= this.threshold) {
        // promoted: counter restarts in M (it must earn its reinsertions there)
        this.inS[t] = 0
        this.freq[t] = 0
        this.M.pushHead(t)
        this.usedM += this.size[t]
        if (this.usedM > this.capM) {
          this.evictM()
          return
        }
      } else {
        const k = this.keyOf[t]
        this.where.delete(k)
        this.ghost.set(k, this.size[t])
        this.ghostUsed += this.size[t]
        while (this.ghostUsed > this.capM) {
          const [gk, gs] = this.ghost.entries().next().value as [string, number]
          this.ghost.delete(gk)
          this.ghostUsed -= gs
        }
        return
      }
    }
    if (this.M.len > 0) this.evictM()
  }
  private evictM(): void {
    while (this.M.len > 0) {
      const t = this.M.tail
      this.M.remove(t)
      if (this.freq[t] > 0) {
        this.freq[t]--
        this.M.pushHead(t)
      } else {
        this.usedM -= this.size[t]
        this.where.delete(this.keyOf[t])
        return
      }
    }
  }
}

/** Belady's MIN with a lazy max-heap on next use. */
class Opt implements Policy {
  private readonly nextUse: Int32Array
  private readonly cached = new Map<string, { next: number; size: number }>()
  private heap: { next: number; key: string }[] = []
  private used = 0
  constructor(private readonly cap: number, keys: string[]) {
    this.nextUse = new Int32Array(keys.length)
    const last = new Map<string, number>()
    for (let t = keys.length - 1; t >= 0; t--) {
      this.nextUse[t] = last.get(keys[t]) ?? 0x7fffffff
      last.set(keys[t], t)
    }
  }
  private push(e: { next: number; key: string }): void {
    const h = this.heap
    h.push(e)
    let i = h.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (h[p].next >= h[i].next) break
      ;[h[p], h[i]] = [h[i], h[p]]
      i = p
    }
  }
  private pop(): { next: number; key: string } {
    const h = this.heap
    const top = h[0]
    const last = h.pop()!
    if (h.length) {
      h[0] = last
      let i = 0
      for (;;) {
        const l = 2 * i + 1
        const r = l + 1
        let m = i
        if (l < h.length && h[l].next > h[m].next) m = l
        if (r < h.length && h[r].next > h[m].next) m = r
        if (m === i) break
        ;[h[m], h[i]] = [h[i], h[m]]
        i = m
      }
    }
    return top
  }
  access(key: string, size: number, t: number): boolean {
    const nu = this.nextUse[t]
    const c = this.cached.get(key)
    if (c) {
      c.next = nu
      this.push({ next: nu, key })
      return true
    }
    if (size > this.cap / 4 && this.cap >= 4) return false
    // Never cache an object that is not used again, or whose next use is farther than everything
    // cached when the cache is full (MIN bypass) — the bound is for an admission-free cache too.
    if (nu === 0x7fffffff) return false
    this.cached.set(key, { next: nu, size })
    this.used += size
    this.push({ next: nu, key })
    while (this.used > this.cap) {
      const top = this.pop()
      const e = this.cached.get(top.key)
      if (!e || e.next !== top.next) continue // stale heap entry
      this.cached.delete(top.key)
      this.used -= e.size
    }
    return false
  }
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

const POLICIES = ['LRU', 'SIEVE', 'S3-FIFO', 'S3-FIFO(t=2)', 'OPT'] as const
type PolicyName = (typeof POLICIES)[number]

function make(name: PolicyName, cap: number, slots: Slots, keys: string[]): Policy {
  switch (name) {
    case 'LRU':
      return new Lru(cap)
    case 'SIEVE':
      return new Sieve(cap, slots)
    case 'S3-FIFO':
      return new S3Fifo(cap, slots, 1)
    case 'S3-FIFO(t=2)':
      return new S3Fifo(cap, slots, 2)
    case 'OPT':
      return new Opt(cap, keys)
  }
}

function run(trace: Trace): Record<string, Record<PolicyName, number>> {
  const slots = new Slots(0)
  for (const k of trace.keys) if (!slots.id.has(k)) slots.id.set(k, slots.id.size)
  const sl = new Slots(slots.id.size)
  for (const [k, v] of slots.id) sl.id.set(k, v)
  const out: Record<string, Record<PolicyName, number>> = {}
  for (const cap of trace.capacities) {
    const row = {} as Record<PolicyName, number>
    for (const name of POLICIES) {
      const p = make(name, cap, sl, trace.keys)
      let hits = 0
      for (let t = 0; t < trace.keys.length; t++) if (p.access(trace.keys[t], trace.sizes ? trace.sizes[t] : 1, t)) hits++
      row[name] = hits / trace.keys.length
    }
    // Cross-check the simulated LRU against the production class on unit-size traces.
    if (!trace.sizes) {
      const real = new BoundedLru<true>(cap, 3_600_000)
      let hits = 0
      for (const k of trace.keys) {
        if (real.get(k) !== undefined) hits++
        else real.set(k, true)
      }
      if (Math.abs(hits / trace.keys.length - row.LRU) > 1e-12) {
        throw new Error(`LRU model differs from BoundedLru on ${trace.name} @ ${cap}: ${hits / trace.keys.length} vs ${row.LRU}`)
      }
    }
    out[String(cap)] = row
  }
  return out
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`
}

const arg = (name: string) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined)
const seed = Number(arg('--seed') ?? 1)
const only = arg('--trace')
const all: (() => Trace)[] = [
  () => traceZipf(seed, 0.8),
  () => traceZipf(seed, 1.0),
  () => traceZipf(seed, 1.2),
  () => traceScan(seed),
  () => traceLoop(seed),
  () => traceMcp(seed, false),
  () => traceMcp(seed, true),
  () => traceAcl(seed),
  () => traceMath(seed),
  () => traceBench(),
]
const results: Record<string, { description: string; unit: string; uniqueKeys: number; requests: number; current?: number; rows: Record<string, Record<PolicyName, number>> }> = {}
for (const mk of all) {
  const trace = mk()
  if (only && !trace.name.startsWith(only)) continue
  const started = performance.now()
  const rows = run(trace)
  const unique = new Set(trace.keys).size
  results[trace.name] = { description: trace.description, unit: trace.unit, uniqueKeys: unique, requests: trace.keys.length, current: trace.current, rows }
  const coldCeiling = 1 - unique / trace.keys.length
  console.log(`\n### ${trace.name}\n\n${trace.description}. ${unique.toLocaleString('en')} distinct keys; no cache can exceed ${pct(coldCeiling)} (every first access misses).${trace.current ? ` Current capacity: ${trace.current.toLocaleString('en')} ${trace.unit}.` : ''}\n`)
  console.log(`| Capacity (${trace.unit}) | LRU | SIEVE | S3-FIFO | S3-FIFO (t=2) | ${trace.sizes ? 'Belady (size-oblivious)' : 'OPT'} | best real − LRU |`)
  console.log('|---:|---:|---:|---:|---:|---:|---:|')
  for (const [cap, row] of Object.entries(rows)) {
    const best = Math.max(row.SIEVE, row['S3-FIFO'], row['S3-FIFO(t=2)'])
    const d = (best - row.LRU) * 100
    console.log(`| ${Number(cap).toLocaleString('en')} | ${pct(row.LRU)} | ${pct(row.SIEVE)} | ${pct(row['S3-FIFO'])} | ${pct(row['S3-FIFO(t=2)'])} | ${pct(row.OPT)} | ${d >= 0 ? '+' : ''}${d.toFixed(1)} pp |`)
  }
  console.error(`[cache-sim] ${trace.name}: ${(performance.now() - started).toFixed(0)} ms`)
}
const out = arg('--json')
if (out) writeFileSync(out, JSON.stringify({ seed, results }, null, 2))
