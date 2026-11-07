# 0107. nodemailer for outbound mail, disabled unless SMTP is configured

- Status: Accepted
- Date: 2026-11-07

## Context
Reset codes, temp passwords, invites and verification links can be mailed. The project is otherwise dependency-frozen (a past BlockNote upgrade blanked documents), so any new dependency must not move other versions.

## Decision
- Add `nodemailer@10.1.7` (exact pin) to `apps/server` only. It ships its own type definitions, so `@types/nodemailer` is not added.
- Mail is enabled only when `SMTP_HOST` and `MAIL_FROM` are set; `/auth/mode.mailEnabled` lets the UI hide mail buttons and fall back to copy-to-clipboard.
- Plain text + simple inline-styled HTML; links use `APP_URL` (→ `PUBLIC_URL` → request origin).
- Logs contain only recipient domain and SMTP error code — never code, password, token or `SMTP_PASS`. Failures surface to the admin as 502 `MAIL_FAILED (<code>)`.
- Lockfile edited surgically (+9 lines) because `pnpm add` re-resolved `latest` specifiers in apps/web (vite, vite-plugin-pwa 1→2); validated with `pnpm install --frozen-lockfile`.

## Alternatives considered
- Raw SMTP over `net`/`tls`: no dependency, but STARTTLS, auth mechanisms, MIME/UTF-8 headers are error-prone.
- HTTP mail APIs (SES/Postmark/Resend SDKs): provider lock-in; SMTP works with all of them.

## Trade-offs
One more runtime dependency (zero transitive deps). The SMTP transport is created lazily and reused; no queue/retry — a failed send is reported, not retried.

## References
- apps/server/src/mail.ts:22 (`createTransport`), :166 (`sendMail`)
- apps/server/src/env.ts:102 (`mailEnabled`)
- apps/server/package.json, pnpm-lock.yaml (nodemailer entries)
