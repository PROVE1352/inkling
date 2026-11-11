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
  registration (`applyProfile`, so `more_tools` is covered) and puts each row on its registered tool,
  in the form below ("What tools/list carries"). A registered tool without a row, or a tool that passes its own `annotations`, throws
  while the server is built, so a new tool cannot ship without a verdict. The 32 inline annotations
  were removed. No `title` hint: the tools already carry a top-level `title`, and every byte here is
  paid by every session.
- **What tools/list carries** (`emittedAnnotationsOf`). The tool list is paid for in every session, and a
  hint equal to the spec's default tells a client nothing, so the table's row is written without
  those, except the two whose default is the risky side:
  - read-only tool: `{"readOnlyHint":true,"openWorldHint":false}`. destructiveHint and idempotentHint are
    "meaningful only when `readOnlyHint == false`" (sdk 1.32.2 `types.js`), so they are left out;
  - write tool: `destructiveHint` always, true or false (default true: false must be written, and true is
    written too so a reader sees the verdict), then `idempotentHint: true` only when true (default false),
    then `openWorldHint: false` always (default true); `readOnlyHint: false` is the default and left out.
  - The key order is fixed by that function, so the list stays the same bytes for the same build. Filling
    the spec's defaults into what is listed gives back every hint of the row that means something (the
    test checks it for every tool), so the client reads the same verdicts as with all four written.
- **readOnlyHint: true** when the tool changes nothing that it or another tool reads back. Checked per
  tool from its code (all 20 use `wrap` and only GET routes; the in-process writes of the tool modules
  were looked up too) and by running them on a read-only connection with Postgres logging the writes
  (`log_statement = 'mod'` on a throwaway database; read_file and read_ink only reached their
  not-found and not-allowed answers there). Not counted, because every authenticated request causes
  them and they are not what the tool is for: `oauth_grants.last_used_at` and `workspace_agent_access`
  (throttled, every tool), per-connection usage (ADR 1552, every tool), page read counters (ADR 0953;
  read_page, read_pages, find_context; page totals only, the same as a page view in the browser, and
  they feed the daily review batch), the taint record of flagged content (ADR 2040, 2046; sections via
  `loadAgentContext(read)` and `recordTokenRead`, attachment text via read_file's `recordFlaggedFile`; a
  safety restriction on the connection itself) and `change_feed_state.high_water` (a cached maximum of
  `page_changes`, written by changes_since and catch_up).
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
  resolve_comment (sets the same value, no event), ack (the second call acknowledges 0 items),
  withdraw_suggestion ("already withdrawn; nothing changed"), release_section ("holds no claim"); each was
  called twice on a test database. claim_section is not: claiming again extends the claim. Read-only
  tools carry false, the spec default (the hint means nothing for them).
- **openWorldHint: false for every tool.** The spec's example of a closed world is a memory tool, and
  these tools act on this server's notes and its workspace members only: none fetches a URL the agent
  names or writes to an address outside the workspace. Writes that create pages, write page text,
  comments or row values can make the server notify members (`mention`, `comment`, `assigned`,
  `page_created`): in the app, by mail and web push per each member's settings (ADR 1004, 2222;
  excerpts of at most 200 characters, never bodies), and through the workspace's webhooks (ADR 0504;
  Slack, Discord or a generic https endpoint, summaries and links). Those are the server's reactions to
  any change, the same for an edit in the browser, to members who can see the page or to destinations
  owners set; the agent can address a member by mentioning them, not anyone else. The operator's
  embedding endpoint (ADR 1740) is the server's own infrastructure. Reading "may reach mail or webhooks"
  as open world would mark every content write (create_page, import_folder, import_zip,
  create_from_template, update_page, patch_section, patch_sections, add_comment, reply_comment,
  create_row, update_row, create_collection, split_page) and say "writes" a second time.
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
- **All four hints on every tool in tools/list** (the first cut of this change): full ~13,737 tokens
  (+960 over 0.19, +7.5%), core ~8,174 (+641, +8.5%), every session, for hints that repeat the spec's
  defaults or mean nothing for a read-only tool. The table keeps all four, so "decided" is still visible
  where the verdicts are made; only the wire form drops the defaults.
- **Only the hints that differ from the defaults, everywhere** (also leaving out `destructiveHint: true`):
  a few hundred characters less, but a write tool's destructive verdict would then be read from an
  absent key; the two risky-default hints are always written for write tools.
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
  51,059 → 52,932 characters, ~12,777 → ~13,245 tokens (+468, +3.7%); core 32 tools 30,093 → 31,391
  characters, ~7,533 → ~7,857 tokens (+324, +4.3%). With all four hints on every tool it was 54,897 /
  ~13,737 and 32,657 / ~8,174. The full-list cap in `toolSurface.test.ts` moves to 13,320. Descriptions
  and schemas are unchanged; the list is still the same bytes for the same build.
- `more_tools(tool=…)` prints the hints that are true after the name (ADR 2000): write tools now show
  `(destructive)`, `(destructive, idempotent)` or `(idempotent)`; non-destructive writes without
  idempotence still show none.
- A read-only connection may call two tools that are not read-only: catch_up (above) and more_tools (it
  lists; the tool it runs refuses writes). Every tool it is refused is `readOnlyHint` false, and every
  `readOnlyHint` true tool is callable on it.
- A new tool needs a row in `TOOL_ANNOTATIONS` (the server does not build without it) and a line of
  arguments in `toolAnnotations.db.test.ts`.

## Tests
- `mcpTools/toolAnnotations.test.ts` (no database): every row of the table has the four hints as
  booleans; every listed tool in both profiles carries exactly the keys of the rule above in its order
  (read-only: no destructive or idempotent; write: destructiveHint and openWorldHint always, nothing else
  equal to its default) and, with the spec's defaults filled in, the meaningful hints of its row; the
  table has one row per registered tool
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
