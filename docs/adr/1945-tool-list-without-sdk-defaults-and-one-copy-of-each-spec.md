# 1945. Tool list without the SDK's defaults, one copy of each spec; profiles designed, not built

- Status: Accepted
- Date: 2026-11-10
- Amends: 1543 (prompt-cache audit: "dropping descriptions")

## Context
After ADR 1940 the list was ~13,000 tokens. Two parts were not ours: the SDK adds
`"execution":{"taskSupport":"forbidden"}` to every tool (45 × 39 characters) and
`"$schema":"http://json-schema.org/draft-07/schema#"` to every input schema (44 × 51). And four
structure/chart tools were 26% of the list (update_fields 1,215, create_view 1,100, create_chart 1,006,
create_collection 928 tokens) because each repeated another's spec: update_fields `add` inlined
create_collection's field spec, `change` inlined the select-option union twice, create_view `chart`
inlined create_chart's settings, and enum descriptions repeated the enum values.

## Decision
- **Slim list** (`mcpTools/toolList.ts`): the SDK's tools/list handler (installed on the first
  registerTool, SDK pinned at exactly 1.32.2) is wrapped after registration; each tool loses
  `execution` when it is exactly `{taskSupport: 'forbidden'}` (the MCP spec's meaning of an absent field)
  and its input schema loses `$schema`. Sources: the SDK's ToolExecution type says of `taskSupport`
  "If not present, defaults to \"forbidden\""; its Tool type describes inputSchema as "A JSON Schema
  2020-12 object" (while the SDK's generator labels it draft-07). Every keyword in the schemas means the
  same in draft-07 and 2020-12 (type, properties, required, enum, const, anyOf, single-schema items, bounds, pattern,
  propertyNames, additionalProperties) — `toolSurface.test.ts` fails if another keyword appears, and if
  the wrapper stops applying (no `$schema`, no `execution` in the list).
- **One copy of each spec**: update_fields `add` is listed as an array of objects ("each a
  create_collection fields spec"), `change.options`/`addOptions` as arrays ("names or { name, color }"),
  create_view `chart` as an object ("create_chart's settings: kind, groupBy, …"). The handlers parse them
  with the same zod schemas as before (`fieldSpecSchema`, `optionSpec`, `settingsInput`) and answer
  `add[0].type: Invalid option … Nothing was written.`; relation targets in `add` are resolved like
  every page id. Validation is unchanged; only where the shape is written down moved.
- **Repetition, not guidance**: enum descriptions that listed the enum values were cut to what the
  values do not say (`barH is horizontal; heatmap needs series`, `New type (not relation, rollup or
  formula)`); create_view's description no longer lists the chart settings twice. ADR 1543's rule stays:
  the cheap paths (find_context first, known, compact) keep their words.
- New arguments this release (ADR 1947, 1948): `read_page.backlinks` +23, `create_page.kind` +27,
  `update_page.baseVersion` +27 tokens, plus +60 in those three descriptions.

## Measured (`scripts/mcp-tools-list-cost.ts`, estimateTokens of the listed JSON)
| step | chars | tokens |
|---|---|---|
| 0.15.0 | 65,971 | 16,504 |
| id patterns removed (ADR 1940) and slim list | 52,138 | 13,046 |
| workspace inference, formats, new arguments (1943, 1944, 1947, 1948) | 52,132 | 13,044 |
| structure/chart specs once | 48,247 | 12,073 |
| repeated descriptions | 47,646 | 11,923 |
Of the first step: id patterns −2,458, `$schema` −561, `execution` −439. The four structure/chart
tools: 4,249 → 2,582 tokens. Server instructions: 434 → 443 tokens (the update_page sentence, ADR 1947).

The final total includes other work streams' changes to their tools in the same tree at measurement time:
ack +63, inbox +56 (inbox ack filters), find_context +2, about +121 tokens. This change alone: about
−4,700 tokens.

## Designed, not built: tool profiles and deferred exposure
- **Profiles**: a connection setting (`core`, `full`) chosen on the consent screen. `core` lists the
  read/write/collaboration tools; 12 tools move to `full` (create_collection, update_fields,
  create_view, create_chart, list_templates, create_from_template, read_ink, list_versions,
  diff_versions, restore_version, import_folder, split_page: 4,451 tokens). `core` would list 33 tools,
  ~7,470 tokens (measured on the final list). Needs a connection-settings field, the consent UI and
  a way to change it later (Settings › Connections): out of scope for this release.
- **Deferred exposure**: list a `more_tools` stub; calling it with a topic sends
  `notifications/tools/list_changed` and enables the group on this connection. The server is stateless
  per request (a new McpServer per POST), so "enabled" would need per-connection state, and clients
  differ in whether they refetch on list_changed. Clients that already defer tool loading (Claude Code's
  tool search) get most of the gain without it.

## Alternatives considered
- **Dropping length caps from the listed schema** (zod still enforcing them): ~270 tokens; the list
  would advertise looser limits than the server enforces. Not done.
- **`$defs`/`$ref` for the repeated specs**: zod inlines reused schemas; references would need a custom
  emitter, and some clients resolve `$ref` poorly.

## References
- apps/server/src/mcpTools/toolList.ts, structureTools.ts (`parseSpecs`, `parseOptions`), chartTools.ts
- apps/server/scripts/mcp-tools-list-cost.ts, mcpTools/toolSurface.test.ts
- docs/adr/1543-*, 1940-*
