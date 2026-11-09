# 1600. Chart blocks store what to draw, never the data

- Status: Accepted
- Date: 2026-11-10

## Context
0.13 adds charts to documents: a slash-menu "Chart" block whose data is a collection (optionally
through one of its views' filters) or a query block query, grouped by a property and counted or
measured. The block lives in the Yjs document, which every reader of the page receives, including
people who cannot see the collection the chart is about.

## Decision
- One custom block, `chart` (`packages/shared/src/blocks.ts chartBlockConfig`), with one prop,
  `config`: the canonical JSON of a `ChartBlockConfig` (`packages/shared/src/charts.ts`), `''` while
  the block is being set up. The server schema builds a placeholder spec from the same config
  (`md/serverSchema.ts`), so server reads keep the node (ADR 1500, 1539); the web registers it in
  `editorSchemaSpecs`, so the embed viewer knows it too.
- The config is ours: `source` (`{type:'collection', collectionId, viewId?}` or
  `{type:'query', query}`), `kind`, `groupBy {field, bucket?}`, `series?`, `measure? {fn, field?}`,
  `sort?`, `limit?`, `title?`, `options?` (library options: plain values, at most 20 keys and 4 KB,
  never `data`/`url`/`theme`/`locale`). Field references are ids (renames do not break a chart).
- Canonical JSON: defaults left out (`measure` count, `sort` auto, empty title/options), keys sorted
  (`canonicalChartJson`), so a read → write round trip gives the same string.
- No data in the block. Each viewer's chart is the aggregate the server computes for that viewer
  (ADR 1602), fetched when the block first comes on screen.

## Alternatives considered
- Store the aggregated numbers (or a rendered SVG) in the block: everyone who can open the page
  would see numbers from rows they cannot see, and the chart would be stale after every edit.
- A code block with a `chart` language, like the query block (ADR 0204): no schema change, but the
  settings UI would edit text, the token would not be validated as a whole, and kinds/options would
  be a second parser.
- Separate props per setting: every new setting is a schema change on both sides; one JSON prop is
  validated by one zod schema.
- Store the library's spec: ties stored documents to one library's format (ADR 1601).

## Consequences
- A reader without access to the source sees an empty state with the reason, not numbers.
- An old client (0.12) drops the unknown `chart` node on read; mixed-version editing of one page
  loses charts, as with any new block type (release note).
- Tests: `apps/server/src/charts/aggregate.test.ts` (schema, canonical form),
  `context/notationRoundTrip.test.ts` (chart block in the census).
