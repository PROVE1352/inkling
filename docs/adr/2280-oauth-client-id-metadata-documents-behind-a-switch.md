# 2280. OAuth clients identified by a metadata document, behind OAUTH_CIMD, stored as oauth_clients rows keyed by the URL

- Status: Accepted
- Date: 2026-11-10

## Context
The MCP authorization specification (revision 2025-11-25) puts Client ID Metadata Documents (CIMD) ahead
of dynamic client registration: a client sends an https URL as its `client_id`, and the authorization
server reads the JSON document at that URL for the client's name and redirect URIs
(draft-ietf-oauth-client-id-metadata-document; the MCP text cites -00, this implementation follows -03
of 2 November 2026). claude.ai's custom connector dialog offers it as "use Claude's published ID";
Claude uses it only when the authorization server metadata has both
`client_id_metadata_document_supported: true` and `"none"` in `token_endpoint_auth_methods_supported`,
otherwise it falls back to DCR. Claude's documents are at
`https://claude.ai/oauth/mcp-oauth-client-metadata` (redirect `https://claude.ai/api/mcp/auth_callback`)
and `https://claude.ai/oauth/claude-code-client-metadata` (`http://localhost/callback`,
`http://127.0.0.1/callback`, any port), both `token_endpoint_auth_method: "none"`, about 350 bytes,
`Cache-Control: public, max-age=300`.

Inkling's grants, the Connections list, the "via" name (ADR 0936), per-client agent blocks (ADR 0947),
suggest-only (ADR 2040), ranges (ADR 1200) and revocation all join `oauth_grants.client_id` to an
`oauth_clients` row. Supporting CIMD also means the server starts fetching URLs chosen by whoever opens
a consent link.

## Decision
- Off by default. `OAUTH_CIMD=1` turns it on; `OAUTH_CIMD_ALLOWED_HOSTS` (comma or space separated,
  exact host or `*.suffix`) limits the client_id hosts. Off, the metadata document is byte-for-byte
  what it was, and a URL-shaped `client_id` is refused exactly like an unknown id ("Unknown app") at
  the consent screen, at the code exchange and at refresh — even when a row or grant exists from a
  time it was on. DCR (`/oauth/register`) is unchanged and stays advertised.
- A `client_id` with a URL scheme is a metadata-document client (`isUrlClientId`; registered ids are
  `ink_c_…` / `ink_tc_…` and never contain `:`). Its document is read through `oauthCimd.ts`
  (ADR 2281) when the consent screen asks for the client (`GET /api/oauth/authorize/info`), when the
  person decides (`POST /api/oauth/authorize`) and on refresh; never on the code exchange.
- Lazy registration: on "allow", the client gets an `oauth_clients` row whose `id` is the client_id URL
  (an upsert that refreshes `name` and `redirect_uris` from the document). Looking at the consent screen
  stores nothing. Everything keyed by the client id then works unchanged, and every person who connects
  the same app shares one row (so a workspace can block "Claude" once, not per registration).
  No migration: `oauth_clients.id` is already `text`.
- `client_id` may be up to 2,000 characters when it is a URL (200 otherwise, as before).

## Alternatives considered
- Key grants by the URL without an `oauth_clients` row: every join (grants list, bearer lookup, usage,
  agent tokens) would need a second path; refused.
- A separate `oauth_cimd_clients` table (a new migration): the same rows with a different name; nothing
  it would hold that `oauth_clients` cannot.
- On by default: Inkling has not yet been connected from claude.ai with it (KNOWN-ISSUES AGT-4), and it
  adds outbound requests an operator may not expect.

## Trade-offs
- The row's name follows the latest document: if the app renames itself, existing connections' via
  name changes with the next consent anyone gives. The client_id host never changes.
- Rows are not deleted when their last grant goes (like DCR rows); there is one per app, not per sign-in.

## Consequences
- Files: `apps/server/src/oauthCimd.ts`, `apps/server/src/routes/oauth.ts`, consent screen
  `apps/web/src/pages/OAuthAuthorize.tsx`, Connections `apps/web/src/pages/Connections.tsx`.
- Tests: `oauthCimd.test.ts` (rules, cache, fetch), `oauthCimd.db.test.ts` (flow and refusals).
