# 2001. Pages as MCP resources: a template, a short list, the read_page answer

- Status: Accepted
- Date: 2026-11-10

## Context
Until 0.16 the server exposed tools only. Clients such as Claude Code let a person attach an MCP
resource to the conversation with `@` (they call `resources/list` for the menu and `resources/read`
for the one picked); without resources a person has to ask the model to find and read a page, which
costs a find_context and a read_page call. A workspace can have tens of thousands of pages, so
"every page is a resource" would make resources/list as large as list_pages, and the list is built
outside any tool call, so it must apply the permission rules on its own.

## Decision
- **One resource template**, `inkling://page/{id}` (`resources/templates/list`): `id` is the page
  id or the 8+ hex prefix tools print (resolved like every page argument, ADR 1941). Template
  metadata has no `title`: the SDK copies template metadata into every listed resource, and clients
  show `title` before `name`.
- **resources/list is short**: at most 50 entries — the person's favorites first (their sidebar
  order, up to 25), then the most recently changed pages (`updated_at` desc, id). `name` = the page
  title through `cleanText`, cut at 120 characters; `description` is fixed server text (`Favorite`,
  `Recently changed`); `mimeType: text/markdown`. Everything else is reached through the template or
  find_context. Folders and collection rows are left out.
- **Permissions**: the list runs inside `runAsConnection` (agent blocks and the connection range of
  this token) over `memberWorkspaceIds` (member workspaces that allow agents and whose two-step
  requirement does not block the person), `visibleTo` (shared pages, the person's own private pages,
  the range term), live pages of live workspaces — the rule `resolvePageRef` already uses for short
  ids. Guests' workspaces are not member workspaces and never appear.
- **resources/read returns the read_page answer** for that page, run through the server's own
  `tools/call` handler: the same REST route (membership, visibility, 2FA, range), id resolution,
  header with `can:`, `<untrusted_content>` wrapping and injection marks as the tool. It is metered
  as a read_page call (the same text reached the model). A page that does not exist and one this
  connection may not see give the same error, code -32002 (MCP's "resource not found") and a message
  without any title; other failures are -32603 with the tool's message.
- **Titles in the list are member text outside a wrapper.** The list is shown to the person in the
  client's menu; when a page is attached, the content that reaches the model is the wrapped read_page
  answer. The name is cleaned (bidi, tag and zero-width characters, markers) and capped; the
  description is never member text.

## Measured
| | before | after |
|---|---|---|
| initialize result (capabilities, server info, instructions) | 2,013 chars, ~504 tok | 2,077 chars, ~520 tok (both capability lines, with prompts) |
| resources/templates/list | — | 225 chars, ~57 tok |
| resources/list at the cap (50 pages, mixed English/Korean titles) | — | 8,165 chars, ~2,097 tok (~42 per entry); 3.2 ms in-process |
Clients put the list in a menu, not in the model's context; the model-visible fixed cost is the
initialize difference (+16 tokens with ADR 2002). `scripts/mcp-tools-list-cost.ts --surface`; the
list size from a scratch run on the [db] test database (60 pages, one workspace).

## Alternatives considered
- **Every page as a listed resource, paginated**: resources/list cursors exist, but clients fetch
  every page of the list for their menu; a large workspace would cost seconds and megabytes per
  connection start.
- **A fixed resource per workspace (`inkling://workspace/<id>`)** with the tree: list_pages already
  does that and the tree is the expensive part.
- **Instruction pages as resources**: would put workspace rules where any attached text goes,
  blurring the get_instructions boundary (ADR 0975). Not done.
- **Completion for `{id}`** (`completion/complete`): values would be ids, which a person cannot
  type from memory; the list and find_context cover it.

## References
- apps/server/src/mcpTools/resources.ts, mcpTools/profilesResources.db.test.ts
- docs/adr/0975-*, 0976-*, 1941-*
