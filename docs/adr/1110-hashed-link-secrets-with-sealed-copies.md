# 1110. Share tokens, invite codes and signup keys stored as SHA-256, with a sealed copy for "copy link"

- Status: Accepted
- Date: 2026-11-07

## Context
After docs/adr/1060-* (sessions) the database still held four lookup secrets in plaintext:
`pages.share_token` (public links), `workspaces.invite_code`, `signup_keys.key` and
`users.signup_key`. A leaked database or backup handed out a live public link per shared page, a
way into every workspace whose invite link is on, unused signup keys, and, worst, the signup key
of every account created with a single-use key, which doubles as that person's password recovery
code (docs/adr/0101-*).

Unlike session cookies, three of these are shown again by the app: the share dialog and the
"Web shares" list copy the public link, the sidebar and members panel copy the invite link, and
the admin screen lists signup keys with click-to-copy. Showing them "once" and reissuing on demand
would break every link people already handed out whenever someone wants to copy it again.

## Decision
- **Lookup column = SHA-256.** Each column keeps its name and type and holds 64 lowercase hex
  characters, like `sessions.token`. Lookups hash the presented value (`secretsAtRest.ts`):
  share tokens exactly (case-sensitive base64url); invite codes and signup keys after
  `trim().toUpperCase()` (they are typed by people; the alphabet is upper case, so this only
  makes input more forgiving). A raw value is never 64 hex characters (22, 10 and 19 characters),
  so a leaked hash presented as a token is hashed again and does not match.
- **"Copy link" keeps working: a sealed copy next to the hash** (option (a) of the brief).
  `pages.share_token_enc`, `workspaces.invite_code_enc` and `signup_keys.key_enc` hold the value
  sealed with `APP_SECRET_KEY` (secretBox.ts, AES-256-GCM, purpose label per kind, the row id or
  key hash as AAD so a copy cannot be moved to another row). Reissuing instead (option (b)) was
  rejected: it changes the URL every time someone copies it, so shared links die without notice.
- **Without `APP_SECRET_KEY` the copy is the raw value** (no key, nothing to seal with). Lookups
  are still by hash. The boot log says how many values stay in plaintext; setting the key later
  seals them at the next boot. Without a key there is no way to have both "no plaintext" and
  "copy again"; existing key-less installs keep exactly today's behaviour (same stance as
  docs/adr/1111-* for URLs).
- **Signup keys keep no copy once used up** (`used_count >= max_uses`, at consumption and in the
  boot pass): a used single-use key is that person's recovery code and is never shown again,
  with or without a key. The admin list shows `••••-••••-••••-ABCD` from `key_hint` (last four
  characters). `users.signup_key` holds the same hash as `signup_keys.key`; the recovery check
  compares hashes. The admin user list returns only a masked hint for it.
- **Admin routes identify keys by id = the hash.** `DELETE /admin/signup-keys/:key` and
  `…/send-invite` accept the id (64 hex) or, from an older client, the key itself (hashed).
  Sending an invite needs the copy; a used-up key answers 409 `KEY_NOT_REVEALABLE`.
- **Unreadable copy** (key changed or removed after sealing): the link or code still works for
  everyone who has it, but cannot be shown. The share dialog then reads "not shared", and
  publishing again issues a replacement link (the old one stops working). Invite links: the
  manager regenerates the code. The "Web shares" list shows the row with an empty token so it
  can still be unpublished.
- **Existing rows: boot pass** `migrateSecretsAtRest()` after the migrations and before listen,
  like `hashLegacySessionTokens()`. Done in Node, not SQL, so it uses exactly the lookup's
  normalisation and can seal. Selection: lookup column `!~ '^[0-9a-f]{64}$'`; copies
  `NOT LIKE 'v1.%'` (when the key is set). Each UPDATE is guarded by the old value; a signup key
  and its accounts change in one transaction. Idempotent; nobody's link or key stops working.
  There is no fallback lookup by raw value after boot (unlike sessions): nothing writes raw
  values any more.

## Consequences
- A leaked database without `APP_SECRET_KEY` yields no public link, invite code, unused signup
  key or recovery code (invite codes: see risk below). With the key leaked too (same `.env`),
  copies can be decrypted: the key belongs outside the database backup.
- Invite codes are 10 characters of a 31-letter alphabet (~50 bits). Their unsalted SHA-256 can
  be brute-forced offline with a GPU in about a day per code; the hash still stops casual reuse
  and a leaked backup being an instant key, and a regenerated code is out of reach. Longer codes
  were left out to keep them typeable.
- Rolling back to v0.4.0 after this boot pass breaks every share link, invite link and signup
  key (the old code compares raw values with hashes). Restore the pre-upgrade backup instead.
- Tests: `secretsAtRest.db.test.ts`.
