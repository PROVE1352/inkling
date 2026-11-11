# 2460. MCP tool annotations on every tool

- Status: Accepted (extends 0935, 2000)
- Date: 2026-11-11

## Context
The MCP `ToolAnnotations` type (sdk 1.32.2, `types.js` `ToolAnnotationsSchema`) has four hints, and
their defaults are the cautious ones: `readOnlyHint` false, `destructiveHint` true ("If true, the
tool may perform destructive updates to its environment. If false, the tool performs only additive
updates"; meaningful only when `readOnlyHint` is false), `idempotentHint` false (also meaningful only
when not read-only), `openWorldHint` true. Before 0.20 the tools set them by hand, inline: 21 of 48
had `readOnlyHint: true`, 11 had a `destructiveHint`, 1 an `idempotentHint`, none an
`openWorldHint`. A client that asks before destructive calls asked before every `add_comment` and
`create_row` it could not tell apart from `trash_page`; one that offers read-only tools in a
read-only mode left out tools it could have offered; and every tool claimed an open world.

## Decision
- **One table** (`mcpTools/annotations.ts`, `TOOL_ANNOTATIONS`): one row per tool name with all four
  hints, the 48 tools and `more_tools`. `annotateTools(server)` runs in `buildMcpServer` after the last
  registration (`applyProfile`, so `more_tools` is covered) and puts a copy of the row on each
  registered tool. A registered tool without a row, or a tool that passes its own `annotations`, throws
  while the server is built, so a new tool cannot ship without a verdict. The 32 inline annotations
  were removed. No `title` hint: the tools already carry a top-level `title`, and every byte here is
  paid by every session.
- **readOnlyHint: true** when the tool changes nothing that it or another tool reads back. Checked per
  tool from its code (all 20 use `wrap` and only GET routes) and by running each one on a read-only
  connection with Postgres logging the writes (`log_statement = 'mod'` on a throwaway database). Not
  counted, because every authenticated request causes them and they are not what the tool is for:
  `oauth_grants.last_used_at` and `workspace_agent_access` (throttled, every tool), per-connection usage
  (ADR 1552, every tool), page read counters (ADR 0953; page totals only, the same as a page view in the
  browser), the taint record of flagged content (ADR 2040; a safety restriction on the connection
  itself) and `change_feed_state.high_water` (a cached maximum of `page_changes`, written by
  changes_since and catch_up).
- **catch_up is not read-only.** Without `peek` it moves the connection's "last catch_up" marker and the
  person's copy of it (ADR 1537, `catch_up_markers`), and the marker decides what the next `catch_up()`
  answers. That is the "does not modify its environment" line of the spec, not request bookkeeping.
  Its route stays GET and read-only tokens keep it (ADR 1520): the hint says what the tool does, the
  scope says who may call it.
