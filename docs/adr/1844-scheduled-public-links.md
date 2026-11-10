# 1844. Scheduled public links: a start time

- Status: Accepted
- Date: 2026-11-10

## Context
Announcements, exam answers and press pages need to go public at a set time. Links already expire
(docs/adr/1170-*); they could not start later.

## Decision
- **Column** `pages.share_starts_at timestamptz` (null = at once), next to `share_expires_at`,
  cleared with the token (`CLEARED_SHARE_LINK`). Set on `POST /pages/:id/share { startsAt }` or
  `PATCH … { startsAt | null }` (owners and admins). A start already past is stored as null. The start
  must be before the expiry (400), at most ten years away. Audit: `share.start_changed`
  before/after; `share.published` records it.
- **Time zone**: the browser turns the picked local date and time into an instant (the device's zone,
  shown under the field), as reminders do (docs/adr/1411-*). Inkling has no per-user time zone setting.
- **Before the start the link answers exactly like a link that is not shared**: 404 `NOT_FOUND` with
  the same body on every public route (`/api/public/:token`, files, folder children, unlock) and the
  plain unfurl shell (no title, no robots line that would set it apart), `Cache-Control: no-store`.
  Unlike an unknown token it is **not counted as a guess**, so early visitors are never banned.
- **After the expiry** nothing changes: 410 `SHARE_EXPIRED` (ADR 1170).
- The gate lives in `shareAccess.ts` (`shareNotStarted`, `assertShareOpen`) on the root page, so a
  folder's start covers its subtree.
- **UI**: "Schedule a start" before publishing, an "Opens" row with "Change start"/"Open now" for a
  published link, and an "Opens …" badge in Web shares.

## Alternatives considered
- **410 or a "not open yet" page before the start**: tells anyone with the link that something is
  scheduled there; a link that is not open yet should look like one that is not shared.
- **Publish at the start with a job**: the token would not exist yet, so it could not be sent ahead;
  a missed run delays the page.

## Consequences
- Tests: `shareSchedule.db.test.ts` (before/in/after the window on every route, no ban,
  validation, audit, list, unpublish), `shareAccess.test.ts`.
