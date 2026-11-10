# 1845. Member status: one per account, cleared at a set time

- Status: Accepted
- Date: 2026-11-10

## Context
Teams want to know who is away before mentioning or assigning ("exam week, back Friday").

## Decision
- **Table** `user_statuses(user_id PK, emoji, text ≤ 80, clear_at, updated_at)`: one status per
  account, shown in every workspace the person shares with the viewer.
- **Clear time** is an instant picked on the device (in an hour, tonight, end of this week, a date
  and time; the zone is shown). A status past `clear_at` is treated as absent wherever it is read
  (`clear_at IS NULL OR clear_at > now()`); no sweep job.
- **Routes**: `GET/PUT/DELETE /me/status`; setting and clearing are browser-session only (agents
  read it, never set it). `GET /workspaces/:id/members` returns `status` per member.
- **UI**: Settings → Account → Status; a chip in the members panel; before the email in the `@`
  mention menu; the emoji on presence avatars with the text in the tooltip (docs/adr/1846-*).

## Alternatives considered
- **Per workspace**: needs a picker per workspace for a fact about the person; can be added later
  with a nullable workspace id.
- **Columns on `users`**: the hottest auth table; a side table keeps the row narrow.
