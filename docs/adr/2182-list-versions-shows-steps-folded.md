# 2182. list_versions and the web history show AI steps; long runs are folded

- Status: Accepted
- Date: 2026-11-10

## Context
With one version per agent write (ADR 2180) a page's history gets longer: an agent that patched a page
twelve times has thirteen versions where 0.16 had one. `list_versions` printed every version (up to
50) on one line each, so its answer grows with the agent's activity, and a step needs to say which
client changed what, or a list of "AI edit" lines is not usable for choosing one.

## Decision
- **Step lines.** `GET /pages/:id/snapshots` adds `step` to step rows (`n`, tool, mode, anchors, more,
  added/removed lines, restoredFrom); `n` counts the run (consecutive step rows of one client with no
  other row in between) from 1, computed when the list is read. The list is ordered by
  `created_at DESC, id DESC` (rows written in one transaction can share a timestamp; ADR 0937).
  `list_versions` prints a step as
  `<id> | <time> | AI step 4 | by Mia via Claude | patch_section replace §goals +1 −1 lines`;
  other versions print exactly as in 0.16.
- **Default size.** At most 20 versions are listed; `… N older versions not listed (all=true lists
  every version)` closes a longer list. A run of more than 4 steps shows its newest 3 steps, one
  `… AI steps a–b of this run not listed (all=true lists them)` line and its step 1 (the step right
  after the "Before AI edit" row). `all=true` lists every saved version (≤ 50) without folding.
  Folded ids still work in `diff_versions` and `restore_version`.
- **Web.** The history list shows a step row as "AI edit · step n" with one more line
  (`§goals · +1 −1 lines`, "whole page", "restored an earlier version"); nothing else in the modal
  changes. en/ko strings.

## Measurements
Output tokens (`estimateTokens`, the server's estimator) for one page patched N times by one client:
4 steps: 255 tokens (0.16: one "Before AI edit" line, 121 tokens for the same page); 12 steps:
272 tokens default, 524 with `all=true`. One step line ≈ 34 tokens, a 0.16 line ≈ 24. A page at the
50-row cap lists ≤ 20 lines by default (≈ 750 tokens at most) where 0.16 listed all 50 (≈ 1,270).
The `list_versions` tool entry (description + schema) is measured with
`scripts/mcp-tools-list-cost.ts` in the 0.17 notes.

## Alternatives considered
- **A `limit` number instead of `all`**: one more number to guess; the default covers the newest steps
  and the start of the run, `all` covers the rest.
- **Only the newest step of a run**: the reported problem is exactly that the middle steps were not
  reachable.
- **Separate tool for steps**: two places to look for one history.

## Consequences
- An agent that wants step 6 of a 12-step run calls `list_versions(all=true)` once.
- The `(N saved versions)` header still counts every row, so a folded list says how much is behind it.

## References
- apps/server/src/mcpTools/historyInkFileTools.ts (`versionLines`, `stepWhat`), apps/server/src/routes/snapshots.ts (`stepNumbers`)
- apps/web/src/components/HistoryModal.tsx (`snapStep`), apps/web/src/i18n/{en,ko}/editor.ts
- packages/shared/src/index.ts (`SnapshotStepDTO`)
