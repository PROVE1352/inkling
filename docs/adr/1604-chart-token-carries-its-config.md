# 1604. The chart token carries its config; the data line is a comment

- Status: Accepted
- Amends: 1500
- Date: 2026-11-10

## Context
Agents read pages as Markdown with tokens for nodes Markdown cannot say (ADR 1500). A chart must
survive read → patch_section/update_page unchanged and an agent should see the numbers.

## Decision
- `chart` is a token block: `<!-- inkling:chart {"groupBy":{"field":"st"},"kind":"bar",…} -->` with the
  config object itself (canonical, keys sorted), not the JSON string the block stores; `{}` for a
  block being set up. Parsing validates with `chartBlockConfigSchema` and stores the canonical JSON;
  anything else is not a block (dropped like any comment), e.g. `options.data`.
- Plain Markdown (vault sync, templates, history previews) leaves the chart out like embeds; the
  file export replaces it with a table first (ADR 1605). Public HTML never carries the config.
- read_page / read_page(section) add one line under each token for this reader:
  `<!-- inkling:chart-data count by Status: Done 12, Todo 3 (15 rows) -->` (or `unavailable: …`). It is
  an HTML comment that is not a token (`chart-data` does not match the token pattern), so writing the
  read back drops it and the chart is unchanged. It is computed through the aggregate route as the
  token's user, after the page version (a data change does not change `version`).

## Alternatives considered
- Summary inside the token JSON (an ignored key): one line, but the token would change whenever data
  changes, and an agent copying it would store stale numbers.
- Summary as a normal paragraph: it would become a paragraph on write-back.

## Consequences
- `known=` on read_page answers "unchanged" when only the chart's data changed.
- Tests: `charts/aggregate.test.ts` (token round trip, `{}`, data line dropped, bad config refused),
  `notationRoundTrip.test.ts` census, `charts.db.test.ts` (read_page shows token + data line;
  update_page with the read sent back writes nothing new).
