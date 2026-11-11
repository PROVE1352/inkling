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
- patch_section on a section **next to** a group works as before. On the section that **holds** a group it
  is refused with nothing changed (context/sectionPatch.ts builds and indexes top-level blockContainers
  only); update_page, whose minimal replace refuses the same way, falls back to rewriting the document
  (docWrite.ts) and keeps the group. A refused edit inside the write gate no longer surfaces as an
  unhandled rejection (`gatedTransact` marks the store promise handled).

## Alternatives considered
- **Headings in columns as sections**: a section would start in the middle of one column and end in
  another; patching it could not keep the group.

## Consequences
- Follow-up for context/ (another branch owns it): make sectionPatch know top-level `columnList`
  (buildIncoming, indexContainers, the splice fallback), and let find_context's light Markdown print
  column blocks without the 4-space indent `blockLines` gives children.
