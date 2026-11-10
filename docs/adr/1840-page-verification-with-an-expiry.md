# 1840. Page verification with an expiry

- Status: Accepted
- Date: 2026-11-10

## Context
Readers (and agents) cannot tell a page someone checked last week from one nobody has looked at
in two years. The review model (docs/adr/0951-*, 0953-*) estimates staleness; it does not let a
person say "this is correct". Confluence and Notion wikis offer "verified until" for this.

## Decision
- **Table** `page_verifications(page_id PK → pages cascade, workspace_id, verified_by → users set
  null, verified_at, expires_at NOT NULL, base_seq, note)`. One row per page; no row = not verified.
  A separate table, not columns on `pages`: most pages never get one, and `pages` is the hottest table.
- **Always expires.** `POST /pages/:id/verification { expiresInDays | expiresAt, note? }`: presets
  30/90/180 days (counted on the server clock) or "until a date" (the end of that local day, the
  device's time zone, as ADR 1170 does). At most 365 days. Re-verifying replaces the row.
- **State at read time**: past `expires_at` = `expired` ("Needs verification"); nothing rewrites rows,
  no job. `expiringSoon` = within the list's window (default 7 days).
- **Who**: browser sessions only (an agent cannot vouch for a page; tokens may read). A member who
  can edit the page (lock, people rows: `assertPageEditable`); when the page has a document owner,
  only that owner or a workspace owner/admin. Guests never (members-only routes). Folders are not
  verified. `DELETE` removes it under the same rule.
- **Verifying is also a review**: it sets `reviewed_at`/`reviewed_by` and recomputes the page's
  review priority, so a verified page leaves the review list. `pages.updated_at` is not touched.
- **Audit**: `page.verified` (after.expiresAt) and `page.unverified`; a private page's title is not
  written into the log.
- **List**: `GET /workspaces/:id/verified?days=&mine=1` → `{ expired, expiring, verified }`, only pages
  the caller can see (`visibleTo`), soonest expiry first, at most 500.
- **UI**: a badge under the title (green "Verified until …", amber "Needs verification", with
  "N sections changed since"), "Verify page…" in the ⋯ menu, and a "Verified pages" list dialog.

## Alternatives considered
- **Verification without expiry**: a badge from years ago is the problem this is meant to solve.
- **Reuse "Mark reviewed"**: a review date has no promise attached and no end; the two answer
  different questions (has anyone looked / does someone vouch for it until when).
- **Any member may verify**: a page with an owner is that person's responsibility (0951).

## Consequences
- Tests: `mcpTools/verifyStatus.db.test.ts`.
