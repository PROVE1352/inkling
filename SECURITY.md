# Security Policy

## Supported versions

Inkling is a self-hosted, single-instance application. Only the latest release on the `main` branch receives security fixes.

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Report them privately through GitHub Security Advisories: open the repository's **Security** tab and choose **Report a vulnerability**.

Include the affected version or commit, the deployment mode (plain compose, Caddy overlay or another proxy), steps to reproduce, and the impact.

We aim to acknowledge reports within 7 days and to ship a fix or mitigation within 30 days for High and Critical issues. Reporters are credited unless they prefer otherwise.

Test only against your own instance. Do not run denial-of-service, flooding or social-engineering tests, and do not access data that is not yours.

Before reporting, check [docs/KNOWN-ISSUES.md](docs/KNOWN-ISSUES.md): it lists known issues that are accepted for now.

## Scope

In scope: the server (`apps/server`), the web client (`apps/web`), the shared package, and the Docker / compose / Caddy configuration and deploy scripts in this repository.

Out of scope: issues that require a malicious instance administrator or an operator-installed plugin (plugins are trusted once an admin approves them), third-party services (Notion, Slack, Discord, Google Sheets), and an operator's own reverse proxy configuration.

## Security model (summary)

- The trust boundary is the workspace: every member can read and edit its shared pages. Private pages are visible only to their author. There is no read-only role.
- Site administrators manage accounts, signup keys, IP bans and backups. Admin APIs require a browser session; MCP tokens are rejected.
- Public share links are unauthenticated, read-only and limited to the shared page or subtree.
- MCP access uses OAuth 2.1 with PKCE (S256); tokens are stored hashed.
- Outbound fetches triggered by users (link previews, sheet sync, webhooks) go through an SSRF-filtering client that pins resolved addresses and blocks private and reserved ranges.

## Hardening

Before exposing an instance to the internet, follow the deployment checklist in [docs/OPERATIONS.md](docs/OPERATIONS.md): run behind HTTPS, set `PUBLIC_URL`, require signup keys, change `POSTGRES_PASSWORD`, keep `TRUST_PROXY` limited to your proxy, and keep an off-site encrypted backup.
