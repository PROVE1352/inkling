# 1061. Two-step verification with TOTP (RFC 6238), secrets encrypted under APP_SECRET_KEY

- Status: Accepted
- Date: 2026-11-07

## Context
Before inviting people from outside, a stolen or guessed password should not be enough to sign in.
Authenticator-app codes (TOTP) need no mail or SMS and no new dependency: HOTP is an HMAC and a
dynamic truncation, which `node:crypto` covers.

## Decision
- **Algorithm** (`totp.ts`): HMAC-SHA1, 6 digits, 30-second steps, ±1 step of drift; 160-bit secret
  shown as RFC 4648 base32 and as an `otpauth://totp/Inkling:<email>?…` link (no QR library is in the
  bundle, so key and link are text with copy buttons). Checked against the RFC 4226 and RFC 6238
  test vectors (SHA-1/256/512).
- **Storage** (`schema-twoFactor.ts`): `user_totp` (secret encrypted, `enabled_at` null while setup is
  unconfirmed, `last_used_step`), `user_recovery_codes` (SHA-256 of 10 single-use codes),
  `totp_login_challenges` (SHA-256 of the sign-in challenge, attempts, 5-minute expiry, the password
  hash verified in step one).
- **Encryption** (`secretBox.ts`): AES-256-GCM with a key derived by HKDF-SHA256 from `APP_SECRET_KEY`
  and a purpose label, user id as additional data. No fallback key: unset means 2FA cannot be turned
  on (501 `TWO_FACTOR_UNAVAILABLE`) and the boot log says so; a random key would brick every secret on
  restart, plaintext would defeat the point. Shorter than 32 characters refuses to boot. Losing or
  changing the key: affected users sign in with a recovery code (hashes do not depend on the key).
- **Sign-in**: correct password + 2FA on → `{ totpRequired, challenge }` and no session. `POST
  /auth/login/totp { challenge, code }` accepts an app code or a recovery code. Replays are refused
  atomically (`last_used_step` must grow; older steps are refused too). Five wrong codes void the
  challenge. Wrong codes count against the IP (ban) and a separate account key `totp:<email>` that a
  correct password does not clear, and the password step no longer resets the IP counter while a code
  is still owed. The session is created only while the step-one password hash is still current.
- **Settings**: turning on needs the password, then a code (that code's step is spent); ten recovery
  codes are shown once. Turning off and replacing recovery codes need password + code. Browser
  sessions of local accounts only; delegated accounts use their own service's second factor.
- **Admin**: `DELETE /admin/users/:id/2fa` turns a member's 2FA off (lost phone) and signs them out.
  The user list carries `twoFactor`. Password resets (mail code, admin code, temp password) do not
  touch 2FA.

## Consequences
- Login has two response shapes; old clients see a 200 without `user` for 2FA accounts only.
- An admin can still remove a member's 2FA and then reset the password: admins are trusted.
- Out of scope: a workspace policy that requires 2FA, WebAuthn/passkeys, remembering devices.
- Tests: `authSecurity.test.ts` (vectors, secretBox, [db] two-step verification).
