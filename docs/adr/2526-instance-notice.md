# 2526. Operator notice on every screen (INSTANCE_NOTICE)

- Status: Accepted
- Date: 2026-11-12

## Context
A demo server sends no mail and holds no contact details, yet its terms promise notices of changes,
outages and data breaches "in the app and on the sign-in screen". There was no way to post one.

## Decision
- `INSTANCE_NOTICE`: plain text, at most 500 characters, line breaks allowed (CRLF read as LF), any other
  control character refuses to boot; outer spaces trimmed. Sent as `/auth/mode` `instanceNotice` only when
  set. Changing it is a restart, like every setting.
- Shown where the instance label is (ADR 2520): under the title of the sign-in, sign-up, consent and
  setup-waiting screens, and as a strip above every app screen on every width (not hidden with the sidebar).
  It cannot be closed. The strip keeps a few lines and scrolls inside itself; long words wrap anywhere, so a
  390 px screen never scrolls sideways.
- Text only: React escapes it, `white-space: pre-line` keeps the breaks, and no link is made from an address
  in it (an operator setting must not become a phishing link on a page people trust).

## Consequences
- One notice for everyone; there is no per-person message. The terms' "we tell you the reason in the app"
  for a restriction has no per-account means yet.
