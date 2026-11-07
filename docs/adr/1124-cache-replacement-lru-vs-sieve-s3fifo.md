# 1124. Cache replacement: LRU kept (SIEVE and S3-FIFO measured, OPT as the bound)

- Status: Accepted (no change to any cache)
- Date: 2026-11-07

## Context
Every in-memory cache in Inkling evicts in LRU order: `BoundedLru` (`apps/server/src/lru.ts`, ADR
0753) behind the lock-chain cache (50,000 entries, ADR 1071), the agent-block and
instruction-presence caches (20,000) and the public share render cache (200 entries / 32 MB); the
section Markdown cache (`context/sectionSource.ts`, 4,000,000 characters, ADR 1041); the web math
render cache (`mathScheduler.ts` `RenderCache`, 2,000 entries / 8M characters, ADR 0998).

Two recent FIFO-based policies report higher hit ratios than LRU on large production traces:
SIEVE (Zhang et al., NSDI '24: one FIFO queue, a visited bit, a hand that evicts the first
unvisited object and clears bits on the way) and S3-FIFO (Yang et al., SOSP '23: a small FIFO
for new objects, a main FIFO, a ghost queue of recently dropped keys; most objects are read once
and leave through the small queue quickly). Both are also cheaper than LRU on a hit (a bit set,
no list move). The question was whether either would raise the hit ratio of *our* caches.

## Method
`apps/server/scripts/cache-sim.ts` (no database, deterministic per seed): LRU, SIEVE, S3-FIFO
(promotion threshold 1 and 2) and Belady's OPT (evict the object used farthest in the future — it
needs the whole trace, so it is the upper bound, not a policy), all on the same trace and capacity.
The simulated LRU is checked against the real `BoundedLru` on every unit-size trace (the script
fails on a mismatch). Traces:

- Synthetic: Zipf α = 0.8 / 1.0 / 1.2 over 20,000 keys; Zipf + one-hit-wonder scans; a cyclic
  loop + Zipf (LRU's worst case).
- `mcp`: agents reading sections, keyed like the real section cache (page, stored state, anchor):
  12 interleaved agent sessions, page popularity Zipf 0.9, a session reads 1–8 sections around
  the one find_context named, 30 % re-reads within the session, 4 % sessions sweep a long page,
  an edit (new keys for that page) with p = 0.03 per read. `mcp-chars`: the same with section
  sizes in characters and capacity in characters like the real cache.
- `acl`: write-path lock-chain lookups, 40 workspaces × 2,000 pages, access-version bumps.
- `math-scroll`: scrolling a page of 4,000 formulas (more than the cache holds).
- `bench`: the read sequence of `large-page-bench.ts` itself.

## Results (hit ratio, seed 1; on `mcp`, `mcp-chars` and `acl`, seeds 2 and 3 give the same order and policy differences within 1 pp)

| Trace | Capacity | LRU | SIEVE | S3-FIFO | OPT |
|---|---:|---:|---:|---:|---:|
| Zipf 1.0 | 200 entries | 43.0% | 53.7% | 53.6% | 61.1% |
| Zipf 1.0 | 2,000 | 69.5% | 74.3% | 74.6% | 82.0% |
| Zipf + scan | 1,000 | 34.4% | 45.2% | 45.8% | 50.7% |
| Loop + Zipf | 800 | 53.4% | 45.4% | 53.8% | 75.8% |
| mcp | 25 entries | 72.0% | 66.7% | 66.0% | 76.1% |
| mcp | 400 | 77.0% | 76.6% | 76.8% | 81.3% |
| mcp-chars | 4,000,000 chars (current) | 78.1% | 77.9% | 77.8% | 82.7% (size-oblivious Belady) |
| acl | 500 entries | 32.3% | 34.6% | 40.7% | 53.0% |
| acl | 50,000 (current) | 69.4% | 69.4% | 69.4% | 69.5% |
| math-scroll | 2,000 (current) | 84.3% | 77.8% | 84.5% | 92.1% |
| bench | ≥ 64 (current holds ≈ 150 sections) | 57.0% | 57.0% | 57.0% | 57.0% |

Full curves (7 capacities per trace) are printed by the script.

## Decision
No cache changes policy. On the independent-request synthetic traces SIEVE and S3-FIFO beat LRU by
5–13 pp, as the papers report — but none of our caches sees that workload:

- **Section cache (mcp, mcp-chars):** agent reads have strong *recency* (a session re-reads the
  sections it just read, interleaved with other agents). LRU is the best real policy at every
  capacity: −5.2 pp for SIEVE at 25 entries, −0.1 to −0.2 pp at the current 4M characters. The gap
  to OPT (4.6 pp) is what a policy could still win; FIFO-based quick demotion moves the wrong way.
  (This cache is in `context/**`; nothing would have been changed there in any case — the
  recommendation is to leave it.)
- **Lock chains (acl):** at the current 50,000 entries every policy equals OPT (69.4 vs 69.5 %):
  the misses are first accesses after a version bump, which no eviction policy can avoid. S3-FIFO
  only wins at 500–2,000 entries (+2.5 to +8.4 pp), a size we do not use.
- **Math render cache:** S3-FIFO +0.2 to +0.6 pp at 2,000–4,000 entries (noise), SIEVE −6.5 pp:
  scrolling back and forth is recency again.
- **Bench sequence:** every policy reaches the compulsory-miss ceiling at the real capacity.

The +5 pp bar set for adopting a new policy is not met anywhere that matters, so no latency was
measured and `BoundedLru` stays as it is.

## Why this data structure, and where it does not fit
- **LRU** (a `Map` in recency order) evicts the least recently used object: right when "used
  recently" predicts "used again soon", which is what agent sessions, editors and scrolling do.
  It is wrong for scans (one pass of new keys flushes everything) and loops longer than the cache
  (every access misses — the loop trace at 800 entries, where SIEVE drops to 45 % and OPT keeps 76 %).
- **SIEVE / S3-FIFO** assume most objects are requested once ("one-hit wonders") and protect the
  ones seen twice. True for CDN and key-value traces; not for our caches, whose keys are mostly
  re-read within seconds (session re-reads) or are cold after a version bump (nothing to protect).
- **OPT** cannot be built (it needs the future), but it bounds every policy on a trace; here the
  remaining gap at the real capacities (0.1–8 pp) comes from first accesses and short-term
  re-reads, not from a wrong eviction order. With variable sizes (characters) "farthest next use"
  is only a heuristic, as optimal caching with sizes is NP-hard; the column is labelled so.

## Alternatives considered
- Switching `BoundedLru` to SIEVE for the cheaper hit path: the hit path is one `Map` delete + set
  on caches that see a few hundred lookups per second; not measurable against the database
  round trips around them (ADR 0759), and it would cost hit ratio on the section cache.
- Raising capacities instead: the acl and bench traces are already at the compulsory ceiling.

## Consequences
- `cache-sim.ts` stays in the repo to repeat the comparison when a cache or its access pattern
  changes (e.g. a new trace from logs). Rows under "Rejected / no effect" in docs/PERFORMANCE.md.
- The synthetic traces are models, not production logs; a logged access trace of the section
  cache would be the next step if it ever shows pressure.

## References
- ADR 0753 (`BoundedLru`), ADR 0998 (math cache; LRU vs distance eviction for the resident cap),
  ADR 1041 (section cache), ADR 1071 (version-keyed caches).
- Zhang et al., "SIEVE is Simpler than LRU", NSDI 2024. Yang et al., "FIFO queues are all you
  need for cache eviction", SOSP 2023. Belady, "A study of replacement algorithms for a
  virtual-storage computer", IBM Systems Journal 1966.
