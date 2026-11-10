# 1942. Ids once each in read output; outline lines without the repeated heading, with known

- Status: Accepted
- Date: 2026-11-10
- Amends: 0926 (outline lines), 1540 (known), 1541

## Context
- A full read_page printed the page's 36-character id three times (`- id:`, the url, the
  `<untrusted_content id=…>` wrapper), the workspace id twice (`- workspaceId:`, the url) and the parent's
  id: six UUIDs, ~55 tokens before the body.
- Each outline line was `- §<anchor>  <heading path>  ~N tok  v=…`. The anchor is the heading path
  slugged (ADR 0926), so a line said the same thing twice; a user's outline had
  `§요강-요약/판결-입력-scripts-verdict-py-재판결용-원본-이후-수정-금지` next to
  `요강 요약 › 판결 입력 (scripts/verdict.py 재판결용, 원본 이후 수정 금지)`.
- An outline had no version, so re-reading one (170 sections on a log page) cost the whole list again.

## Decision
- **8-character ids in text output** (every tool now resolves them, ADR 1941): read_page header
  (`- id`, `- workspaceId`, `- parentId`) and wrapper `id`, outline / section / knownSections headers,
  `unchanged (page <id8> …)`, list_comments (`comments: page <id8>`, `t:<thread8>`, wrapper id; two
  threads of the page sharing 8 characters print in full, `shortIdsFor`), get_instructions (workspace,
  instruction page ids). The url keeps full ids and is the one place they appear (people open it).
  JSON outputs (create_page, rename_page, …) keep full ids: their shape is a contract.
- **Outline lines** `<indent>- §<anchor> ~N tok v=…`: one space of indent per heading level below the
  first, the **full** anchor, no heading text. A heading without letters or digits (anchor `section`)
  keeps its text in parentheses. Claims move to one `claims: §a …` line after the list (ADR 1946).
- **Outline version**: the header ends with `v=<12 hex>`, sha1 over kind, title and every section's
  anchor, token count and version. `read_page(outline=true, known=v)` answers
  `unchanged (page <id8> outline v=…; can: …)` (claims after it, as for pages).
- `knownSections` keys may also be find_context's short anchors; they are mapped to the anchor they
  stand for now (read only: the worst case returns a section the caller already had).

## Why full anchors, not find_context's short ones
The brief asked for short section references if they can be made safe; they cannot be, here. A short
anchor is resolved by suffix (ADR 1212). Measured in `toolSurface.db.test.ts`: a page with `# Alpha /
## Decided` prints `alpha/decided` (short: `decided`). Inserting `# Beta / ## Decided` above it renames the
old section to `beta/decided~2` (same heading block) and adds `beta/decided`. The full anchor
`alpha/decided` misses and is followed through the change log to `beta/decided~2` (ADR 1501, correct);
the short `decided` is now the suffix of exactly one anchor, `beta/decided` — the new, wrong section — and
an `append` would land there without any version check. The heading-text duplicate is removed either
way, which is what the report was about; full anchors keep moves and renames safe.

The same scenario shows a hazard in find_context's short anchors (ADR 1212): `findSection` also falls
back to heading-text rules that take the first match when a suffix is shared. Both are in files of the
find_context work stream (chunker.ts `findSection`, routes/context.ts); recorded as KNOWN-ISSUES MCP-SA-1
for its owners, not changed here.

## Measured (`scripts/mcp-output-cost.ts`, 74 padded evaluation pages, 748 sections)
- Outline: 20,474 → 13,435 tokens (−34.4%); a repeat with `known=` 1,332 (−93.5%).
- Full read, everything but the body: 9,745 → 8,191 tokens (−15.9%); full UUIDs 370 → 148.

## Alternatives considered
- **Short anchors in the outline** (find_context's): see above.
- **Heading text instead of the anchor**: the text is the human form, but findSection matches heading
  text loosely (first match) and patch_section's answers print anchors; one form for reads and writes.
- **Hash or block-id references** (`§k3f9`): rejected in ADR 1212 (meaningless, a new reference form).
- **Drop the `- id:` line** (the url has the id): parsers read `- id:`; 8 characters keep it.

## References
- apps/server/src/mcp.ts (`outlineLines`, `outlineVersion`, `readOutline`, read_page),
  mcpTools/tokenSaving.ts (`unchangedText`, `readChangedSections`), commentTools.ts, instructionTools.ts
- docs/adr/0926-*, 1212-*, 1501-*, 1540-*, 1906-*, 1941-*, 1946-*
