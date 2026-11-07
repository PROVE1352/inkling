# 1171. Public links can have a password; unlock cookies per link

- Status: Accepted
- Date: 2026-11-07

## Context
A public link is a bearer secret: whoever has the URL reads the page. Links get pasted into chats,
mails and tickets where more people see them than intended. A second factor that travels separately
(a password said aloud or sent elsewhere) limits that, and is standard in other tools (Notion paid
plans, Google Drive for business, Dropbox).

## Decision
- **Storage**: `pages.share_password_hash text` (null = no password), argon2 through the existing
  `hashPassword`/`verifyPassword` of auth.ts (`@node-rs/argon2`, default parameters). No new
  dependency. 4–128 characters. Set with `POST /pages/:id/share { password }` (new link) or
  `PATCH /pages/:id/share { password: string | null }` (owners and admins). The hash never leaves the
  server; responses carry `hasPassword` only. Hashing runs before the transaction, so no row lock is
  held during argon2.
- **Visitor flow**: every public route answers 401 `SHARE_PASSWORD_REQUIRED` (fixed message, no
  title) until the visitor unlocks with `POST /api/public/:token/unlock { password }`. Right → 204 and
  a cookie; wrong → 401 `SHARE_PASSWORD_INVALID`. The SPA shows a small password form in the
  public page's frame (theme toggle only, en/ko), then refetches.
- **Unlock cookie** `inkling_share` = `v1.<exp>.<HMAC-SHA256>` over
  `tokenHash | passwordHash | exp`:
  - `Path=/api/public/<token>`: the browser sends it only to that link's API and files (RFC 6265
    path matching: `/api/public/A` does not match `/api/public/AB`); it never reaches `/s/…` or the
    app. `HttpOnly`, `SameSite=Lax`, `Secure` like the session cookie.
  - Lifetime 12 hours, never past the link's expiry. Long enough to read and come back the same day,
    short enough that a borrowed laptop does not keep access.
  - **Bound to the token hash**: a cookie for one link does not open another, even with the same
    password. A re-published link has a new token.
  - **Bound to the stored argon2 string as the password version**: every set gets a new random salt,
    so setting, changing (even to the same text) or removing the password ends every unlock at once.
    A separate version counter column was considered and dropped: the hash already changes on every
    change, and one fewer column cannot drift out of step.
  - Key: HKDF-SHA256 of `APP_SECRET_KEY` with the label `inkling:share-unlock`; without the key, a
    random per-process key (visitors unlock again after a restart; Inkling runs one process).
  - Stateless: no table, no cleanup job. Verification is a constant-time compare.
  - Links without a password never read the cookie.
- **Brute force**, reusing guard.ts (docs/adr/0103-*):
  - Per link: the link's token hash is the guard's "account" key. Past `AUTH_GUARD_ACCOUNT_FAILURES`
    (default 5) wrong answers in the window, the next attempt on that link waits 1 s, 2 s, 4 s … up to
    5 minutes after the last failure, from any IP (checked before argon2). This caps a distributed
    guesser at a few dozen tries per link per window; the cost is that an attacker can make the
    rightful visitor wait up to 5 minutes. The link is never locked outright.
  - Per IP: every wrong password is a guard failure; 10 in 15 minutes ban the address from all
    `/api/public/…` and sign-in routes (escalating). A right password does **not** reset the IP
    counter (unlike sign-in), so unlocking one's own link cannot launder failures on another.
  - Route limit 10/min/IP on the unlock route (sign-in strength), on top of the global limits.
- **Fixed answer time**: every unlock outcome (unknown token, expired, no password, wrong, right)
  runs exactly one argon2 verify (a lazily made dummy hash when there is nothing to compare with)
  and is answered no sooner than 300 ms after the request arrived. argon2 takes ~12 ms here, so the
  floor also hides database time differences between branches. Validation errors (no password in
  the body) answer at once; they depend on nothing secret.
- **Leaks closed**:
  - Unfurl shell (`/s/…`): password links get only `noindex, nofollow` meta and header, whoever
    asks; an unlocked visitor's cookie never reaches `/s/`, so preview bots and the in-app link
    preview (`/api/link-preview`, which fetches `/s/<token>`) see nothing.
  - Search engines: `X-Robots-Tag: noindex, nofollow` on every answer of a gated link (401, 410 and
    unlocked 200s alike).
  - Files: `Cache-Control: private, max-age=300` (no shared caches) for password links.
  - iCal feeds and webhooks never carry share tokens or public page content (checked: `ical.ts`
    builds from the owner's own items; webhooks link to `/w/…`).
  - Logs: request URLs were already masked (C-L8, `maskUrlSecrets`); request bodies are not logged
    by the Fastify serializer; audit rows hold `{password: true}` at most.
- **Audit**: `share.password_set`, `share.password_changed`, `share.password_removed` (no
  before/after values), and `share.published` with `after: {expiresAt, password: true}` when a link is
  made with one.
- Stopping sharing and bulk removal clear the hash with the token.

## Alternatives considered
- **Server-side unlock table** (random id in the cookie): revocable one by one, but needs writes on
  every unlock and a cleanup job; the HMAC cookie already dies with a password change, which is the
  revocation people ask for.
- **Password in the URL fragment or query**: ends up in browser history, referrers and chat
  previews; defeats the separate channel.
- **Bcrypt/scrypt or a fast hash**: argon2 is already in the server; a fast hash makes an offline
  guess of a leaked hash cheap.
- **A separate `share_password_version` column**: see above, the salted hash serves as the version.

## Consequences
- The CSRF origin check (docs/adr/1062-*) covers the unlock POST: a visitor at an address other than
  `PUBLIC_URL`/`APP_URL` gets 403 when submitting the password (the same limit as other writes).
- 4-character passwords are allowed; the throttling above is what protects short ones. The settings
  can require a password but not a minimum strength.
- Tests: `shareLinks.db.test.ts` (all four JSON routes and the shell, cookie path/attributes/
  lifetime, cross-link refusal, tampering, password change and removal, timing floor, per-link
  backoff, IP ban, audit without secrets), `shareAccess.test.ts`.
