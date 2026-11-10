# 2061. Agent connection tokens: format, storage and expiry

- Status: Accepted
- Date: 2026-11-10

## Context
An agent connection token (2060) is a static bearer secret pasted into an app's configuration: a dotfile, a
project's `.mcp.json`, a connector dialog. Unlike an OAuth access token it is not rotated, and unlike a personal
API token (1201) it acts as an agent with whatever range and access the person picked.

## Decision
- **Format**: `ink_agt_` + 32 random bytes in base64url (43 characters); regex `ink_agt_[A-Za-z0-9_-]{43}`.
  The prefix differs from `ink_pat_` (1201) and from OAuth's `ink_at_` / `ink_rt_`, so a person, a log scrubber
  or a secret scanner can tell which credential leaked and where it works, and `requireUser` never mistakes it
  for a personal API token (its check is `startsWith('ink_pat_')`).
- **Storage**: the SHA-256 of the whole token in `oauth_grants.access_hash`, like every access token, session
  and API token (1060); the lookup is an equality match on the hash of a 256-bit random value, so no
  constant-time compare is needed and nothing is sealed (APP_SECRET_KEY sealing, 1110/1111, is for values the
  server must read back; it never needs this one). `token_prefix` keeps `ink_agt_` + 4 characters for the list.
  The value is in exactly one answer, `POST /api/agent-tokens` (`201`, `Cache-Control: no-store`).
- **Expiry**: 7, 30, **90 (default)** or 365 days, no "never". Ninety days because:
  - an OAuth connection ends after 60 days without use and its access token every hour; a token that never
    rotates should not outlive that by much while it sits in a file;
  - a quarter covers a term of work on a laptop without monthly re-issuing, which is what pushes people to
    "never" (1201 offers it and its Consequences call it out as a risk);
  - making a new one takes ten seconds on the same screen and the generator fills it in (2063).
  No "never": an agent with write access that someone forgot is the case to bound; a script that needs a
  long-lived credential uses a personal API token for the REST API.
- **At most 20** live agent connection tokens per account (expired ones until the hourly purge do not count),
  checked under a per-account advisory lock so two tabs cannot both pass it.
- **Last use**: `last_used_at` as for every grant (at most once a minute). No IP column: grants never had one;
  the Connected agents list per workspace shows when it was used there.

## Alternatives considered
- **Same expiry choices as API tokens (30/90/365/never)**: "never" rejected above; 7 days added for trying an
  app out.
- **Seal the token so it can be shown again**: the server never needs it, and showing it twice means storing it.
- **Default 30 days**: safer per token, but in practice moves people to 365.

## Consequences
- An expired token answers 401 at once (`access_expires_at`), and the purge removes the grant and its client row
  within the hour.
- Every app using a token has to be updated when it runs out; the list shows the expiry date.
