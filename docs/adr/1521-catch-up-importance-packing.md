# 1521. catch_up packs by importance with find_context's knapsack and a per-group rule

- Status: Accepted
- Date: 2026-11-09

## Context
catch_up has far more material than fits: a busy day is hundreds of pages, threads and tasks. It
must say the most important things first, never drop a whole kind of event silently, and stay
deterministic (0937). find_context already packs ranked sections into a budget (`pack` in
`context/rank.ts`): best first, then by score per token, whole while it fits, the next one cut,
the rest as pointers, and a per-page rule (1211) so one page cannot take every slot.

## Decision
- Every item has a group, an importance score in [0, 1], a one-line head and an optional detail
  (diff, thread lines). Scores: mention 1.0, assignment 0.96, reply 0.95, comment on the person's
  page 0.9 (+0.02 unseen); due today 0.89, tomorrow 0.86, overdue 0.8 − 0.005/day, later this week
  0.58 − 0.01/day; due reminder 0.87, upcoming 0.62; comments by others 0.6 + 0.04 per
  thread/reply (≤ 0.2) + 0.05 on the person's page; pages changed by others
  0.4 + 0.25·(1 − e^(−edits/8)) + 0.08 when the person created the page + 0.05 new; trashed or
  hidden 0.42; own changes 0.15–0.3.
- `pack`'s per-page rule applied to groups (`diversifyGroups`): walking best first, a group's first 8
  items keep their score, each further one is multiplied by 0.85 once more.
- Packing (`packItems`): (1) heads best first while they fit in 60 % of the budget; (2) details of
  the listed items, the best one first, then by score per token, whole while they fit, the first that
  does not is cut to the room left; (3) room the details left lists more heads in the same order.
  Every listed item ranks at least as high as every hidden one. Details are previews (14 lines per
  page, 8 per comment group) ending with where to read the rest.
- Output keeps fixed group order (For you, Due soon, Later, Comments, Pages, Own) with importance
  order inside a group, so the text reads like a briefing; the hidden items are counted per group.

## Alternatives considered
- **Call `pack()` itself**: its relevance floor (0.6 × the best score) would drop every page change
  below a mention, and its neighbour merging works on section ordinals; mapping catch_up items onto
  `Scored` chunks to dodge both would make the reuse nominal. The algorithm is reused, the function
  is not.
- **Fixed quotas per group**: simple, but a day with three mentions and two hundred page edits
  wastes the mention quota; the decay adapts.
- **Log order** (as `changes_since`): the newest important item can be cut off by old noise.

## Consequences
- With 30 mentions and 139 due tasks the budget still reaches comments and pages (measured: 67 items
  listed at 4,000 tokens, 218 at 12,000; output uses 99 % of the budget).
- Scores are heuristics; they are constants in `catchUp.ts` and covered by unit tests of the order.

## References
- apps/server/src/catchUp.ts (`diversifyGroups`, `packItems`, `renderPacked`), docs/adr/1211-*
