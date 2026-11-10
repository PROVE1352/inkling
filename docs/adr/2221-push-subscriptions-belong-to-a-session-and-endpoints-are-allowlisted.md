# 2221. Push subscriptions belong to the session that made them; endpoints are allowlisted and protected

- Status: Accepted
- Date: 2026-11-10

## Context
A push subscription is a capability URL of a push service (`endpoint`) plus the browser's public key
(`p256dh`) and a 16-byte secret (`auth`). The server POSTs to that URL, which the browser handed to the
page: a user-supplied URL (SSRF). A device that signs out, or an account whose password was changed
("sign out everywhere"), must stop getting the person's notifications on its lock screen.

## Decision
- Table `push_subscriptions` (migration 0054): user, `session_token` → `sessions.token` with
  `ON DELETE CASCADE ON UPDATE CASCADE`, `endpoint_hash` (SHA-256 hex, unique), `endpoint`, `p256dh`,
  `auth`, `vapid_key_id`, device label and user agent, created / last success / last failure, last
  error, consecutive failure count. Logout (`destroySession`), password change and admin "revoke
  sessions" (`setPassword`, `revokeSessions`), session expiry (housekeeping) and account deletion all
  remove the rows through the foreign keys; no auth code changed. The app re-sends the browser's
  subscription on start (`syncPush`) when this account turned push on in this browser before (a
  per-browser `localStorage` marker with the user id), which binds it to the new session after a new
  sign-in; it never asks for permission there. Another account on a shared browser does not inherit
  it: the marker does not match, and registering the same endpoint moves the row to the account that
  registers it last (new row id).
- Protection: `endpoint` and `auth` are stored like webhook URLs (ADR 1111): sealed with
  APP_SECRET_KEY (aad = row id) when it is set, as is otherwise; `p256dh` is a public key and stays
  plain. A row whose secret cannot be opened is removed at its next delivery.
- Endpoint policy (registration and again before every send, `push/config.ts`): what `safeFetch`
  accepts (https, port 443, no credentials, literal and resolved addresses public, the connection
  pinned to the checked address) AND a host allowlist: `fcm.googleapis.com`,
  `android.googleapis.com`, `updates.push.services.mozilla.com`, `*.push.services.mozilla.com`,
  `web.push.apple.com`, `*.push.apple.com`, `*.notify.windows.com`, plus `WEB_PUSH_ALLOWED_HOSTS`.
  No redirects are followed; at most 4 KiB of a response is read. Registration refusals are coarse
  (`PUSH_SERVICE_NOT_ALLOWED` / `PUSH_SUBSCRIPTION_INVALID`), never which address check failed.
  `PUSH_TEST_ALLOW_LOOPBACK=1` (ignored with NODE_ENV=production) lets tests use a loopback fake.
- Routes `/api/push/*` take browser sessions only (a bearer connection that registered an endpoint
  would receive the person's notification text); 20 devices per person, registering one more drops the
  one longest without a delivery. Guests use them like anyone: push only mirrors the person's own
  notification rows, which the engine already limits to workspaces they are a member of (ADR 1000).

## Alternatives considered
- Subscriptions per user, kept across logout: a signed-out phone would keep showing who mentioned
  whom; deleting them in each logout path would miss the next path someone adds.
- Any https endpoint: the server would POST encrypted bodies with a signed JWT to any public host on
  a member's say; the allowlist keeps the outbound targets to the four push networks browsers use.
- Hash only the endpoint (as lookup secrets are): the server must POST to it, so it has to be readable.

## Trade-offs
- After the 30-day session expiry a device is silent until the person opens the app again.
- A self-hosted or new push service needs `WEB_PUSH_ALLOWED_HOSTS`.

## Consequences
- `secretsAtRest.ts` seals and counts `push_subscriptions.endpoint`, `.auth` and
  `push_vapid_keys.private_key` with the other columns (boot pass, admin status).

## Files
- apps/server/src/db/schema-push.ts, push/config.ts, push/routes.ts, secretsAtRest.ts,
  apps/web/src/lib/push.ts, components/PushSync.tsx
