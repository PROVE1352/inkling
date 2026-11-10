# 1841. "Changed since verification" comes from the change feed

- Status: Accepted
- Date: 2026-11-10

## Context
A verified page that has been rewritten since is not the page that was verified. Readers need to
see that without diffing versions by hand.

## Decision
- At verification the page's change-feed high-water mark (`max(page_changes.seq)` of the page) is
  stored as `base_seq`. "Changed since" = distinct section anchors of rows with `seq > base_seq` and
  kind `added | modified | removed | renamed`; page-level events (rename, move, props) do not count.
- `changedMuch` = at least 3 sections, or one row marked `large` (too big to diff).
- The verifier's own changes logged within 5 minutes of verifying are part of what they verified:
  the document store and the change log run a few seconds behind the editor, so the last edits
  before "Mark verified" often land after it.
- One grouped query per call (list or page), on the existing `(page_id, anchor, seq)` index.

## Alternatives considered
- **Compare the verified snapshot with the current state**: needs a snapshot per verification and a
  section diff per read; the change feed already has both.
- **Count by time (`changed_at > verified_at`)**: the same log delay, and no cheaper.

## Consequences
- Change-feed retention purges old rows; for verifications older than it the count is a lower
  bound. Changes merged into a row older than `base_seq` (the 10-minute merge window,
  docs/adr/0932-*) are not seen. Both are said in the DTO comment.
