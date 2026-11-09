# 1620. Reverting a logged change: 3-way on the change log's text, blocks from the page and its versions

- Status: Accepted
- Date: 2026-11-10

## Context
People want to undo one agent edit without losing what happened after it ("revert only what the
agent did"). Version restore (ADR 1100-1104, 1513) is all-or-nothing for the whole page. The change
log (`page_changes`, ADR 0932) has one row per changed section with the section text before and
after. Before building on it we checked what that text can carry:

| Artifact | What it keeps | Gaps for an inverse |
|---|---|---|
| `page_changes.before_text/after_text` | light Markdown of the section body (`blocksToLightMarkdown`) | marks, links, colors, embed/file/image details flattened; 16 KB cap (`large`); a row merges an actor's edits within 10 min |
| "Before AI edit" snapshot | the whole Yjs state before an agent replace/delete | one per page per 2 min; none for append/insert |
| "AI edit" snapshot | state after an agent append/insert | throttled 10 min per page |
| auto snapshots | state every ≥10 min while edited | arbitrary moments |

So the change log says exactly WHAT changed and lets us detect later edits, but it cannot rebuild
removed formatting; no snapshot pair brackets every change either.

## Decision
- The inverse is a 3-way merge (`context/merge3.ts`) in light-text units, one unit per top-level
  block: base = the row's after text, theirs = its before text, ours = the section now (live).
  Logged text is cut into the same units with a dictionary of known blocks (the page now and the
  newest stored versions before the change) so a multi-line block (list with children, code,
  table) is one unit.
- The result is written as blocks, never as flattened text: units kept from the section now are the
  live blocks (the minimal section edit, ADR 0940, leaves them untouched: ids, colors, marks,
  concurrent typing); units brought back come from the richest source that renders to exactly that
  text — a block still in the page, then a block of a stored version (the "Before AI edit" snapshot
  an agent replace/delete leaves, up to 6 versions before the change), then for plain paragraphs,
  list items, quotes and headings the text itself (reported as `plainText`). A block no source can
  rebuild (image, table, embed) is not guessed: its hunk is a conflict with reason `no_source`.
- Copied blocks get new ids (a block never appears twice under one id).
- Supported kinds: `modified`, `renamed` (body only), `added` (the section is removed again when
  nothing of it was changed since), `removed` (the section comes back from the version that has it
  with the same text, after its old neighbour). Not here: page events, moves, heading-only renames,
  `large` rows — answered as `unsupported` with a reason pointing to version history.

## Alternatives considered
- **Inverse of the text diff applied as text**: rewrites the section from light Markdown, losing
  marks and props in every block of the section, not only the reverted ones.
- **Only when a snapshot pair brackets the change**: exact, but most edits in a burst share one
  "Before AI edit" snapshot and appends have none; most agent edits would be refused.
- **Store rich before/after per row (blocks JSON)**: the exact answer, needs a schema change
  (`page_changes.before_blocks`) — proposed for 0.14, not this wave (schema owned elsewhere).

## Consequences
- A revert never touches blocks it does not restore; formatting of restored text is kept whenever a
  stored version still has the block, else the preview says how many blocks come back plain.
- A row that merged several edits of one agent within 10 minutes is reverted as one.
- Typing indexed together with an agent's write would have been reverted with it; ADR 1625 removes
  that case for writes through the server.

## References
- apps/server/src/revert.ts, apps/server/src/context/merge3.ts, apps/server/src/context/sectionBatch.ts
