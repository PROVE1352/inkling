# 2180. One version per agent write ("AI step"): snapshot rows with a content digest, per-client step caps

- Status: Accepted
- Date: 2026-11-10

## Context
A user of 0.16 reported: "the version history saves once per AI editing session, not per edit. I made
four changes and there is one snapshot, 'Before AI edit', so I cannot go back to a step in between,
only to the page before the AI touched it." That is the 0.16 policy: a destructive agent patch stores
"Before AI edit" at most once per page per 2 minutes (`PATCH_SNAPSHOT_WINDOW_MS`, ADR 0930), an append
or insert stores an "AI edit" marker at most once per 10 minutes (`hasRecentAgentSnapshot`, ADR 0936),
and `update_page` replace stores "Before AI edit" on every call. Four quick patches of one section leave
one version. The goal: after an agent changed a page several times, a person (web history) and the
agent (`restore_version`) can go back to any step.

Candidates:
- (a) a version per agent write (skip it when the page did not change; caps and pruning);
- (b) keep the versions as they are and offer the change log (`page_changes`, ADR 0932, used by the
  0.13 revert, ADR 1620–1626) as "AI edit, step n" to restore from;
- (c) both.

What the change log can and cannot do (checked before choosing): one row per section, before/after
as light Markdown (marks, links, embeds and file details flattened), no text above 16 KB (`large`),
and consecutive edits of one section by one actor within 10 minutes merge into ONE row
(`MERGE_WINDOW_MS`). The reported four edits of one section are one change-log row. ADR 1513 already
rejected exposing it as versions ("not restorable states"), and ADR 1620 needs stored versions to bring
formatting back. So (b) cannot give the four steps, and (c) inherits (b)'s gaps; (a) it is.

## Decision
- **AI step rows.** Every agent write that changes the page — `patch_section` (any mode),
  `patch_sections`, `update_page` (replace, append) and an agent's `restore_version` — stores the page
  right after it as one `page_snapshots` row labelled "AI edit" ("AI 편집") with `step` (jsonb: tool,
  mode, up to three section anchors and how many more, Markdown lines added/removed, `restoredFrom`).
  Rows keep the incremental format of ADR 1100: a step row is usually a small Yjs diff from the
  previous row.
- **Content digest** (`page_snapshots.digest`): sha256 (first 128 bits) of the document's state vector
  and its delete set (an update with no structs). A delete-only edit moves no state vector but changes
  the delete set. The bytes are identical whether they come from the live document or from a stored V1
  or V2 state (measured; Yjs writes both sorted), so live and stored sources compare. Every new row
  gets one. Uses: before an agent write, the page is compared with the newest row — equal means the
  agent's previous step is the page now and nothing is stored; different means someone changed it, so a
  "Before AI edit" row is stored first (ADR 2181). After the write an unchanged page stores no step. An
  autosave equal to the newest row is skipped.
- **Caps.** Per page, a client (`via_client`) keeps its newest `MAX_AI_STEPS_PER_CLIENT` = 20 step rows
  and all clients together `MAX_AI_STEPS_PER_PAGE` = 30; older step rows are pruned first, then the
  existing 50-row cap applies to what is left (`pruneSet`). An agent writing in a loop therefore never
  pushes the people's versions out of the 50 (the reason ADR 0936 throttled the marker). Constants, like
  `MAX_SNAPSHOTS_PER_PAGE`: there was no environment variable for version retention to follow.
- **Squash on prune.** Dropping an old step from the middle of a chain used to make its successor a
  whole row (rebuild + whole encode, ADR 1100). When the dropped rows between a kept row and its nearest
  kept ancestor are all V2 diffs, the kept row's diff is now `mergeUpdatesV2` of theirs and its own
  (deletes only grow, so the merge is exactly ancestor → row), checked with the same `diffMatches` as a
  new diff; otherwise the rebuild of ADR 1100 runs as before. At the step cap this replaces the
  rebuild + whole encode of one version per agent write (35 ms on a 4.66 MB document at low load) by a
  merge of small diffs (0.2–0.3 ms), and the successor stays a diff instead of becoming a new whole
  row. It does not change the whole row the chain rule writes every 10th row (the bench pages keep 4
  whole rows with and without it).

## Measurements
Storage and latency, `apps/server/scripts/ai-step-bench.ts` (see docs/PERFORMANCE.md for the rows and
method): 30 agent writes with nothing in between (alternating `patch_section` replace of a middle
section and `update_page` append), 0.16 tree (`git archive` of v0.16.0) and this tree interleaved.

