# 1543. Prompt-cache audit: tool list, instructions and outputs stay byte-stable

- Status: Accepted
- Date: 2026-11-09

## Context
Claude and OpenAI prompt caches match on a byte-identical prefix. For an MCP client the prefix is
the tool list (names, descriptions, input schemas — about 13.9k estimated tokens for Inkling's
tools), the server instructions, and then the tool results in the order they arrived. ADR 0937 made
read tool outputs deterministic; 0.12 adds tools (suggestions, claims, catch_up, usage metering) and
three agents may now read the same workspace, so the rule was checked again end to end.

## Decision
- **Checked and kept**: tool descriptions and schemas are constant strings (built-in defaults such as
  `DEFAULT_BUDGET` are constants); tools register in a fixed order; the instructions vary only per
  connection kind (the read-only sentence, the connection range sentence), never per call; read-only
  connections list the same tools. get_instructions has no dates (its `v=` hash changes only with the
  pages). Metering (ADR 1552) wraps handlers without touching their text.
- **Fixed**: `GET /api/workspaces` ordered by `created_at` only. Two workspaces created in the same
  transaction or millisecond could swap between calls, and that order drives list_workspaces and the
  workspace loop of `search` (results without workspaceId). It now ends with `id` as a total
  tie-break.
- **New outputs follow the rule**: `unchanged` lines, compact lists (stable order, fixed-length ids,
  the legend as the last constant line) and patch_sections answers carry no clock values.
- **Test** (`mcpTools/tokenSaving.db.test.ts`, "byte-identical"): `listTools` twice on one connection,
  on a second connection of the same user with another client name and on another user's connection
  — identical JSON; server instructions identical; get_instructions, list_workspaces, list_pages
  compact, read_pages with known, read_page knownSections and search compact twice — identical. The
  existing 0937 test covers find_context, read_page (all modes), read_pages, list_pages lines, search
  lines. Bench: the 19 first-pass responses of three agents for the same questions were identical
  across the agents.

## Not changed (recorded)
- **catch_up**: its first line names the window start (`since …`, from the cursor) and its second
  line `due by <date>` comes from today's date, so the header changes once a day even when nothing
  happened; the cursor is the last line (by design). Moving the due date out of the header is left to
  the catch_up owners (ADR 1537 revises its marker in the same step).
- **changes_since** with a wait (long-poll, ADR 1551) returns when something changed; the cursor is the
  last line as before.
- Volatile per-connection values (usage counters) must stay out of tool results, or go into the last
  line / a separate content block; a reminder for the metering work, not a change here.

## Alternatives considered
- **Sorting tools alphabetically** in `tools/list`: the registration order is already fixed and
  groups related tools; re-sorting would change every client's cached prefix once for no gain.
- **Dropping descriptions to shrink the prefix**: the descriptions are how agents learn the cheap paths
  (find_context first, known, compact); the cached prefix is billed at a reduced rate by the providers that
  cache, so its size matters less than its stability.

## Consequences
- Same state → same bytes holds for the tool list across connections and for every new output.
- Tests: see above. The rule for new tools stays ADR 0937's.

## References
- apps/server/src/routes/workspaces.ts (`GET /workspaces` order)
- apps/server/src/mcp.ts (`SERVER_INSTRUCTIONS`, `buildMcpServer`), apps/server/src/catchUp.ts (header)
- ADR 0937, 1520, 1552
