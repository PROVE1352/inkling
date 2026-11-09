# 1652. Trash then restore between two cursors leaves a line

- Status: Accepted
- Date: 2026-11-10

## Context
`foldRows` folds a window into net changes (ADR 0932/0933): a page trashed and restored again between
two cursors had `trashedAtStart = false` (its first event is a trash) and `trashedAtEnd = false`, and
only `true → false` printed "restored from trash", so the pair vanished. For a local copy the net state
is the same, but another client may have acted on the trash in between (dropped its copy, told a
person, stopped following it), and a person asking "what happened" sees nothing.

## Decision
- The page unit says `trashed, then restored` when the first trash event in the window is a trash and
  the last is a restore. A restore of a page that was already in the trash at the cursor keeps
  `restored from trash`; a page in the trash now stays "removed (no longer visible)".
- `catch_up` uses the same wording (first and last trash event of the window), instead of
  "restored from trash" for both cases.
- This differs from the section merge rule on purpose: a section edited back to its start within the
  merge window is deleted from the log (content identity cancels), because nothing a reader could act
  on remains. Visibility events do not cancel: they are what other clients react to.

## Alternatives considered
- Keep the net rule (nothing): what the user reported as a bug.
- Print both events with times: two lines and a time per page for a case that needs one line.
