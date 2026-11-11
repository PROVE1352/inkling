# 2424. A heading inside a column is not a section

- Status: Accepted
- Date: 2026-11-11

## Context
Sections (ADR 0926) split a page at its top-level headings; outline, find_context, patch_section,
section links, folds and presentation use them. A heading inside a column is nested under the group, and
a section boundary inside a group would cut one block (the group) in two.

## Decision
- A heading inside a column is **not** a section boundary anywhere: `splitSections` already walks top-level
  blocks only, and the web follows the same rule — the right-panel outline leaves headings inside columns
  out (links and tags inside columns still count), folds treat the group as one top-level block and can
  hide it, presentation does not split slides there.
- The whole group belongs to the section around it.
- patch_section on a section **next to** a group works as before. On the section that **holds** a group the
  group is one top-level unit (context/sectionPatch.ts indexes a top-level `columnList` with the
  blockContainers, and its echo key covers every block inside it): a group the agent sent back unchanged
  is kept with its ids, a group with any change inside is replaced whole (the blocks inside get new ids),
  and it never pairs with an ordinary block. The dry run also checks that the blocks inside a group
  survive the server's read. update_page's minimal replace uses the same code, so a full-page replace
  keeps the blocks around a group as well. A refused edit inside the write gate no longer surfaces as an
  unhandled rejection (`gatedTransact` marks the store promise handled; the caller still gets the error).
- find_context's section text (`blocksToLightMarkdown`, also the change feed's diff) writes a group with
  the same marker lines as read_page (`<!-- inkling:columns … -->`, `<!-- inkling:column -->`,
  `<!-- /inkling:columns -->`, widths when the columns differ) and the blocks inside without extra
  indentation. A section copied from find_context into patch_section keeps its group; without the
  markers the same text would turn the group into ordinary blocks.

## Alternatives considered
- **Headings in columns as sections**: a section would start in the middle of one column and end in
  another; patching it could not keep the group.

## Alternatives considered (find_context text)
- **Column blocks without markers, not indented**: fewest tokens, but text given back to patch_section
  unwraps the group.
- **Indented by four spaces** (the generic children indent): looks nested, but reads back as a code block
  or loses the group.

## Consequences
- A section with a group costs about 2 + n short lines more in find_context (n columns, about 8 tokens
  each). The marker words (`inkling`, `columns`, `column`, `widths` and the percentages) are in that
  section's search text too (`page_chunks.tsv` is generated from the text): a query for "column" can
  match a section because it holds a group. The chunker version is not bumped: no page had columns
  before 0.20, so no stored chunk changes.
- Editing one word inside a group renews the ids of the blocks in that group (links to a block inside
  a column by its id).
