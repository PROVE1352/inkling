# 2528. Restricted mode: where the three pieces meet

- Status: Accepted
- Date: 2026-11-12

## Context
Limits, accounts and terms (ADR 2505–2521) were built in parallel and each tested alone. What crosses them
was left for the merge: owner checks inside transfer and restore, deleting an account from the consent
screen, the compose file, empty settings, hints for agents, and the storage boundary.

## Decision
- **Owned workspaces**: `transferOwnership` and `restoreWorkspace` call `assertUserRoom` in their own
  transaction after the member lock (members → user lock order), so one request holds one connection and
  concurrent takeovers pass only as many as there is room for. A target who already owns the workspace is
  not checked. The handover on account deletion keeps ignoring the limit.
- **Consent screen**: "Delete account" opens piece B's dialog (`DeleteAccountModal`) without its export
  buttons: export is not on the consent gate's exception list, and the dialog says so.
- **Compose**: `compose.yaml` passes all seventeen 0.22 settings as `${VAR:-}`; `.env.example` has a
  commented example of each. An empty value reads as unset for every one of them (tested in a child process
  too). `LEGAL_DIR` needs a mount, shown by the demo overlay.
- **Agents**: MCP errors for `LIMIT_*`, `FEATURE_DISABLED` and `CONSENT_REQUIRED` carry their own next step
  (numbers, what to delete, turned off on this server, agree on the web) instead of the status hints ("not a
  member" for a 403, "not found" for a 404). `upload_file` states and checks min(`AGENT_UPLOAD_MAX_MB`,
  `LIMIT_FILE_MB`).
- **Storage**: full means the limit is reached (`>=`) in the recount, the collab checks, the room check and the
  web. A recount that finds the workspace back under its limit closes its read-only live connections with an
  ordinary close, so they reconnect and can edit. The usage route recounts at most once a minute per
  workspace with or without a limit (it ran the full count on every visit to the settings without one).
- **Features turned off in the app**: no `/reset` form, no public-links tab, no form-link panel, no Notion
  import entry, no webhook action; a link block falls back to its card when embeds are off, and with embeds
  and link previews both off the slash menu has no entry and a pasted address stays a link.

## Consequences
- `restrictedMode/*.test.ts` hold the cross-piece tests, the whole demo preset end to end among them.
