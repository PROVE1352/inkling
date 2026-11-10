# 2186. Workspace arguments take a name as well as an id

- Status: Accepted (extends 1940, 1941)
- Date: 2026-11-10

## Context
Narrowing find_context to one workspace needed its id: list_workspaces first, then the id, although
the person and the agent both know the workspace by its name ("the OIBC workspace"). Since 0.15.1 id
arguments take 8-character prefixes (ADR 1940/1941), checked by a zod refinement that admits hex only,
so a name was refused before any handler ran. find_context's workspaceId was still built with the
shared `uuid()` (kind from the field name, check `CHECKS.any`, shared with page ids).

## Decision
- **Resolution order** (`matchWorkspaceRef`, `mcpTools/idArgs.ts`), among the workspaces list_workspaces
  shows this connection (member, live, agent blocks and connection range applied); the first rule that
  matches anything decides:
  1. a full id: passed through unchanged, as before (the route checks membership);
  2. a value that looks like an id prefix (8+ hex characters): the workspaces whose id starts with it;
     when none does, it is tried as a name (a workspace may be called "deadbeef" or "20261110");
  3. the exact name, compared NFKC, case-insensitive, runs of whitespace as one space;
  4. the start of a name, at least 2 characters: one character ("O") is too easy to hit by accident in a
     write tool (create_page, import_folder take the same argument).
- **One match** is the answer; **several** are an error that lists them (`aaaaaaaa "Twin", bbbbbbbb
  "twin"`, at most 20) and asks for an id; **none** is an error that lists this connection's workspaces
  (the shape of the `inferWorkspace` error, ADR 1943). A workspace the caller is not in is never matched
  or named. Names in errors go through `cleanText`.
- **Schema**: `CHECKS.workspace` admits any trimmed string of 1–100 characters (names are at most 60);
  the message says "expected a workspace id or name". `CHECKS.any`, shared with page ids, stays hex-only.
  find_context's workspaceId is now `idArg('workspace')`, described "Limit to one workspace, id or name
  (default: all of yours)"; get_instructions' says "Id or name. Default: …". The refinement is not in the
  tool list (ADR 1940), so the other tools' schemas did not change.
- **Every tool built with `idArg('workspace')` takes names**: find_context, search, list_pages,
  catch_up, changes_since, later, get_instructions, create_page, import_folder, list_templates,
  create_from_template, create_collection, list_trash, check_notes, import_zip. Their descriptions were not changed (owned elsewhere); SERVER_INSTRUCTIONS says
  once that a name works (ADR 2185/this ADR, one sentence).
- `inbox`'s workspaceId is still built with `uuid()` and takes ids only (not changed here).

## Alternatives considered
- **Names in find_context only**: the same argument meaning different things in different tools.
- **Names first, ids second**: an 8-hex name would shadow a real id prefix; ids are what tools print.
- **Substring or fuzzy match** ("2026" anywhere in the name): a write could land in a workspace the
  agent did not mean; a unique prefix is as far as it goes, and anything else is an error with the list.
- **No prefix at all (exact names only)**: agents shorten names ("OIBC" for "OIBC 2026 태양광"); a unique
  prefix of 2+ characters costs nothing and errors list the full names when it is not unique.

## Consequences
- `workspaceId: "OIBC"` works without list_workspaces; a wrong or ambiguous name answers with the list.
- Renaming a workspace changes what a stored name means; agents that keep ids are unaffected.
- Tool list: find_context +12 characters (~3 tokens), get_instructions +12 (~3), others unchanged;
  `scripts/mcp-tools-list-cost.ts --by-tool` 12,767 → 12,773 tokens (with ADR 2185's instruction line
  counted separately).
- Tests: `mcpTools/workspaceScope.test.ts` (order, hex-looking name, exact name beats a longer one it
  starts, NFKC, ambiguous, one-character prefix refused, empty list, cleaned names, schema per kind) and
  `mcpTools/workspaceScope.db.test.ts` (find_context, list_pages, create_page by name; ambiguous; another
  member's workspace by name is "not found" and not listed; too long refused by the schema).
  `toolSurface.db.test.ts` (prefix of a workspace the caller is not in) passes unchanged.

## References
- apps/server/src/mcpTools/idArgs.ts (`resolveWorkspaceRef`, `matchWorkspaceRef`), idSchema.ts
  (`isWorkspaceRef`, `CHECKS.workspace`), contextTools.ts, instructionTools.ts
- docs/adr/1940-*, 1941-*, 1943-*, 2185-*