| Page | 0.16 after 30 writes | 0.17 after 30 writes |
|---|---|---|
| 12 KB note | 1 row: 12.3 KB raw, 4.5 KB on disk | 21 rows (1 "Before AI edit" + 20 steps, 4 whole): 71.9 KB raw, 34.3 KB on disk; median step row 691 B |
| 4.1 MB log | 1 row: 4.13 MB raw, 1.07 MB on disk | 21 rows (4 whole): 12.47 MB raw, 2.37 MB on disk; median step row 698 B |

A step row is a few hundred bytes; the cost on a large page is the whole row the chain rule of ADR 1100
writes every 10th row (bounded rebuild work). At the caps a page holds at most 30 step rows plus the
other versions within the 50-row cap, so the history of a 4 MB page stays within ADR 1100's measured
50-version budget (6 whole + 44 diffs: 9.3 MB raw, 2.2 MB on disk); it fills sooner. An agent writing
300 times a day to a 4 MB page writes about 30 whole rows a day that pruning deletes again (≈ 120 MB raw,
≈ 30 MB after TOAST compression, of table churn); ADR 1140–1142 (logs split into child pages) remain
the answer for such pages.

Latency per write (p50 over 15 writes of each kind, two interleaved pairs, load average 20–100 from
other agents' test runs on the same laptop): 12 KB note `patch_section` replace 33.3 (quiet run) →
40.5–41.9 ms, `update_page` append 27.8 → 33.0–34.9 ms (+6–9 ms: two short transactions, two digests,
the section read for line counts); 4.1 MB log within the spread (replace 843.8–1,270.8 → 1,025.2–1,463.9 ms,
append 508.8–672.3 → 576.6–1,046.1 ms).

CPU of the step work on a 4.66 MB document (in-process, `yjs` only, median of 9; load average 2.5, a
second run at load ≈ 40 in brackets): digest from a live document 0.2 ms (5), from a stored state
11.5 ms (84); the step row's diff from a live document 0.2 ms (1.2), from a stored state 5.5 ms (40);
the rebuild + whole encode a squash avoids 34.9 ms (197); merging two step diffs 0.2–0.3 ms. Squash
correctness: `aiSteps.db.test.ts` records every step's preview while 28 replace / insert / delete
writes run past the cap and compares the 20 survivors byte for byte afterwards, then restores the
oldest (squashed) one.

## Alternatives considered
- **(b) the change log as steps**: one row for the reported four edits (10-minute merge), lossy text,
  nothing above 16 KB; see Context.
- **A throttle of a few seconds instead of a digest**: still merges an agent's quick edits, which is the
  complaint; the digest makes the skip exact instead of time-based.
- **State vector equality as the "unchanged" test**: wrong for delete-only edits (measured: deleting
  text leaves the state vector as it was).
- **Store the page before each write instead of after** (labelled with the previous write): the newest
  step would only be reachable as "current", and each row would describe the write before it.
- **Environment variables for the caps**: nothing to follow (no retention variable exists for versions);
  20 per client covers a session of edits, the 50-row cap bounds storage as before.
- **Keep rebuilding on prune**: one whole-document rebuild and a new whole row (4 MB on the bench page)
  per agent write once the cap is reached.

## Consequences
- The reported case gives "Before AI edit" + AI steps 1–4 (`mcpTools/aiSteps.db.test.ts`).
- Migration `0053_v017_snapshot_steps`: two nullable columns; old rows have no digest (never equal, so the
  first agent write after the upgrade stores a "Before AI edit" row) and no step.
- Each agent write costs two digests and one diff encode; on a stored 4 MB page that is tens of
  milliseconds of CPU (see Measurements), on typical pages under a millisecond.
- A merged diff keeps the content of structs a later step deleted (not garbage-collected) until the row
  is rebuilt whole; it is bounded by the 20–30 steps it can absorb.

## References
- apps/server/src/snapshotStore.ts (`stateDigest`, `agentStepStart`, `agentStepEnd`, `pruneSet`, `squashOntoKept`)
- apps/server/src/context/sectionWrite.ts (`asAgentStep`), apps/server/src/routes/sectionBatch.ts,
  apps/server/src/pageContentWrite.ts, apps/server/src/routes/snapshots.ts
- apps/server/drizzle/0053_v017_snapshot_steps.sql
- apps/server/src/mcpTools/aiSteps.db.test.ts, apps/server/scripts/ai-step-bench.ts
- ADR 0930, 0932, 0936, 1100, 1513, 1620, 2181, 2182
