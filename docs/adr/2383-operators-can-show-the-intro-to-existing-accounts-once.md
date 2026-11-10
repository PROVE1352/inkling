# 2383. Operators can show the intro to existing accounts once (ONBOARDING_EXISTING_USERS=once)

- Status: Accepted
- Date: 2026-11-11

## Context
ADR 2380 keeps the intro away from accounts that existed before onboarding (migration 0060 marks them
`legacy`), so an upgrade never stops someone at work. An operator may still want everyone on their
server to see the intro once, for example when introducing the AI connection to a team that has
used the app for months.

## Decision
- **`ONBOARDING_EXISTING_USERS=once`** (also `1`, `true`, `on`, `yes`; read per call; empty = off, the
  default). While set, an account whose row is `legacy` (from migration 0060) or `off` (first seen while
  `ONBOARDING=off`) gets `intro: true` until it closes the intro once. `ONBOARDING=off` still wins.
- **Once, for good**: closing the intro (watched or skipped) stores `introSeenAt` in the person's row,
  the same field new accounts use. Nothing is kept in memory, so a restart with the variable still set
  does not show it again, and turning the variable off later leaves every row as it is.
- **Scope for existing accounts**: only the intro. Their checklist stays off (Settings › About turns it
  on): they have been using the app and most items would be ticked already, so an open card would be
  noise. No sample page is made for them (the card's button still makes one if they turn the card on).
- **The usual rules hold**: guests get no intro, bearer tokens get 403, an offline start never waits
  for the state, and the intro never opens over someone writing: while the focus is in the editor or a
  text field, the automatic intro waits for the next screen change or for the window to come back to
  the front (`onboarding/Host.tsx`). This applies to new accounts too.

## Alternatives considered
- **`ONBOARDING=all`.** One variable with three meanings (on, off, all) reads well but makes "all" look
  permanent; "once" says what happens, and keeping it separate leaves `ONBOARDING=off` as the single
  master switch.
- **Clear `legacy` in a migration or an admin action.** Also opens the checklist and the sample for
  everyone and cannot be undone by unsetting a variable.
- **A server-side "shown at" per boot or per deploy.** Would repeat the intro after every restart or
  release unless it was also stored per person, which `introSeenAt` already is.

## Trade-offs
- An existing account that never opens the app while the variable is set never sees the intro; that is
  the intent ("next time they come").
- Deferring while typing means a person who keeps the editor focused for a whole session sees the
  intro on their next screen change rather than at load.

## Consequences
- `.env.example` and `compose.yaml` pass `ONBOARDING_EXISTING_USERS`.
- `onboarding.db.test.ts`: off → no intro for an existing account; once → shown, checklist off, no
  sample, closed → not again (also with the variable still on); guests excluded; turned off → nothing
  changes; new accounts get the intro either way. Chrome check step 13: an account made while
  `ONBOARDING=off`, then a restart with `ONBOARDING_EXISTING_USERS=once`: the intro once, not after a
  reload, not after another restart.
