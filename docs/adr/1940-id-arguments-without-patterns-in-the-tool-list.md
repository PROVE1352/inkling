# 1940. Id arguments: a plain string in the tool list, checked by a refinement, resolved before the handler

- Status: Accepted
- Date: 2026-11-10

## Context
Every MCP client loads the tools/list answer before the first call. In 0.15.0 it was 65,971 characters,
about 16,504 tokens (`estimateTokens`, `scripts/mcp-tools-list-cost.ts`). 51 id fields were built with
`z.uuid()`, which zod renders as `"format":"uuid","pattern":"^([0-9a-fA-F]{8}-…|00000000-…|ffffffff-…)$"`:
about 195 characters per field, 9,927 characters in all, ~2,480 tokens (15% of the list). Three more
(`pageRef`) carried a short hex pattern. The pattern tells a model nothing it does not know from the
field name, and a wrong id got zod's "Invalid UUID".

## Decision
- `mcpTools/idSchema.ts`: `idArg(kind)` is `z.string().trim()` plus a zod **refinement** (a check, not a
  format): zod's JSON Schema output omits refinements, so the tool list shows `{"type":"string"}` and the
  description. The SDK still validates before the handler. Kinds: `page`, `trashedPage`, `workspace`,
  `thread` (full id or 8–32 hex characters, dashes allowed) and `full` (a full id only: versions and
  suggestions, which no tool prints short). The message names the id and where to get it:
  `expected a page id: the full id or its first 8+ hex characters (as find_context, list_pages and read_page print it)`.
- `core.ts uuid()` stays for modules owned elsewhere (contextTools.ts, inboxTools.ts): the same
  string schema with a kind taken from the field name (`FIELD_KINDS`: pageId, parentId, forPageId,
  collectionId, rowId, target → page; workspaceId → workspace; threadId → thread; anything else → full).
- `mcpTools/idArgs.ts resolveIdArgs` wraps `registerTool` like the meter (ADR 1552): at registration it
  walks the input schema (optional, nullable, default, arrays, nested objects, unions such as
  `'current' | version id`) once and records where the id fields are; on each call it replaces those
  values with full ids before the handler runs. A full id passes through unchanged with no lookup — the
  REST route checks access exactly as before. A resolution error is the usual `Error: …` result.
- Handlers therefore always see full ids (`loadAgentContext` still requires UUIDs). Where an argument
  is loosely listed and checked in the handler (update_fields `add`, ADR 1945), the handler resolves its
  ids itself.

## Measured
tools/list: 0 uuid patterns (was 51); the id fields cost ~2,460 tokens less. Whole-list numbers per
step are in ADR 1945 and docs/PERFORMANCE.md.

## Alternatives considered
- **Validate in each handler**: 45 handlers to touch, three of them in files other work streams own;
  `patch_section` and `find_context` would have lost validation or short ids.
- **A shorter regex** (`^[0-9a-f-]{8,36}$`): still ~40 characters per field and still a second rule
  next to the resolver's.
- **Kinds only from field names**: works for the shared helper, but an explicit kind documents the
  intent and lets `restore_page` (trashed pages) and version ids differ from the name rule.

## Consequences
- A malformed id fails in the SDK with the new message instead of "Invalid UUID".
- `create_from_template` told a custom template uuid from a built-in key with `uuid().safeParse`; it
  now uses `isFullId` (a prefix would have passed the new check).
- Tests: `mcpTools/toolSurface.test.ts` (accepted forms, messages, plans, every tool's id fields and
  their kinds, no pattern in the list).

## References
- apps/server/src/mcpTools/idSchema.ts, idArgs.ts, core.ts (`uuid`, `idArg`), shortIds.ts (`pageRef`)
- apps/server/src/mcp.ts (`buildMcpServer`), docs/adr/1541-*, 1552-*, 1941-*, 1945-*
