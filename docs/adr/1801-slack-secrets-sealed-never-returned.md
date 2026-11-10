# 1801. Slack token and signing secret: sealed at rest, never returned or logged

- Status: Accepted
- Date: 2026-11-10

## Context
The bot token can post and read user profiles; the signing secret proves requests come from Slack.
Inkling already stores outside secrets "protected" (ADR 1111): sealed with `APP_SECRET_KEY` when set,
plaintext otherwise, counted by the boot pass and the admin status.

## Decision
- `bot_token` and `signing_secret` are stored through `protectSecret` with purposes `slack-bot-token`
  and `slack-signing-secret`, the workspace id as AAD, and both columns are in `SEALED_COLUMNS`, so the
  boot pass seals rows written before the key was set and the admin status counts them.
- The API never returns either value. The DTO has `botTokenHint` (`xoxb-…` + last four), `signingSecretSet`,
  `sealed` and `secretsReadable` (false when the key is missing or changed: the admin must enter them again).
  A save without the fields keeps the stored values.
- Logs and errors carry Slack's error code only (`invalid_auth`, `not_in_channel`, `HTTP 503`): the
  token travels in the `Authorization` header and never in a URL, body echo or message. The audit log
  records `botTokenChanged` / `signingSecretChanged`, never values.
- An unreadable token at delivery pauses the integration (`blocked_reason = secret_unreadable`) instead
  of retrying.

## Consequences
- Without `APP_SECRET_KEY` the secrets sit in the database as typed, as webhook URLs do; the settings
  page warns.
- The DB test captures every log line and response and asserts neither value appears.

## References
- docs/adr/1061-*, 1110-*, 1111-*, 1230-*
- `apps/server/src/slack/config.ts`, `apps/server/src/secretsAtRest.ts`
