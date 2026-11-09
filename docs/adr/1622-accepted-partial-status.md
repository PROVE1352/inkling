# 1622. `accepted_partial`: a suggestion of which some hunks were applied

- Status: Accepted
- Date: 2026-11-10

## Context
After per-hunk acceptance (ADR 1621) the agent and the history must tell "all of it went in" from
"some of it did".

## Decision
- New value of the existing `section_suggestions.status` text column (no CHECK constraint, no schema
  change): `accepted_partial` when the applied hunks are fewer than the effective ones (hunks people
  had already made are not counted).
- `{applied, total}` is kept in the plugin_storage entry that held the base (ADR 1621) and returned
  as `partial` in the DTO.
- `approval_result` reads `accepted_partial (2 of 3 changes): suggestion …`; `list_suggestions`
  prints `accepted_partial (2 of 3 changes applied)`; the web history "Partly accepted by …".
- Applying every effective hunk is `accepted`.

## Consequences
- Clients that switch on status must treat `accepted_partial` as decided.

## References
- packages/shared/src/suggestions.ts, apps/server/src/suggestions.ts, apps/server/src/mcpTools/collabTools.ts
