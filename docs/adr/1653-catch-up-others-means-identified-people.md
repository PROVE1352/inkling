# 1653. catch_up "by others" means changes by identified other people

- Status: Accepted
- Date: 2026-11-10

## Context
catch_up put a page under "Pages changed by others" when any change in the window had an actor other
than the caller, and `actor_id IS DISTINCT FROM me` counted changes without an actor. Live typing that
cannot be credited to one person (several typists in one index window, CF-2, ADR 1625) has no actor, so
a page the caller and their agents changed twenty times moved to "others" because of one such edit.

## Decision
- `others` counts changes by an identified other person (`actor_id` set and not the caller);
  `unattributed` counts changes without an actor.
- A page is "changed by others" when `others > 0`, or when **all** its changes in the window are
  unattributed (none are the caller's): nobody can say it was the caller, and hiding it among the
  caller's own changes would be the worse mistake. Own changes plus unattributed ones stay in "Your
  own changes".
- Either way the head says `unattributed edits N`. The header count, the group and the ranking use the
  same predicate (one SQL column).

## Alternatives considered
- Count unattributed edits as the caller's when the caller is the page's creator: the creator is not
  the typist; the window's typists are not stored.
- Hide unattributed edits: they are real changes; a reader should know some edits have no name.
