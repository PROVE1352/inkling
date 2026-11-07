# 1203. inklingctl signs in with an API token; cli-token.sh stays for sessions

- Status: Accepted
- Date: 2026-11-07

## Context
inklingctl stored a session cookie from a password login. Accounts without an Inkling password and
headless machines used `deploy/cli-token.sh`, which inserts a 30-day session row from the server shell
(docs/adr/1060-*). Both are full access. docs/adr/1201-* adds limited, expiring, revocable tokens.

## Decision
- The credential is chosen in this order: `INKLING_TOKEN` in the environment (that run only, nothing is
  written), a token saved by `inklingctl login --token`, the saved session cookie. `apiFetch` sends a
  value starting with `ink_pat_` as `Authorization: Bearer`, anything else as `Cookie` (old configs with
  `"cookie": "inkling_sid=…"` keep working unchanged).
- `inklingctl login --token` reads the token from `INKLING_TOKEN`, a pipe or a hidden prompt, checks it
  with `GET /api/auth/me`, and saves it; a password login removes a saved token and a token login removes
  a saved cookie, so one credential is on disk. `inklingctl status` says which one is in use.
- `deploy/cli-token.sh` is kept unchanged in function. Its header now says that an API token is the usual
  way, and when the script is still the right tool (an operator issuing access from the server shell for
  someone who cannot open the web app). It does not get a token subcommand: tokens are made by their
  owner in a signed-in session, which is the point of 1201's session-only management.

## Alternatives considered
- Replace the cookie path: breaks every existing `~/.inkling.json`.
- Add `cli-token.sh pat`: an operator minting tokens for others from the shell skips the owner's choice of
  scope and range, and the token would not be the owner's own decision.

## Consequences
- Scripts and CI can use a read-only, subtree-limited token that shows its last use.
- A password change stops inklingctl with a token too; it says so (`status`, 401 message).

## References
- apps/cli/src/config.ts (credentialOf), apps/cli/src/http.ts, apps/cli/src/commands/login.ts,
  apps/cli/src/commands/status.ts, apps/cli/README.md, deploy/cli-token.sh
