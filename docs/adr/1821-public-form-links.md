# 1821. Public form links: a token per form view, in their own table

- Status: Accepted
- Date: 2026-11-10

## Context
Some forms are for anyone with the link (sign-ups, bug reports). A page's public link
(`pages.share_token`, ADR 1110) shows the page and, for a collection, its rows, so it cannot be
reused: a form link must let visitors write one row and read nothing.

## Decision
- Table `collection_form_links` (migration 0044): `view_id` (PK, cascade with the view),
  `token_hash` (SHA-256, unique), `token_enc` (sealed copy for "copy link", purpose `share-token`
  with AAD `form:<viewId>`), `published_by`, `created_at`. Same token shape and storage as page links.
- `POST /collection-views/:id/form-link` turns it on: owners and admins, a form view, a collection
  that is not private, public links allowed in the workspace (`lockSharePolicy`), and the publisher can
  edit the collection. Idempotent. `DELETE` turns it off (owners, admins, anyone who can edit the
  collection): the row is deleted, so the old link stops at once and a new one is a new token.
  Both are audited (`form.published`, `form.unpublished`). `GET` shows the token to members.
- Visitors: `GET /api/public/forms/:token` returns the questions only (title, help texts, names,
  types, options); `POST` takes `{ values, website? }` and answers `{ ok: true }`. The web page is
  `/f/:token`.
- Every closed state answers the same 404 as an unknown token: view gone or not a form, collection
  trashed or private, workspace deleted or public links turned off, publisher not a member any more
  or unable to add rows. A guessed token counts as a failure for the IP ban (`recordFailure`).

## Alternatives considered
- Columns on `collection_views`: a token column on every view, and turning a link off would be an
  update that must remember to clear three columns.
- Reusing the page share token: publishing the form would publish the rows.

## Consequences
- Expiry and passwords of page links (ADR 1170, 1171) are not offered for forms in this version.
- Tests: `forms.db.test.ts`.
