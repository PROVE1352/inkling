# 1542. patch_sections: several section edits, all or nothing

- Status: Accepted
- Date: 2026-11-09

## Context
An agent that rewrites a page usually changes several sections at once (fix the setup steps, append
to the log, add a new "Retention" section). With patch_section that is one call per section: N round
trips, N tool results in the context, and no way to say "all of these or none". If the third call
conflicts, the first two are already written and the page is half updated; the agent has to notice,
re-read and repair.

## Decision
- New MCP tool `patch_sections(pageId, edits[])` and route `POST /api/pages/:id/sections`
  (`routes/sectionBatch.ts`). Each edit is exactly a patch_section edit (`section`, `mode`,
  `markdown`, `baseVersion`; baseVersion required for replace/delete), up to 20 per call, applied in
  order.
- **One permission pass, one write gate.** Membership, visibility, the edit lock
  (`assertPageEditable`) and other connections' section claims are checked once; all edits run inside one `gatedTransact` under one
  `pageEditGate` (ADR 1150), with one "Before AI edit" snapshot when any edit is replace/delete, or
  one throttled "AI edit" snapshot otherwise (ADR 0936). Rate limit as patch_section (30/min per
  request).
- **All or nothing** (`context/sectionBatch.ts`):
  1. Before the transaction every edit's section is resolved against the current outline (anchor,
     heading text or path, and an anchor from before a heading rename via ADR 1501), each Markdown
     body is parsed and convertibility-checked, and duplicates are refused ("§x is edited twice").
     Stale baseVersions are reported here too, with the current text, so one answer lists every
     problem. Sections claimed by another connection (ADR 1536) are listed the same way.
  2. Inside the synchronous transaction callback (nothing can interleave), every target is found
     again **by its heading block id** and every baseVersion is compared once more with the live
     document.
  3. The whole batch runs on a **copy** of the document; any failure there (a section an earlier edit
     removed, a structure error, a validation fallback that throws) writes nothing.
  4. Then the same deterministic sequence runs on the live document: applySectionPatch's own
     copy-then-live rule (ADR 0940) lifted to the batch.
- Edits after the first target their section by heading block id, not by anchor, so an earlier edit
  that renames a heading or inserts a section with the same title does not redirect a later one.
- A failure answers 409 `SECTIONS_CONFLICT` with `conflicts[]` (`index`, `ref`, `anchor`, `reason`:
  version / not_found / ambiguous / duplicate / empty / claimed / invalid, the current `version` and `markdown`
  for version conflicts) and `anchors` (the page's anchors, first 50). The tool prints one line per
  failing edit and the current text inside `<untrusted_content>`.

## Alternatives considered
- **Apply edits one by one and roll back on failure**: Yjs has no transaction rollback; undoing
  through an UndoManager would race with live editors and leave tombstones. The copy dry run gives
  the same guarantee without touching the live document.
- **Resolve every edit by anchor at apply time**: an insert_after that adds "## Setup" before an
  existing "Setup" section shifts the `setup`/`setup-2` anchors between edits; block ids do not move.
- **Allow the same section twice** (e.g. replace then append): ordering rules become subtle (a
  replace that changes the heading changes the second edit's target); combining them into one edit
  is always possible.
- **Reuse D's `patchSectionAs` (context/sectionWrite.ts)**: it was being introduced in the same
  release step; the batch shares the low-level pieces (applySectionPatch, echo index, moved-anchor
  lookup); the snapshot rule is shared (`beforeAgentEditSnapshot` / `afterAgentEditSnapshot` in
  context/sectionWrite.ts, ADR 1538).

## Consequences
- 3 appends: 3 round trips → 1; tool output 40 → 26 tokens; wall time p50 76–155 → 34–66 ms over three
  bench runs (docs/PERFORMANCE.md). The bigger saving is the context the agent does not need for partial
  failures and repair reads.
- Server cost per batch: the document is read once for the checks and the batch is applied twice
  (copy, live), each applySectionPatch also validating on its own copy; bounded by 20 edits.
- A live failure after a successful dry run would be a determinism bug; it throws (500) and is
  logged, and the edits applied before it stay (the same exposure as patch_section's own fallback).
- Section claims (ADR 1535–1536): a section claimed by another connection is a `claimed` conflict
  (nothing written), like patch_section's refusal.
- Suggestions (ADR 1530–1532): with `suggest: true`, or on a page locked to "agents: suggestions
  only", the batch leaves one suggestion per section, all made together or none (ADR 1538; this
  replaced the earlier 403 `SUGGESTIONS_ONLY`).
- Tests: `mcpTools/tokenSaving.db.test.ts` (success with versions, every conflict listed and nothing
  written, duplicates, missing baseVersion, read-only tokens, a locked page as patch_section).

## References
- apps/server/src/context/sectionBatch.ts, apps/server/src/routes/sectionBatch.ts,
  apps/server/src/mcpTools/patchSections.ts
- ADR 0930, 0940, 1150, 1500, 1501
