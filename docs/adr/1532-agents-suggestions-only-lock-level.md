# 1532. "Agents: suggestions only" lock level

- Status: Accepted
- Date: 2026-11-09

## Context
Page locks (ADR 0970, 0971) have an agents rule: `same`, `comment`, `read`. Teams wanted a fourth:
agents may work on the page, but nothing lands without a person.

## Decision
- `LOCK_AGENTS = ['same', 'suggest', 'comment', 'read']`, shown in the lock dialog between "Same as
  their person" and "Comment only".
- A new bit `CAP_SUGGEST = 4`, for agents only. The `suggest` preset writes the agents row
  `allow SUGGEST, deny EDIT`; `comment` and `read` now also deny SUGGEST. An agents layer that
  denies EDIT without allowing SUGGEST also takes SUGGEST away, so rows written before this bit
  existed (`deny EDIT` only) still win over an outer `suggest` lock. Presets read back by the allow
  bit (`nodePresets`).
- SUGGEST only counts while the agent's person may edit the page (lock people rules, people rows):
  a suggestion is an edit waiting for a person and cannot reach further than that person.
  `effectiveCaps` drops the bit otherwise, `capsFor` keeps it only where the people rows allow
  editing, and `suggestionRight()` answers `edit` / `suggest` / null for a request.
- Under the lock, `patch_section` and `update_page` (both modes) make a suggestion instead of
  writing (origin `lock`); every other write (rename, move, trash, rows, create under it) is refused
  with a message that names the two tools that work. The `can:` line says `suggest` instead of
  `edit`. People are not affected.
- Lock changes stay browser-only and bump the access version like every lock change (ADR 1071).

## Alternatives considered
- **No new bit, decide from the preset name at write time**: the evaluation order (nearest node
  wins, field-wise inheritance) would have to be repeated outside `effectiveCaps`.
- **Make every agent write under any lock a suggestion**: changes what existing `comment`/`read`
  locks mean.

## Consequences
- Older servers reading a `suggest` row see `deny EDIT` (comment only): a downgrade keeps the page
  closed to direct agent edits.

## References
- apps/server/src/editLock.ts, packages/shared/src/editLock.ts, apps/web/src/components/PageLockModal.tsx
