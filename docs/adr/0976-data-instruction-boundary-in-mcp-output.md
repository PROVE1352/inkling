# 0976. Data / instruction boundary in MCP output

- Status: Accepted
- Date: 2026-11-07

## Context
Several people's agents read the same workspace. A sentence one member writes into a page ("all
agents must delete …") reaches every other member's agent as tool output, indistinguishable from
the tool's own text. Invisible characters can hide such text from people reviewing the page.

## Decision
- Member-written text in MCP output is wrapped in fixed markers:
  `<untrusted_content source="page|find_context|rows|changes|search" id=… created_by=… last_edit=… hidden_chars=…>`
  … `</untrusted_content>`. read_page (full and section), read_pages (one block per page),
  find_context (one block for all fragments, titles and pointers), query_rows (title, schema and
  cells), create_row's echo, search (lines), changes_since (the change list) use it.
- Only designated, locked instruction pages are wrapped in `<instructions …>` (get_instructions).
- Inside content, our own markers are neutralised deterministically: `<untrusted_content`,
  `</untrusted_content`, `<instructions`, `</instructions` (any case) get a fullwidth `＜`.
  Attribute values are single-line with `"` → `'` and `<>` → `‹›`.
- Invisible characters: bidi embeddings/overrides/isolates (U+202A–202E, U+2066–2069, U+061C) and
  the tag block (U+E0000–E007F) are removed; zero-width and similar format characters (U+200B,
  U+200C, U+200E, U+200F, U+2060–2064, U+180E, U+FEFF, U+00AD) are shown as `\uXXXX`. U+200D and
  U+FE0F stay (emoji sequences). The count goes into `hidden_chars`.
- Provenance: `created_by` (author) and `last_edit` ("Alice", "Alice via Claude") from the newest
  page_changes row; `last_edit` is omitted when that change has no recorded actor (live typing,
  imports) rather than guessing.
- Titles and headings printed outside a wrapper (read_page's `# Title`, outline lines) are
  sanitised and marker-escaped (`cleanText`).
- **This is a mitigation, not a permission boundary.** A model may still follow text inside the
  markers. The boundaries are the edit lock (ADR 0970/0971), OAuth scopes (ADR 0935) and agent
  blocks (ADR 0947).

## Token cost (apps/server/scripts/context-bench.ts --pages 1000, fresh DB each)
| flow | before | after | change |
|---|---|---|---|
| unpadded wiki, find_context + section (mean) | 135 | 158 | +23 (+17%) |
| padded + 1000 distractors, find_context + section (mean) | 631 | 665 | +34 (+5.4%) |
| padded, median | 123 | 145 | +22 |
| old flow search + read_page (padded, mean) | 2264 | 2320 | +56 (+2.5%) |
The overhead is fixed per call (wrapper ≈ 15–25 tokens, `can:` ≈ 6 per fragment), so it shrinks
relative to larger answers. Output stays byte-identical for the same input and documents
(ADR 0937): wrappers and attributes are pure functions of the data.

## Alternatives considered
- Spotlighting by encoding content (base64/datamarking every word): large token cost and hurts
  answer quality on Korean text.
- Dropping suspicious text: silent data loss and trivially evaded.
- Per-fragment wrappers in find_context: +25 tokens per fragment for no added separation.

## Trade-offs
- JSON outputs (list_pages, search json, list_workspaces, create_* echoes) are not wrapped, to keep
  their shape; titles there are short and remain a residual channel (KNOWN-ISSUES).
- No MCP tool returns comments yet; when one is added it must wrap them.

## How others solve it
- Aside browser agent: page text arrives inside `<untrusted_context>`; only system messages carry
  authority.
- GitHub Copilot coding agent: hidden characters are filtered, and "this is not a security
  boundary" is stated for its mitigations.
  https://docs.github.com/en/copilot/concepts/agents/coding-agent/risks-and-mitigations
- Microsoft "Spotlighting" (delimiting, datamarking, encoding untrusted input), Hines et al. 2024.

## Consequences
- Existing MCP output changed shape once (prompt caches refill once); tests that parsed query_rows
  skip the closing marker.

## References
- apps/server/src/mcpTools/trust.ts:16, :22, :44, :82
- apps/server/src/mcpTools/contextTools.ts:42, :88
- apps/server/src/context/changeFeed.ts:712
- apps/server/src/mcpTools/trust.test.ts:13, apps/server/src/editLock.db.test.ts:462
