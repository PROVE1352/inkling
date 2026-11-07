# 0953. Review priority: read counters, a drift model, living documents, archive candidates

- Status: Accepted
- Date: 2026-11-07

## Context
A fixed interval flags every page at the same age, though a runbook read daily next to fast-
changing pages matters more than a page nobody opens, and a daily log is never "reviewed".
Review time is the scarce resource; the list should spend it where a stale page does most harm.

## Decision
- **Read counters** `page_reads (page_id, day, count)`: web views (`POST /pages/:id/view`, sent
  once per page open) and agent reads (`read_page` full/section, `read_pages`, pages shown by
  `find_context`). Page totals only, no user column. Counts are buffered in memory (≤ 50k keys,
  per-day cap 100k), flushed every minute, hourly and on shutdown with one upsert per 1,000 rows,
  skipping deleted pages; rows older than 90 days are purged (apps/server/src/pageReads.ts).
- **Model** (apps/server/src/review.ts:31-95), documents only (no folders, templates, collection
  rows):
  - importance `I = max(reads30, 0.5)`; the floor keeps unread pages rankable below read ones.
  - `p = 1 − exp(−λ·t)`: probability the page no longer matches reality if changes arrive as a
    Poisson process with rate λ; `t` = whole days since the baseline = last review, else the
    later of creation and the last section edit (page_changes, falling back to `updated_at`).
  - `λ = ln2/interval + 0.1·r_neighbors + 0.05·r_self`, rates = distinct change days in the
    window / window days (window = min(90, change-feed retention)); neighbours = pages linked
    to or from it. Without signals `p = 0.5` exactly at the workspace interval, so the setting
    keeps its meaning; changing neighbours (the reality the page describes) shorten it; own edits
    count half (the topic moves, but the author is also maintaining it).
  - score `= round(I × p, 2)`; stale = `p ≥ 0.5` and not living; `dueOn` = baseline +
    ceil(ln2/λ) days; review time = max(1, round(chars / 1200)) minutes (~200 words/min).
  - **Living document**: changed on ≥ 40 % of the last 30 days (logs, journals), or set by hand
    (`pages.living_override`, `PUT /pages/:id/living`); excluded from the list.
  - **Archive candidate**: no reads in 90 days and `t ≥ 180`; listed separately (archive or
    delete rather than review).
- **Batch**: once a day per workspace with reminders on (housekeeping, or lazily on the first
  `GET /review-due` of the day) into `page_review_scores`, under an advisory lock; "Mark
  reviewed" and the living toggle recompute that page only. Changing the interval clears
  `review_scored_on`.
- **List**: stale bucket by score descending (greedy: most expected harm per review first) with
  estimated minutes and a total; archive and living buckets below. MCP `stale` uses the same
  batch, with `p` rounded to two decimals (docs/adr/0937-*).

## Alternatives considered
- Plain age threshold (0951 alone): treats a hot runbook and a dead page the same.
- Per-user view logs to weight by "who reads": privacy cost for a ranking that totals serve.
- Learning λ per page with a full estimator (Cho & Garcia-Molina's MLE with incomplete change
  histories): our change log is exact but short (30 days by default), so a shrinkage towards the
  interval prior is more stable than a fitted rate.
- Optimal crawl scheduling (Kolobov et al.): solves a budgeted schedule; humans review a list,
  so a greedy order with time estimates is enough.

## Trade-offs
- Weights 0.1 / 0.05 / 0.4 / 180 are judgement calls, kept as named constants with unit tests.
- Counts are approximate: up to a minute of reads can be lost on a crash; one call reading the
  same page twice counts once.
- Neighbour rates are averaged over links in both directions; hub pages smooth out.

## How others solve it
- Cho & Garcia-Molina, "Synchronizing a database to improve freshness", SIGMOD 2000: Poisson
  change model, freshness = probability a copy is up to date, `1 − e^{−λt}` staleness.
- Kolobov, Peres, Lu, Horvitz, "Staying up to date with online content changes using
  reinforcement learning for scheduling", NeurIPS 2019, and Kolobov et al., "Optimal freshness
  crawl under politeness constraints", SIGIR 2019: importance-weighted freshness, greedy
  allocation under a budget.
- Confluence analytics and Notion page analytics count views per page; stale-content reports in
  wiki tools rank by last update only.

## Consequences
- Migration 0029 adds `page_reads`, `page_review_scores`, `pages.living_override`,
  `workspaces.review_scored_on`.

## References
- apps/server/src/pageReads.ts:26, :48, :92, :99
- apps/server/src/review.ts:31, :62, :114, :225, :376
- apps/server/src/housekeeping.ts:126, :129
- apps/server/src/routes/workspaceAdmin.ts:373, :394, :448
- apps/server/src/review.test.ts (worked numbers)
