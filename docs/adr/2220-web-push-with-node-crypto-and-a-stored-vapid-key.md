# 2220. Web push with node:crypto, and a VAPID key made on first use

- Status: Accepted
- Date: 2026-11-10

## Context
Notifications reach people only in the open app (the bell), by mail when SMTP is set up, and through
Slack. Inkling is a PWA; with the app closed nothing arrives. Web push needs two pieces of
cryptography on the server: RFC 8291 message encryption (the `aes128gcm` content coding of RFC 8188,
an ephemeral P-256 key per message, the browser's `p256dh` key and `auth` secret) and RFC 8292 VAPID
(an ES256 JWT that identifies the server to the push service). Self-hosters should not have to make
a key pair before push works.

## Decision
- Both are implemented with `node:crypto` only (`apps/server/src/push/webPushCrypto.ts`, about 200
  lines): `createECDH('prime256v1')`, `hkdfSync('sha256', …)`, AES-128-GCM, and
  `sign('sha256', …, { dsaEncoding: 'ieee-p1363' })` for the JOSE r‖s signature. One record per message
  (record size 4096, delimiter 0x02, no padding); the encrypted body is at most 4096 bytes
  (`MAX_PLAINTEXT_BYTES` = 3993). Unit tests reproduce the RFC 8291 appendix A example byte for byte,
  decrypt it with the user agent key, and verify the JWT with the public key (`webPushCrypto.test.ts`).
- Key pair: `VAPID_PUBLIC_KEY` + `VAPID_PRIVATE_KEY` (the raw base64url forms `web-push
  generate-vapid-keys` prints) when set, checked to be a matching P-256 pair. Without them the server
  makes a pair on first use and keeps it in `push_vapid_keys` (one row, `INSERT … ON CONFLICT DO
  NOTHING` then re-read, so two processes agree). Its private key is stored like the other secrets that
  must be read again (ADR 1111): sealed with `APP_SECRET_KEY` when it is set, as is otherwise, and
  sealed by the boot pass once the key is set (`SEALED_COLUMNS`).
- Half a pair, a pair that does not match, or a stored key that cannot be opened (APP_SECRET_KEY
  missing or changed) make push unavailable (`/api/push/key` says so, the admin status warns); the
  server never replaces a key by itself, because a new key silently voids every subscription.
- `VAPID_SUBJECT` (`mailto:` or `https:`); default PUBLIC_URL when it is https, else
  `mailto:webpush@inkling.invalid`. `aud` is the origin of the endpoint, `exp` 12 h (limit 24 h).
- Key change: every subscription records the fingerprint of the key it was made with
  (`vapid_key_id`, 16 hex of SHA-256 of the public key). A delivery to a row of another key removes the
  row; the app compares `subscription.options.applicationServerKey` with the server key on start and
  subscribes again (ADR 2221). `WEB_PUSH=off` switches the whole feature off.

## Alternatives considered
- The `web-push` npm package: does the same with `http_ece` and `asn1.js`/`jws`; three packages for
  ~200 lines the platform already covers (ADR 0882), and its own HTTP client would bypass `safeFetch`.
- Require VAPID env variables: one more step before a feature that should simply work; the
  generated key has the same protection as webhook URLs and TOTP secrets.
- Regenerate an unreadable stored key: a typo in APP_SECRET_KEY would void every device; reporting it
  keeps the decision with the operator (delete the row to start over).

## Trade-offs
- Crypto code of our own: bounded by the RFC vector test, the JWT verification test, and a real
  round trip through Firebase Cloud Messaging to Chrome in the browser check.
- Without APP_SECRET_KEY the generated private key sits in the database as is (as webhook URLs do).

## Consequences
- No new dependency. Operators may set the env pair to keep one key across database restores.

## Files
- apps/server/src/push/webPushCrypto.ts, push/keys.ts, push/config.ts, db/schema-push.ts
