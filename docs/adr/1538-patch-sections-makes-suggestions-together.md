# 1538. patch_sections makes suggestions too, all together

- Status: Accepted
- Date: 2026-11-09

## Context
`patch_sections` (ADR 1542) applies several section edits all or nothing. When it was written,
suggestions (ADR 1530) were being built in the same step, so on a page locked to "agents:
suggestions only" it answered `403 SUGGESTIONS_ONLY` and sent the agent back to one `patch_section`
per section: the round trips the batch exists to save, and suggestions that could land half.

## Decision
- `patch_sections(…, suggest: true)` (REST: `suggest` in the `POST /pages/:id/sections` body), and
  the same without asking under the "suggestions only" lock: every edit becomes a suggestion for its
  section, with the mode and baseVersion it carries. The decision is the one `patch_section` makes
  (`suggestionMode`: asked → may this agent suggest at all; lock → only when the lock allows
  suggesting; otherwise the usual edit check and a direct write).
- All or none: every edit is resolved (anchor, heading text, block id, rename trail of ADR 1501) and
  convertibility-checked first; then all rows are written in ONE transaction under the write gate
  (`createSuggestions`). A section named twice is refused, as in a direct batch. A failure writes no
  row and answers the single error (404 SECTION_NOT_FOUND, 400 …) rather than the `SECTIONS_CONFLICT`
  list.
- As for one suggestion: claims of other connections and stale base versions do not stop it (the
  person sees "changed since"); the same connection's open suggestion for a section is superseded.
- One `approval_request` per batch ("N suggested edits: §a, §b"), not one per section.
- Answer `202 { suggestions }`; the tool prints `Not written: kept as N suggestions …` with one line
  per suggestion id.

## Alternatives considered
- **Keep `SUGGESTIONS_ONLY`**: simple, but the batch is exactly what an agent uses for a multi-section
  rewrite, which is what a reviewing team wants to see as one set.
- **One suggestion row for the whole batch**: accept/reject would then be all or nothing across
  sections; per-section rows let a person keep some and drop others, and per-hunk acceptance (next
  step, ADR 1530) works on sections anyway.

## Consequences
- The "Before AI edit" / "AI edit" snapshot rule now lives in one place
  (`context/sectionWrite.ts`: `beforeAgentEditSnapshot`, `afterAgentEditSnapshot`), used by
  patch_section, patch_sections, accepting a suggestion and update_page append.

## References
- apps/server/src/suggestions.ts (`createSuggestions`, `suggestionMode`), apps/server/src/routes/sectionBatch.ts,
  apps/server/src/mcpTools/patchSections.ts, apps/server/src/context/sectionWrite.ts
