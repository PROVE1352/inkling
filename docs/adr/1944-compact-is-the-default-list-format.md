# 1944. compact is the default format of list_pages and search

- Status: Accepted
- Date: 2026-11-10
- Amends: 0928, 1541 (json stays the default)

## Context
ADR 1541 added `format: 'compact'` (8-character ids, folded numbered siblings) but kept `json` as the
default for two reasons: clients parse the old shape, and short ids worked in four tools only. The
second reason is gone (ADR 1941). An agent that does not pass `format` — most of them — paid 2–5× the
tokens for the same tree.

## Decision
- No `format` → `compact` for list_pages and search. `lines` and `json` are unchanged byte for byte and
  still accepted. The enum lists compact first; the per-field description is gone (the tool description
  says what each format is).
- The compact legend says short ids are accepted by every tool.

## Impact of the default change
- Clients or prompts that `JSON.parse` a list_pages/search answer without passing `format` break; they
  must pass `format: 'json'`. In this repository: `context/evalRun.ts` (the old-flow baseline of the
  evaluation, now `format: 'json'`), `jsonOutput.db.test.ts`, `context.db.test.ts`. The CLI uses REST,
  not MCP. docs/MCP.md and README examples describe the default and need the new wording (drafts).
- json's `depth` default (1 with parentId, all without) applies to json only; compact and lines show
  the whole subtree (as before for lines).
- Prompt caches: the first list call of a session changes once.

## Measured
`scripts/mcp-output-cost.ts` (74 padded evaluation pages): list_pages with no format 2,811 → 523 tokens
(−81.4%); search "deploy" 70 → 57 (−18.6%). 0.12 bench (ADR 1541) for 2,000 pages: json 22,971 tokens
for 500 pages vs compact 4,430 for 1,043.

## Alternatives considered
- **Keep json, document compact better**: the cheap path stays opt-in, and the evaluation shows agents
  rarely pass it.
- **`lines` as the default**: full ids, no folding: −59% instead of −81% here.

## References
- apps/server/src/mcp.ts (list_pages, search), mcpTools/compactList.ts (`COMPACT_LEGEND`)
- docs/adr/0928-*, 1541-*, 1941-*
