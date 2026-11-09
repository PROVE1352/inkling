# 1545. Auto-accept rules

- Status: Accepted
- Date: 2026-11-09

## Context
Under the "auto" level (ADR 1544) some agent edits should land without a person: appending to a log,
adding a section, small fixes from a trusted connection. Which ones, and how to keep "nobody
reviewed it" from hiding a conflict?

## Decision
- A suggestion is accepted by the rule only when all of these hold, checked in this order (the first
  failure is the reason given to the agent and shown to people):
  1. not a whole-page edit (`update_page` is always reviewed: its write has no version check);
  2. its mode is allowed: by default `append`, `insert_after`, `prepend`; `replace` and `delete`
     only when switched on;
  3. its connection (`grant:<id>` / `token:<id>`) is on the allow list; an empty list = every
     connection in the workspace;
  4. the section still exists and is exactly at the suggestion's base version — **always, no
     setting, no exception**; it is checked again atomically by the patch itself (the base version
     is passed to `patchSectionAs`, compared inside the Yjs transaction), so a concurrent edit turns
     the accept into "needs review";
  5. the change fits the size limit: changed lines / characters of the diff against the current
     section (`maxLines`, `maxChars`; unset = none), the same diff a person would see.
- **Applying**: the same path as a person's accept — section patch, write gate, edit lock,
  "Before AI edit"/"AI edit" snapshots — run as the author's person outside the agent scope (the
  agent itself may only suggest), labelled `<client> · auto-accepted` in history and the change
  feed. The row records `rule` (`workspace` / `page:<id>`) and, as decider, the person who last set
  that rule. The row is claimed (open → accepted) before the edit; a failed edit puts it back to open
  with the reason, for a person.
- **Grace period** (optional, minutes): the suggestion waits with `auto_at`; a sweeper (every 30 s,
  and callable as `runAutoAccepts`) takes due rows by clearing `auto_at` in one UPDATE — only one
  process gets a row — then re-checks: the rule in force must still be the same one, the section
  unchanged, the rules still passing; otherwise the row stays open for a person with the reason
  ("the section changed during the grace period", "the auto-accept rule changed …"). A person may
  accept or reject during the wait; the status guard makes the sweeper skip it.
- **Notifications**: accepted at once → none (the tool answer is the result; nothing to approve).
  With a grace period → `approval_request` at creation ("auto-accepted in N min unless rejected")
  and `approval_result` to the author when the rule accepts it. Held for review → `approval_request`
  as for any suggestion.
- **Agent answers**: `Done (append): auto-accepted under the workspace rule (suggestion <id>); §x is
  now v=…`, `Not written yet: … will be auto-accepted at <time>Z unless a person rejects it`, or
  `Not written: kept as suggestion … \n needs review: <reason>`.
- Rules change only in the web app: the workspace default by owners/admins, a node's rules by who may
  manage its lock; both audited.

## Alternatives considered
- **Accept regardless of a changed section when the mode is "safe"** (append): an append after
  someone rewrote the section can still be wrong in context; the brief and this ADR make the base
  check unconditional.
- **Raw Markdown length as the size**: a replace that changes one word of a long section would count
  as large; the diff is what a reviewer would have read.
- **Run grace accepts from housekeeping**: its interval is too coarse for minute-scale waits.

## Consequences
- Partial (per-hunk) acceptance is still the next step (ADR 1530).
- The reason texts are English server strings shown as-is in the web view.

## References
- apps/server/src/autoAccept.ts (`reviewReasonFor`, `applyByRule`, `runAutoAccepts`),
  apps/server/src/suggestions.ts (`createSuggestions`), apps/server/src/mcpTools/collabTools.ts,
  apps/server/src/mcpTools/autoAccept.db.test.ts
