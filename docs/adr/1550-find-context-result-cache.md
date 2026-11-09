# 1550. find_context result cache: per person, keyed by every permission input and index marker

- Status: Accepted
- Date: 2026-11-09

## Context
With several agents working for one person (a chat client, a coding agent, a background job), the
same `find_context` question arrives again and again within minutes: each agent starts with it, and
an agent loop repeats it after every step. Every call ran the full retrieval statement (three index
probes, word weights, ranking over up to 300 candidates; ADR 0927, 1210) although nothing had
changed. The result is per person: it depends on the workspaces the person may search and on what
they may see in them, so a cache must never hand one person's answer to another, and must never
outlive a permission change, an edit, or the reindex that follows an edit.

## Decision
**What is cached:** the REST route's `FindContextResult` (`GET /api/context`, `context/contextCache.ts`),
not the tool text. Everything per call and per connection stays live on every call, hit or miss:
`can:` lines, lock and instruction state, `applies:`, review facts, ink markers, read counters
(`mcpTools/contextTools.ts` unchanged).

**Key** (the person in clear, then a SHA-256 of the rest):

| Part | Covers |
|---|---|
| user id | never across people |
| token or browser request | guest workspaces are hidden from tokens (ADR 1253) |
| connection range (kind, root page, workspaces) | ADR 1200 |
| guest scope (workspaces where the account is a guest) | ADR 1252 |
| searched workspace ids, read fresh each call with the rules of `memberWorkspaceIds` | membership, deleted workspaces, agent blocks (0947), the 2FA rule and its deadline (1112, 1300), the range's workspaces |
| per workspace: access version | locks, owners, moves, roles, agent blocks, page grants (ADR 1071 bump list) |
| per workspace: max(updated_at, deleted_at) and live page count | titles, privacy (scope is not in the 1071 bump list), trash, restore, new and duplicated pages, recency |
| per workspace: section index epoch (`versions.ts chunkEpoch`) | the reindex after an edit (debounced, ADR 0750), which changes chunks without touching `pages` |
| normalised query (NFKC, lower case, collapsed spaces), budget | what retrieval itself sees (`rank.ts queryGroups`, phrase) |

The workspace list and its markers come from one statement; the in-process epochs are read after it
and before the retrieval. Version before data (ADR 1071): a change between marker and retrieval can
only make the stored entry unreachable (a later miss), never put old data under a new marker.

**Sharing:** never between people. Connections of one person share an entry when the key is equal:
retrieval is a function of exactly these inputs (the SQL reads the user id, the range and guest scope
from the request scope, the workspace list, and data covered by the markers), so equal keys give equal
answers. A browser session and an agent of the same person do not share (token vs browser part), since
for an account with page grants the two see different workspaces. Sharing between people was not
built: two people could only share when neither has private pages, guest rows or a range in play, and
proving that per entry costs about what it saves.

**Memory:** `BoundedLru` (lru.ts, reused): 1,000 entries, 32 MB by a size estimate of the stored strings,
5-minute TTL. The TTL bounds memory and the multi-process case below, not correctness.

**Per process:** the section index epoch is process-local, like `indexEpoch` (ADR 0752). Inkling runs
one process (ADR 1240, OPERATIONS.md §3). With two processes, a reindex in the other one would leave an
entry readable until its page markers move (the edit's store already moved `updated_at`, which is
before the reindex) or the 5-minute TTL; the access version and page markers are database values and
stay exact across processes. A database marker for the index (max `page_chunk_index.indexed_at` per
workspace) would close this, at one primary-key lookup per page of the workspace on every call; not
worth it for a deployment that is not supported.

## Alternatives considered
- **Cache the tool text:** would also save the review/ink/agent-context statements, but would freeze
  `can:` and lock lines that change with the access version of single pages and with the connection's
  read/write scope; rejected for correctness.
- **Key per connection (grant):** simpler to explain, but three agents of one person asking the same
  question would miss three times; the permission inputs are all in the key, so the connection adds
  nothing.
- **Global `indexEpoch` instead of a per-workspace epoch:** every link, tag or task write anywhere would
  empty the cache for everybody.
- **Invalidate by events (delete entries on writes):** needs every writer to know the cache; markers
  read on the hit path are cheaper to keep correct.

## Consequences
- A hit costs one statement (workspace list + markers) instead of the retrieval statement; the miss
  path costs that statement plus the retrieval (the old path ran `memberWorkspaceIds`, the same size).
  Measured in docs/PERFORMANCE.md ("find_context, three agents repeating questions").
- Hits are counted on the connection's usage (ADR 1552); tokens are counted as returned, hit or miss.
- Tests: `apps/server/src/mcpTools/agentEfficiency.db.test.ts` (same connection, three connections of one
  person, another person, browser vs token, range, reindex, access version, privacy, trash, removal and
  agent block, memory bounds).
- `setContextCacheEnabled(false)` exists for the benchmark's "before" column only.

## References
- apps/server/src/context/contextCache.ts, apps/server/src/routes/context.ts (`GET /context`),
  apps/server/src/versions.ts (`bumpChunkEpoch`, `chunkEpoch`), apps/server/src/context/chunkIndex.ts,
  apps/server/src/lru.ts (`peek`, `keys`)
- apps/server/scripts/agent-efficiency-bench.ts
- ADR 0753 (keyed caches), 0927, 1071, 1200, 1252, 1253