- **destructiveHint: true** when the call can remove or overwrite something that was there (a body, a
  section, a title, a row value, a page's place or section, a page in the tree), even when version
  history, the trash or a later call can bring it back; the spec contrasts destructive with "only
  additive", and a restorable overwrite is still not additive. **false** when the call only adds
  (pages, rows, comments, replies, suggestions, claims, views, charts, uploads, imports) or flips a flag
  of something (resolved, acknowledged, the agent's own claim or suggestion). Where the two readings
  differ, true.
- **idempotentHint: true** for writes whose repeat with the same arguments changes nothing more:
  rename_page and move_page (the same title or parent again changes nothing), trash_page and
  restore_page (the second call finds nothing to move), update_row (the repeat fails on baseVersion),
  resolve_comment, ack, withdraw_suggestion, release_section. claim_section is not: claiming again
  extends the claim. Read-only tools carry false, the spec default (the hint means nothing for them).
- **openWorldHint: false for every tool.** No tool fetches a URL the agent names or sends a message to
  an address it picks; they read and write this server's notes. Workspace webhooks (Slack, Discord,
  generic), email and push notifications and the operator's embedding endpoint (ADR 1740) are the
  server's reactions to any change, the same for an edit in the browser, to destinations set by owners
  or the operator, carrying summaries and links rather than bodies.
- **more_tools**: `readOnlyHint` false, `destructiveHint` true, `idempotentHint` false: it lists and runs
  the hidden tools, among them restore_version, split_page and update_fields, so it carries the worst case
  of what it can dispatch. The tool it runs still checks the scope (a write is refused on a read-only
  connection).

Result: 20 read-only tools; 11 writes with `destructiveHint` true (update_page, rename_page, move_page,
trash_page, patch_section, patch_sections, update_row, split_page, restore_version, update_fields,
more_tools); 18 with false (create_page, import_folder, create_from_template, add_comment,
reply_comment, resolve_comment, ack, create_row, create_chart, create_view, restore_page, upload_file,
import_zip, catch_up, withdraw_suggestion, claim_section, release_section, create_collection).

Changed verdicts (explicit before, different now):
- catch_up: `readOnlyHint` true → false (the marker, above).
- update_row: `destructiveHint` false → true. It overwrites values: `null` clears a property and
  relation values replace the links; the row version check guards against stale writes, not against
  losing the value that was there.

Kept: every tool that had `destructiveHint: true` (update_page, trash_page, patch_section, patch_sections,
split_page, restore_version, update_fields) keeps it; trash_page is restorable but takes the subtree out
of the tree and every listing. create_row, create_chart and create_view keep `destructiveHint` false;
update_row keeps `idempotentHint` true. Tools that had no annotations (the spec's defaults: destructive,
open world) are now explicit: 14 of those 17 are not destructive, and no tool is open world.

## Alternatives considered
- **Inline annotations at each registerTool**, as before: 49 places to keep in step and nothing that
  fails when one is forgotten; the table is read in one screen and checked by a test.
- **A registerTool wrapper** like `meterTools`/`resolveIdArgs`: misses `more_tools`, which `applyProfile`
  registers with the SDK's own method past the wrappers.
- **Only the hints that differ from the defaults** (e.g. leave `idempotentHint: false` out): about a
  quarter of the bytes, but a reader cannot tell "decided false" from "not decided", and clients that
  treat a missing hint differently from the default would differ again.
- **catch_up read-only**, as since 0.12 (the route calls the marker bookkeeping like
  `last_used_at`): the marker changes the next answer, which `last_used_at` does not; a client that
  hides non-read-only tools in a read-only mode now hides catch_up, and `peek=true` callers lose nothing
  by calling it in a normal mode.
- **Request bookkeeping counts as a change** (read counters, usage, taint record): no tool would be
  read-only, which tells clients nothing.
- **openWorldHint true for writes that can trigger webhooks or notifications**: every page, comment and
  row write can, so the hint would say "writes" a second time; the destinations are not the agent's.
- **destructiveHint false for restorable changes** (trash, restore_version): the spec's word is
  "additive", and the hint is what lets a client ask first; being able to undo is a reason to say yes,
  not a reason not to ask.

## Consequences
- tools/list (`scripts/mcp-tools-list-cost.ts`, read-write connection, inert context): full 48 tools
  51,059 → 54,897 characters, ~12,777 → ~13,737 tokens (+960, +7.5%); core 32 tools 30,093 → 32,657
  characters, ~7,533 → ~8,174 tokens (+641, +8.5%). The full-list cap in `toolSurface.test.ts` moves to
  13,810. Descriptions and schemas are unchanged; the list is still the same bytes for the same build.
- `more_tools(tool=…)` prints the hints that are true after the name (ADR 2000): write tools now show
  `(destructive)`, `(destructive, idempotent)` or `(idempotent)`; non-destructive writes without
  idempotence still show none.
- A read-only connection may call two tools that are not read-only: catch_up (above) and more_tools (it
  lists; the tool it runs refuses writes). Every tool it is refused is `readOnlyHint` false, and every
  `readOnlyHint` true tool is callable on it.
- A new tool needs a row in `TOOL_ANNOTATIONS` (the server does not build without it) and a line of
  arguments in `toolAnnotations.db.test.ts`.

## Tests
- `mcpTools/toolAnnotations.test.ts` (no database): every listed tool in both profiles has exactly the
  four hints, as booleans in a fixed order, equal to its row; the table has one row per registered tool
  (48 + more_tools); read-only rows keep the write hints false; no row is open world; the 20/11/18 split;
  a tool without a row or with inline annotations throws; `more_tools(tool)` prints the true hints.
- `mcpTools/toolAnnotations.db.test.ts`: every tool is called with valid arguments on a connection with
  scope `read`: refused tools are all `readOnlyHint` false, `readOnlyHint` true tools are all callable,
  the callable non-read-only tools are exactly catch_up and more_tools; catch_up writes its marker on
  such a connection and `peek=true` does not; more_tools refuses a hidden write there.

## References
- apps/server/src/mcpTools/annotations.ts, mcp.ts (`buildMcpServer`), profiles.ts (`renderToolSpec`)
- @modelcontextprotocol/sdk 1.32.2 `dist/esm/types.js` (`ToolAnnotationsSchema`)
- ADR 0935 (read and write scopes), 0953 (read counters), 1520/1537 (catch_up and its marker),
  1552 (usage per connection), 2000 (profiles, more_tools), 2040 (suggest-only after flagged content)
