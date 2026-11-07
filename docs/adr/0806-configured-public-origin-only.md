# 0806. External origin from configuration only

- Status: Accepted
- Date: 2026-11-07
- Audit: C-M1

## Decision
Mail links (APP_URL → PUBLIC_URL), the OAuth issuer/endpoints and og:url (PUBLIC_URL → APP_URL) come from configuration (`origin.ts`). The Host header is never used when either is set. With SMTP enabled and neither set the server refuses to boot. Without mail and without both (local dev) the request host is used with a one-time warning. With `PUBLIC_URL=https://notes.example.com` the issuer is exactly `https://notes.example.com` (test: forged Host / X-Forwarded-Host is ignored) — the same value a deployment already advertised before this change, so connected MCP clients keep working. `PUBLIC_URL` starting with `https://` also turns on Secure cookies.
