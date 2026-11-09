# 1501. Old section anchors follow heading renames (from the change log)

- Status: Proposed (0.12)
- Date: 2026-11-09
- Amends: 0926 (anchors), 0930 (patch_section errors)

## Context
KNOWN-ISSUES AGENT-E2: a section anchor is its heading path slugged (ADR 0926). Renaming a heading —
or a parent heading — gives the section a new anchor, and an agent holding the old one (from an
earlier read_page, find_context or its own notes) got `SECTION_NOT_FOUND` from read_page(section) and
patch_section. ADR 1121 solved the same problem for page titles (`[[old title]]`) with a table of
former titles. Schema changes are out of this work's scope.

## Decision
- **Source: the change log.** `page_changes` already records every section rename as a `renamed`
  row with `prev_anchor` → `anchor` (ADR 0932), paired by heading block id, so a parent rename also
  records each child (`setup/backups` → `install/backups`). No new table or column.
- **Only on a miss** (`context/sectionMoves.ts`): when the reference does not resolve, the page's
  `renamed` / `removed` / `added` rows (newest 5,000, replayed oldest first) are followed from the
  old anchor: a rename moves the tracked section, a removal ends it, a later section that takes the
  old name is tracked too. What is tracked and exists now is the answer:
  - one anchor → served under it, with `movedFrom` in the REST response and a `moved_to: §new (the
    heading was renamed; "old" no longer exists)` line in read_page(section) and patch_section output;
  - several → `409 SECTION_AMBIGUOUS` listing them (the agent picks one);
  - none → `SECTION_NOT_FOUND` as before.
  The reference forms findSection accepts are tried (`§anchor`, heading text, `A › B` path) plus a
  short anchor (last path segment) when exactly one former anchor ends in it.
- **The version check is not relaxed.** A section version is sha1(heading path + body), so a renamed
  section has a new version even when its body did not change. A `replace`/`delete` with the old
  `baseVersion` gets `SECTION_CONFLICT` whose message names the new anchor and version and carries
  `movedFrom`; nothing is written; the retry is one call. (The old heading text is not stored, so the
  server cannot tell "only the heading changed" from "the body changed too".) Modes without a version
  (append, prepend, insert_after) and reads succeed directly.
- patch_section re-runs the whole request under the new anchor after the missed attempt (which
  wrote nothing): echo, version check and edit are those of the found section.

## Alternatives considered
- **Former anchors in a new table or a `page_chunks` column** (like ADR 1121): exact and
  retention-free, but a migration, owned by another work stream in this release. The resolver takes
  its rows through one function, so a table can replace the query later.
- **Heading block ids as anchors**: survive renames but not `update_page replace`, imports or vault
  uploads (ADR 0926), and agents cannot guess them; still accepted as a reference.
- **Newest rename wins instead of "ambiguous"**: silently edits a section the agent may not mean
  when an old name was reused.
- **Accept the old baseVersion when only the heading changed**: needs the old heading text, which
  nothing stores; accepting any version for a moved section would let an agent overwrite a person's
  edit made together with the rename.

## Trade-offs
- Bounded by the change feed's retention (`CHANGE_FEED_RETENTION_DAYS`, default 30) and by when the
  log is written: REST/MCP writes are indexed at once, editor typing after the index debounce
  (≤ 30 s) plus the outbox; inside that window the old anchor is still `SECTION_NOT_FOUND`.
- A miss costs one indexed query on `page_changes (page_id, seq)` plus the replay; hits cost nothing.
- `add_comment(section=…)` resolves anchors on its own and does not follow renames yet.

## Measured
`sectionMoves.test.ts` (replay: chains, parent renames, short anchors, removal, reuse, ambiguity);
`notationMoves.db.test.ts` through MCP: rename → read_page(old) moved_to, append via the old anchor,
stale baseVersion → conflict naming the new anchor, reused-and-renamed old name → SECTION_AMBIGUOUS,
unknown anchor → SECTION_NOT_FOUND unchanged.

## References
- apps/server/src/context/sectionMoves.ts, apps/server/src/routes/context.ts (`movedOrThrow`)
- apps/server/src/mcp.ts (read_page section `moved_to`), apps/server/src/mcpTools/contextTools.ts
- ADR 0926, 0930, 0932, 1121
