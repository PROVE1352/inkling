# 1531. `suggest` is a flag next to `mode`, not another mode

- Status: Accepted
- Date: 2026-11-09

## Context
`patch_section` needed a way to say "do not write, leave it for a person". It already has `mode`
(`replace`, `append`, `prepend`, `insert_after`, `delete`).

## Decision
- `patch_section(…, suggest: true)` (REST: `suggest` in the `POST /pages/:id/section` body). The
  mode keeps saying what the change does; the flag says whether it is written now. The suggestion
  row stores the mode, and accepting applies it with that mode (ADR 1533).
- The answer is `202 { suggestion }` and the tool text starts with `Not written: kept as suggestion
  <id> …` and says why (asked, or the lock). `replace`/`delete` still need `baseVersion`: it is what
  the person later sees as "changed since the agent read it".
- `suggest` does not widen rights: the agent must be allowed to edit or to suggest (ADR 1532); a
  comment-only or read-only lock refuses it like a write.

## Alternatives considered
- **`mode: 'suggest'`**: loses what the change does (replace vs. append), so a second argument would
  be needed anyway, and every client validating `mode` would have to learn that one value is not a
  mode.
- **A separate `suggest_section` tool**: one more tool with the same seven arguments; agents pick
  tools by description, and a flag on the tool they already use is found more reliably.

## References
- apps/server/src/mcpTools/contextTools.ts (patch_section), apps/server/src/routes/context.ts
