# 1141. Logs that split themselves, and a one-time "large page" notice to the owner

- Status: Accepted
- Date: 2026-11-07

## Context
ADR 1140 splits a page that is already large. The production page got there through an agent loop
calling `update_page append` on one page for weeks; the hint in the tool output (ADR 1043) asks the
agent to use a child page, but nothing in the page itself kept new entries elsewhere, and the person
who owns the page was never told while it grew (ADR 1103 shows a notice only to someone who opens it).

## Decision
- **Page setting "New entries"** (web: the bottom of the split dialog; REST `GET/PUT
  /pages/:id/rotation`): `off` (default), `month` (one subpage per calendar month, titled `YYYY-MM`)
  or `size` (a new subpage titled `YYYY-MM-DD` once the current one stores `max_bytes`, 64 KiB–8 MiB,
  default 1 MiB in V1 bytes, measured like ADR 1103 from the TOAST header). Changing it needs edit
  rights on the page (edit lock included). Stored in a new table `page_rotations` (one row per page
  that has a setting or was hinted; `current_page_id`, `current_key`, `hinted_at`).
- **Where an append goes** is answered by `POST /pages/:id/rotation/target` → `{ pageId, title,
  rotated, created, mode }`: the page itself when it does not rotate; in `month` the current month's
  subpage (an existing live child doc with that exact title is reused, so a month made by hand or by
  a split is not duplicated; otherwise it is created under the tree lock with `assertPlacement`, like
  any page); in `size` the newest subpage (the page itself at first) until it is full.
- **MCP `update_page mode=append`** asks for the target first and appends there. The output names
  the subpage and why, instead of the usual line:
  `Appended to the end of subpage "2026-11" (pageId=…), not to the page you addressed: that page splits itself by month and new entries go to the current month's subpage.`
  `replace` and every other write still go to the addressed page. `POST /pages/:id/content` itself
  does not redirect: a REST call writes where it says, and that route is shared with other work.
- **The notice to the owner.** When the target route sees a page that does not rotate, has never
  been hinted, and is large by the ADR 1043/1103 thresholds (≥ 1 MiB V1 or ≥ 50k indexed tokens),
  it sends one notification of the new type `large_page` to the page owner (or, without one, the
  creator), if that person is a member who can see the page. `hinted_at` is claimed in the same
  statement that inserts the notification (`INSERT … ON CONFLICT … WHERE hinted_at IS NULL`), so
  concurrent appends send one. The row goes to the bell like reminders do (direct insert, no mail,
  `broadcastToUser`); clicking it opens the page with the split dialog (`?split=1`). The actor is the
  one whose append triggered it ("via <client>" for agents).
- **Cost on the append path**: the target route is one statement for a page that does not rotate
  and was hinted (rotation row, current subpage, size from the TOAST header); a page that was never
  hinted also sums its `page_chunks.token_estimate` while it is under the byte threshold.

## Alternatives considered
- **Redirect inside `POST /pages/:id/content`.** Every API client would follow the setting, but the
  route would write to a page other than the one in its URL, and that route's transaction is being
  changed by other work (outbox). The REST client can call the target route itself.
- **Rotate typing in the editor too.** A person appending at the end of a page sees where they type;
  moving them to another page mid-sentence would be surprising. The setting is about appends that
  nobody watches.
- **Notify through the notification engine (a new `NotifyKind`).** Needs subscription levels,
  per-hour caps and mail phrases for a message that goes to exactly one person once per page; the
  direct insert (like `reminder`, `webhook_disabled`) keeps the engine untouched.
- **Notify every time, or collapse with a group key.** A group key only collapses while unread, so a
  read notice would come back on the next append; `hinted_at` makes it once per page for good.
- **Store the setting in `pages.properties`.** Those are the page's user-visible frontmatter
  properties; a hidden machine setting there would show up in exports and the properties panel.

## Trade-offs
- `update_page append` makes one more internal request (measured in docs/PERFORMANCE.md).
- Month boundaries follow the server's time zone (as reminders do), not the reader's.
- Turning the setting off keeps the subpages; turning it on again starts from the current month (or
  from the page itself in size mode).
- A page that was hinted and later split and grown again is not hinted a second time.

## Measurements
docs/PERFORMANCE.md, "update_page append, rotation lookup" and "update_page append into a page that
rotates monthly" (Server & database) (`apps/server/scripts/split-bench.ts`).

## References
- apps/server/src/routes/splitPage.ts (`rotationTarget`, `rotateTo`, `maybeHintLarge`, `monthKey`)
- apps/server/src/db/schema-split.ts (`page_rotations`), apps/server/src/db/schema.ts (`large_page` type)
- apps/server/src/mcp.ts (`update_page`), packages/shared/src/pageSplit.ts, packages/shared/src/index.ts (`NotificationType`)
- apps/web/src/components/SplitPageModal.tsx (`RotationSettings`), apps/web/src/components/NotificationBell.tsx
- apps/server/src/routes/splitPage.db.test.ts
- ADR 1043 (agent hint), ADR 1103 (notice for people), ADR 1140 (split)
