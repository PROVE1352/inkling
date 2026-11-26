# 2573. Conflict text is data, member strings outside a wrapper are one line, markers escape across gaps

- Status: Accepted
- Date: 2026-11-26
- Amends: ADR 0976, 0975

## Context
The 0.25.3 review (C-mcp M4, L4, L5, M1) found four ways around the data/instruction boundary of
ADR 0976: patch_section and update_row conflicts printed the member-written current text bare (no
`<untrusted_content>`, no marker escape, no taint record); titles, file names and author names
printed outside a wrapper kept their line breaks (a title could add a fake `can:` or `applies:`
line), and read_pages' "Not shown" titles were not cleaned at all; `escapeMarkers` only matched `<`
directly followed by the tag name, so `<` + U+200D (or a Hangul filler, a space, a newline) +
`/untrusted_content>` passed; and the `applies:` line and `<instructions>` blocks did not say whose
workspace a rule came from.

## Decision
- **Conflicts**: patch_section's 409 prints the current section inside `<untrusted_content
  source="page">` with the `suspicious:` note, and records the read for that section only (as
  read_page(section=…)); patch_sections records the conflicting sections it shows; update_row's
  conflict wraps the cells (`source="rows"`) and records the read on the collection (as query_rows);
  `POST /pages/:id/section` records a personal API token's read of the section in its 409.
- **One line**: `cleanText` (trust.ts) folds every run of spacing and line breaks (also U+0085,
  U+2028/2029, U+001C–001F) into one space. It is the one function for member strings printed outside
  a wrapper; JSON output (`cleanStrings`) keeps line breaks, which JSON escapes. A static test lists
  the reviewed raw interpolations in the files touched here; a new one fails until it is cleaned or reviewed.
- **Marker escape**: `<` (or U+FE64) followed by up to 32 gap characters, an optional `/`, up to 32
  more, and the tag name with up to 8 gap characters between letters is escaped, case-insensitively.
  Gap characters: spacing, `\p{Cf}`, `\p{Mn}`, the Hangul fillers, U+2800, and a typed `\uXXXX`. The
  escape runs before invisible characters are stripped or shown. The bounds keep the scan linear.
- **Whose rules**: `<instructions … workspace="Name">`, get_instructions' header says the rules apply
  only in that workspace, find_context's `applies:` puts `{Name}` before each title, and the server
  instructions say a workspace's instructions apply only to work in that workspace. find_context's
  `applies:` already came only from the pages it shows; that stays.

## Alternatives considered
- **Escape every `<` in member text**: robust but changes every page that shows HTML or comparisons.
- **A separate `oneLine(cleanText(x))` at each call site**: ~90 call sites, and the next one forgets it.
- **Refuse member-written workspaces' instructions** (invite and accept before joining): the real fix
  for C-mcp M1, a product change left to the maintainers.

## Consequences
- Tool output changes bytes only where member text had line breaks, the new gaps, or a conflict.
- Titles with intended line breaks show them as spaces outside the page body.

## References
- apps/server/src/mcpTools/trust.ts, contextTools.ts, patchSections.ts, collectionTools.ts,
  instructionTools.ts, apps/server/src/agentInstructions.ts, apps/server/src/mcp.ts
- apps/server/src/mcpTools/trustSec26.test.ts, apps/server/src/mcpTools/sec26d.db.test.ts
