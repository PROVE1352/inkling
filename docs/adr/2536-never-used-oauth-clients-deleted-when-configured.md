# 2536. Never-used self-registered OAuth clients are deleted when configured

- Status: Accepted
- Date: 2026-11-12

## Context
`POST /oauth/register` (RFC 7591) needs no account. Each call stores a row of up to about 20 KB (ten
redirect URIs of 2000 characters) and nothing deleted them; the per-IP rate limit (20 a minute) keyed
IPv6 by the full address. On a server open to strangers this is unbounded disk use. On a production
server the rows are its MCP connections, so nothing may be deleted there without the operator asking.

## Decision
- Two settings, both off by default (contract §14): `OAUTH_UNUSED_CLIENT_HOURS` (the hourly housekeeping
  deletes never-used registrations older than that) and `OAUTH_UNUSED_CLIENT_MAX` (a registration first
  deletes the oldest never-used one when the count would pass the cap).
- "Never used" = an `ink_c_` registration that no row points at. The list of references is every foreign
  key to `oauth_clients` (codes, grants, agent blocks, agent access records), compared with the database
  catalog by a test; all of them cascade, so a missed one would delete live rows. Agent connection token
  clients (`ink_tc_`) and metadata-document clients (URL ids) are never candidates. The deletion locks
  candidates (`FOR UPDATE SKIP LOCKED`) and re-checks in the same statement.
- The cap never deletes a registration younger than 15 minutes (someone may be on the consent screen).
  When only those are left the registration answers 503 `temporarily_unavailable` with `Retry-After`,
  rather than pushing out a person who is signing in.
- The code exchange consumes the code and inserts the grant in one transaction, so a client always has
  one of the two; the answer is sent after the commit.
- An expired grant counts as use until the hourly OAuth purge removes it (60 days after the last
  refresh); after that, or after the person revoked the connection, the client is never-used again.

## Consequences
- With the demo values (24 hours, 500) never-used rows are bounded by about 500 x 23 KB.
- One address registers at most 20 a minute, 300 in 15 minutes, below the cap of 500: it cannot fill the
  cap with fresh rows, so it never causes a refusal and never pushes out a fresh row. Two or more /64s at
  full rate can keep the cap full of fresh rows; then new registrations are refused until they stop.
- A client that returns with a cached `client_id` after its grants were purged or revoked and the
  registration deleted gets `invalid_client` and must register again.
- `oauth_clients` has no registrant address, so the refusal cannot be per address.
