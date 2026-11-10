# 2282. Metadata-document clients on the consent screen: the client_id host next to the unverified name, a localhost warning, no logo, `iss` in the response

- Status: Accepted
- Date: 2026-11-10

## Context
A metadata document's `client_name` and `logo_uri` are the client's own claim (draft-03 §10.10): anyone
can publish `{"client_name": "Claude"}`. The document cannot stop localhost impersonation either: an
attacker can use Claude Code's client_id with a loopback redirect on a port of its own, and the person
sees Claude Code's real document (MCP authorization 2025-11-25, "Localhost Redirect URI Risks").
The MCP text: authorization servers MUST clearly display the redirect URI hostname and SHOULD warn for
localhost redirects; draft-03 §10.6 SHOULD display the client_id hostname; §10.9 a logo must be
prefetched, validated and served by the server if shown at all. Draft-03 §7 makes `iss` (RFC 9207)
mandatory in the authorization response.

## Decision
- `GET /api/oauth/authorize/info` adds `metadataDocument: { host, loopbackRedirect }` for these clients
  (additive). The consent screen shows a box under the name: "Identified by <host>" and that the name
  comes from a document the app publishes there and is not checked. The existing line still shows the
  redirect host.
- When the requested `redirect_uri` is loopback http, an amber warning says that any program on this
  computer can claim to be <host>, and to allow only a connection the person just started.
- No logo is fetched or shown (as for DCR clients).
- The document's name goes through the same reserved-name rule as `/oauth/register` (ADR 0978): refused
  on the info route and on the decision; the member-name notice (ADR 1007) applies unchanged.
- `GET /api/oauth/grants` adds `clientHost` for these clients; the Connections list shows it after the
  name.
- `iss` = the issuer is added to every authorization response for these clients (allow, deny, errors).
  DCR responses do not change and the metadata does not advertise
  `authorization_response_iss_parameter_supported`: advertising it would oblige every client to require
  `iss` on every response, a change for DCR clients this release does not make.

## Alternatives considered
- Show only the host (§10.10 allows it): "claude.ai" alone is less recognisable than "Claude" with
  "from claude.ai"; both are shown, the host as the identifier.
- Restrict `redirect_uris` to the client_id's origin (§10.2): would refuse Claude Code (loopback) and
  any desktop client; the warning is shown instead.
- `iss` for all clients and advertised: deferred so that DCR stays unchanged in 0.18.

## Consequences
- i18n: `apps/web/src/i18n/{en,ko}/oauth-cimd.ts`.
- The localhost warning appears for Claude Code, Cursor and VS Code style clients each time they connect.
