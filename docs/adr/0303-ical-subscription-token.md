# 0303. iCal subscription: per-user secret URL, token stored as SHA-256

- Status: Accepted
- Date: 2026-11-07

## Context
Calendar clients (Google, Apple, Outlook) subscribe to a URL and poll it without cookies or OAuth.
The feed contains every dated item the user can see, so the URL is a bearer credential.

## Decision
- `POST /api/me/ical` issues 32 random bytes (base64url, 43 chars, 256 bits). Only `sha256(token)` is
  stored (`ical_tokens.token_hash`, unique; one row per user). The full URL is returned once; the
  settings page shows it once and offers Regenerate (old URL dies immediately) and Revoke.
- `GET /ical/<token>.ics` (outside `/api`, no session) looks the hash up, then builds the feed with the
  same module and visibility rules as the in-app calendar (`collectDateItems` + `visibleTo`) for every
  workspace the user belongs to. Unknown tokens get a plain 404.
- The global rate limiter skips non-`/api` GETs, so the route sets its own limit (30/min per IP,
  verified: requests 31+ → 429). `last_used_at` is refreshed at most hourly.
- Responses carry `Cache-Control: private, max-age=300`, `ETag` (sha256 of the body) with
  `If-None-Match` → 304, `X-Robots-Tag: noindex`, `Referrer-Policy: no-referrer`.
- The PWA service worker excludes `/ical/` from its navigation fallback.

## Alternatives considered
- **Store the token in plaintext** to show it again: a DB leak would expose every feed.
- **Per-workspace tokens**: more URLs to manage; users usually want one calendar.
- **Signed (HMAC) stateless URLs**: no table, but revocation needs a key rotation for everyone.

## Trade-offs
The URL cannot be shown again after creation (regenerate instead). Anyone holding the URL sees the
feed until it is regenerated/revoked; the token is not scoped further.

## How others solve it
Google Calendar "secret address in iCal format", GitHub/Todoist/Notion-calendar style secret feed
URLs with a "reset" button — same model.

## Consequences
Deleting a user cascades their token. Changing visibility (e.g. a page moved to the private section)
is reflected on the next poll.

## References
- apps/server/src/db/schema-collections.ts (`ical_tokens`)
- apps/server/src/routes/ical.ts:194 (feed route), :199 (rate limit)
- apps/web/src/components/IcalSettings.tsx
- apps/web/vite.config.ts (`navigateFallbackDenylist`)
