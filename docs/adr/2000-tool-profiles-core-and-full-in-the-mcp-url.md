# 2000. Tool profiles: core and full, chosen in the MCP URL; more_tools reaches the rest

- Status: Accepted
- Date: 2026-11-10
- Amends: 1945 (the "designed, not built" part)

## Context
0.15.1 lists 45 tools, ~11,900 tokens, to every client before the first call (ADR 1945). Reports from
agent builders put the point where tool choice starts to degrade at 30–50 tool definitions, and a
quarter of our list is structure and chart tools most sessions never call. ADR 1945 designed a
`core` profile (33 tools, ~7,470 tokens) chosen on the consent screen and deferred exposure through
`notifications/tools/list_changed`, and left both unbuilt because they need per-connection state.

## Decision
- **The profile is in the URL**: `https://<host>/mcp?profile=core` or `?profile=full`. No query =
  `full`, byte-identical to 0.15.1 plus this release's new tools (existing connections change
  nothing). Any other value (another word, the parameter twice) is answered `400` with the JSON-RPC
  body `{"jsonrpc":"2.0","error":{"code":-32602,"message":"Unknown profile: use /mcp?profile=core or
  /mcp?profile=full (no profile = full)."},"id":null}`, so a typo is seen at connect time instead
  of silently giving `full`. The server is stateless (one McpServer per POST) and every request
  carries the URL, so a profile needs no stored state and no migration. The web app's connection
  setup writes the URL (`mcpProfile.ts` parses it; the generator is the web's).
- **OAuth**: a client may send the profile URL as its RFC 8707 resource indicator;
  `isOurResource` treats `/mcp?profile=core|full` as `/mcp` (only that exact query). SDK clients send
  the protected-resource metadata's `resource` (`/mcp`), which was already accepted.
- **core** lists the tools of the everyday flows and `more_tools` (32 tools). Hidden groups, in
  `mcpTools/profiles.ts` (one table; a registered tool in neither list fails `toolProfiles.test.ts`):

| group | tools | tokens (full list) |
|---|---|---|
| structure | create_collection, update_fields, create_view, create_chart | 2,582 |
| templates | list_templates, create_from_template | 495 |
| history | list_versions, diff_versions, restore_version, list_trash, restore_page | 722 |
| upkeep | check_notes (ADR 2003), split_page | 496 |
| files | import_folder, upload_file (0.16 upload work stream, classified here) | 312 + upload_file |
| ink | read_ink | 276 |

| flow | core tools | tokens |
|---|---|---|
| find and read | find_context, read_page, read_pages, search, list_pages, list_workspaces, read_file | 1,602 |
| write | patch_section, patch_sections, update_page, create_page, rename_page, move_page, trash_page | 1,662 |
| rules | get_instructions | 180 |
| comments | add_comment, list_comments, reply_comment, resolve_comment | 716 |
| inbox, catch up, sync | inbox, ack, catch_up, changes_since, later | 1,489 |
| section claims (예약) | claim_section, release_section | 275 |
| suggestions | list_suggestions, withdraw_suggestion | 313 |
| rows (assignments) | query_rows, create_row, update_row | 1,010 |
| reaching the rest | more_tools | 155 |

  Rows stay in core: an assignment arrives through `inbox` and is finished with `update_row`
  (ADR 1864); hiding them would make the commonest collaboration loop take two extra calls. The trash
  tools moved out next to version history: recovery is rare and is a person's decision.
- **Reaching a hidden tool** — `more_tools` (core only) in three forms:
  - `more_tools()`: one line per group with the registered tool names and a fixed phrase;
  - `more_tools(tool)`: that tool's description, annotations and input schema, exactly as tools/list
    shows them in `full`;
  - `more_tools(tool, arguments)`: runs it through the server's own `tools/call` handler, so zod
    validation, short-id resolution, the read-only refusal (`wrapWrite`) and metering are the
    direct call's. `more_tools` itself is registered past the meter wrapper, so a run is counted once
    (as the tool it ran).
  Hidden tools stay registered: a client that lets the model call an unlisted name works too.
- **Prompts name tools the profile lists**: a prompt built for a core connection writes
  `more_tools(tool="check_notes", arguments={…})` (ADR 2002). Every tool the server instructions name
  is in core (tested).

## Measured (`scripts/mcp-tools-list-cost.ts --profile core|full`, estimateTokens of the listed JSON)
| list | tools | chars | tokens |
|---|---|---|---|
| 0.15.1 (before) | 45 | 47,646 | 11,923 |
| full, this change (check_notes added) | 46 | 48,451 | 12,124 |
| core, this change | 32 | 29,557 | 7,399 |
| full in the tree at measurement time (with upload_file and read_file changes of another stream) | 47 | 49,667 | 12,428 |
| core in the same tree (upload_file hidden) | 32 | 29,710 | 7,437 |
core is −38% of the 0.15.1 list (−4,524 tokens) and 13 tools fewer. Server instructions are the same
in both profiles (467 tokens).

## Limits
- **One approval for every hidden tool.** A client that asks the person to approve each tool by name
  sees `more_tools` as one tool without hints (a client treats a tool without `readOnlyHint` as one
  that may change data). Once a person allows it without asking again, every hidden tool — write tools
  such as restore_version, create_collection, import_folder and upload_file included — runs under that
  approval. The server's checks (read-only tokens, edit locks, the agent edit policy) are unchanged;
  only the client-side per-tool prompt is coarser. A person who wants per-tool approval uses `full`.
- `more_tools()` and `more_tools(tool)` (index and spec) are not metered; a run is metered as the tool
  it ran.

## Alternatives considered
- **Profile on the consent screen, stored on the grant** (ADR 1945): needs a column, consent UI and
  a way to change it; the URL is already per-client configuration, survives re-authorization, and a
  person can keep two connections (core for chat, full for a structure-building session).
- **`notifications/tools/list_changed` after enabling a group**: the route answers in JSON mode,
  whose transport drops request-related notifications (there is no GET stream either); switching that
  request to an SSE answer would deliver it, but the following tools/list is a new stateless request
  that would need per-connection state to list more, and clients differ in whether they refetch. A
  client that defers tool loading on its own (Claude Code's tool search) already gets most of the gain.
- **`tool.disable()`** of the SDK: disabled tools also refuse calls; filtering the list keeps them
  callable.
- **Rows out of core** (−1,010 tokens): see above.
- **A generic `call_tool(name, args)` without the describe form**: the model would guess arguments.

## References
- apps/server/src/mcpTools/profiles.ts, mcpProfile.ts, mcp.ts (route), routes/oauth.ts (isOurResource)
- apps/server/src/mcpTools/toolProfiles.test.ts, profilesResources.db.test.ts
- docs/adr/1543-*, 1945-*
