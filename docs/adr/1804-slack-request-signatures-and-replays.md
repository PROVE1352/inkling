# 1804. Slack requests: v0 signature, 5-minute window, replay table

- Status: Accepted
- Date: 2026-11-10

## Context
The command and events endpoints are reachable without a session. Slack signs every request.

## Decision
- The endpoints keep the raw body (their own content-type parsers in an encapsulated scope) and check,
  in order: an integration exists for the URL's workspace, the workspace is live and the secret is
  readable → `X-Slack-Signature` = `v0=` + HMAC-SHA256(secret, `v0:` + timestamp + `:` + body), compared
  in constant time → `|now − X-Slack-Request-Timestamp| ≤ 300 s` → `team_id` equals the stored team →
  the (timestamp, signature) pair was not seen (`slack_request_nonces`, SHA-256 key, INSERT … ON CONFLICT).
  Any failure answers 401 without detail.
- Slack re-signs its Events API retries, so events are also deduplicated by `event_id`.
- `url_verification` is answered with the challenge only after the signature check, except while the
  workspace has no Slack app saved yet: creating the app from the manifest verifies the events URL
  before the operator has a secret to save, so a live workspace without a row echoes the caller's own
  challenge (nothing is revealed or done; an unknown or deleted workspace gets 401).
- Slack's periodic `ssl_check=1` on the command URL is signed but names no team: it is checked against
  the stored team and answered 200.
- Nonces older than 15 minutes and expired link codes are pruned hourly. The table works across
  several server processes.

## Consequences
- A replayed request inside the window is refused even by another instance.

## References
- https://api.slack.com/authentication/verifying-requests-from-slack
- `apps/server/src/slack/signature.ts`, `apps/server/src/slack/inbound.ts`
