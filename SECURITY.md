# Security Policy

## Supported versions

Inkling is a self-hosted, single-instance application maintained by one person. While it is at `0.x`, only the
latest `0.x` release receives security fixes. Older releases are not patched; upgrade to the latest release
([CHANGELOG.md](CHANGELOG.md) notes migrations and backup advice for each one).

| Version | Supported |
|---|---|
| Latest 0.x release | Yes |
| Anything older | No |

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Report them privately through GitHub's private
vulnerability reporting: open the repository's **Security** tab and choose **Report a vulnerability**. This creates a
draft security advisory that only you and the repository maintainers can see.

Include, if you can:

- the affected version or commit,
- the deployment mode (plain compose, Caddy overlay or another reverse proxy),
- steps to reproduce,
- the impact you expect (what an attacker gains, and what access they need first).

Test only against your own instance. Do not run denial-of-service, flooding or social-engineering tests, and do not
access data that is not yours.

## What to expect

This is a one-person project, so there is no guaranteed response time. I try to acknowledge a report within about
a week, but it can take longer. Fix timing depends on severity, on how hard the fix is, and on my availability.
Serious issues that affect a default deployment come first. I will keep you updated in the advisory, tell you when
a fix is released, and credit you in the advisory unless you prefer not to be named.

If a report is out of scope or works as designed, I will say so and explain why.

## Scope

In scope: a self-hosted instance running the code in this repository:

- the server (`apps/server`), including the REST API, the collaboration WebSocket, the MCP endpoint and its OAuth server,
- the web client (`apps/web`) and public share pages,
- the shared package (`packages/shared`) and the `inklingctl` CLI (`apps/cli`),
- the Docker, compose and Caddy configuration and the deploy and backup scripts in this repository, used as documented.

Out of scope:

- mistakes in an operator's own deployment, such as running without HTTPS, an unset or wrong `PUBLIC_URL`, open
  signup, a weak `POSTGRES_PASSWORD`, a too-broad `TRUST_PROXY` or a misconfigured reverse proxy
  (see the checklist in [docs/OPERATIONS.md](docs/OPERATIONS.md));
- issues that require a malicious instance administrator, or a plugin an administrator installed and approved
  (plugins are trusted once approved);
- workspace members reading or editing shared pages of their own workspace: that is the intended trust model
  (see below);
- prompt-injection text that misleads an AI agent without crossing a permission boundary. The data markers and
  injection signals in MCP output are a mitigation, not a boundary;
- third-party services (Notion, Slack, Discord, Google Sheets, MCP clients) and vulnerabilities in dependencies
  that Inkling does not expose;
- problems already listed in [docs/KNOWN-ISSUES.md](docs/KNOWN-ISSUES.md). Please check it before reporting. A new
  way to exploit a listed issue, or a more serious impact than described there, is still welcome.

## Security model (summary)

- The trust boundary is the workspace: every member can read and edit its shared pages. Private pages are visible
  only to their author. There is no read-only role.
- An edit lock limits who can edit a page subtree and separately what agents may do there (edit, comment or read).
  Locks are checked on every write path, including live editing.
- Site administrators manage accounts, signup keys, IP bans and backups. Admin APIs require a browser session; MCP
  tokens are rejected.
- Public share links are unauthenticated, read-only and limited to the shared page or subtree.
- MCP access uses OAuth 2.1 with PKCE (S256), with `read` or `write` scope; tokens are stored hashed and work only on
  `/mcp`. An agent sees only what its user can see, and there is no permanent-delete tool.
- Outbound fetches triggered by users (link previews, sheet sync, webhooks) go through an SSRF-filtering client that
  pins resolved addresses and blocks private and reserved ranges.

## Design notes

The reasoning behind these boundaries is written up as ADRs:

- [0970 Subtree edit lock](docs/adr/0970-subtree-edit-lock.md)
- [0971 Lock evaluation order for people and agents](docs/adr/0971-lock-evaluation-order-people-and-agents.md)
- [0975 Agent instruction pages](docs/adr/0975-agent-instruction-pages.md)
- [0976 Data/instruction boundary in MCP output](docs/adr/0976-data-instruction-boundary-in-mcp-output.md)
- [0977 Injection signals and taint record](docs/adr/0977-injection-signals-and-taint-record.md)
- [0978 Reserved OAuth client names](docs/adr/0978-reserved-oauth-client-names.md)
- [0935 OAuth read/write scopes](docs/adr/0935-oauth-read-write-scopes.md)
- [0936 "via" agent provenance](docs/adr/0936-via-agent-provenance.md)
- [0500 SSRF guard for outbound fetches](docs/adr/0500-safe-fetch-ssrf-guard.md)
- [0754 Revoking live collaboration connections on permission change](docs/adr/0754-revoke-live-collab-connections-on-permission-change.md)
- [0806 Configured public origin only](docs/adr/0806-configured-public-origin-only.md)
- [0811 Authorization leak fixes](docs/adr/0811-authorization-leak-fixes.md)
- [0814 SPA content security policy](docs/adr/0814-spa-content-security-policy.md)
- [0852 Public share HTML sanitizer](docs/adr/0852-public-share-html-sanitizer.md)
- [0401 Admin-only, hash-pinned plugin approval](docs/adr/0401-plugin-install-admin-only-hash-pinned-approval.md)

## Hardening

Before exposing an instance to the internet, follow the deployment checklist in
[docs/OPERATIONS.md](docs/OPERATIONS.md): run behind HTTPS, set `PUBLIC_URL`, require signup keys, change
`POSTGRES_PASSWORD`, keep `TRUST_PROXY` limited to your proxy, and keep an off-site encrypted backup.
