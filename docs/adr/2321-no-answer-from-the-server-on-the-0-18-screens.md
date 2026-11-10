# 2321. No answer from the server: one "No connection" error, 0.18 screens fail at once, logout drops the push subscription it could not end

- Status: Accepted
- Date: 2026-11-10

## Context
0.18 added offline copies (ADR 2200–2204), web push (ADR 2220–2223), buttons and automations (ADR
2240–2245) and the web clipper (ADR 2260–2263) in parallel. Checked together in a browser with the
connection off:
- a request that gets no answer rejects with the browser's `TypeError: Failed to fetch`; screens that print
  unknown errors showed that text (a button's "stopped at action 1: TypeError: Failed to fetch");
- React Query pauses queries and mutations after the browser's `offline` event (`networkMode: 'online'`):
  saving a clip stayed on "Saving…" until the connection came back, the automations screen and the push
  devices list spun;
- the push section read "not available on this server" because its key request failed;
- logging out offline deleted the device copies (ADR 2203) but could not end the server session, so its
  push subscriptions (bound to that session, ADR 2221) kept delivering to a device the person had left.

## Decision
- `api()` turns a fetch that rejects with a `TypeError` (no HTTP answer; an abort stays an `AbortError`) into
  `OfflineError`, a `TypeError` subclass whose message is the localized "No connection. Try again when you
  are back online." and whose `toString()` is that message. The offline fallbacks keep working
  (`offline.isNetworkError` tests `instanceof TypeError`); screens that show `err.message` or `String(err)`
  show the sentence.
- The queries and mutations of the 0.18 screens (clip save and lookup, automations, push settings) use
  `networkMode: 'always'`: offline they fail at once with that error instead of waiting paused. The rest of
  the app keeps React Query's default (a paused edit is sent when the connection is back).
- Push settings get a device state `offline`.
- `useLogout`: after trying `POST /api/auth/logout`, the device copies are deleted and, only when that
  request did not succeed, this browser's push subscription is unsubscribed — together
  (`Promise.allSettled`, the push part given up after 2 s), so neither blocks the other. The server removes
  the dead subscription's row at its next delivery (404/410). A logout the server saw removes the rows
  through the session foreign key and leaves the browser subscription for the same person's next sign-in
  (`syncPush`), as ADR 2221 decided; the per-browser marker is kept either way.

## Alternatives considered
- **`networkMode: 'always'` for every query and mutation**: every paused edit in the app (comments, tree
  moves, settings) would fail instead of being sent later; a wider change than the 0.18 screens need.
- **Unsubscribe on every logout**: ADR 2221 keeps the browser subscription on purpose so a new sign-in
  re-binds it without asking; only the case the server cannot see needs the local step.
- **Queue the logout for later**: the session cookie is httpOnly and cannot be dropped from script; a queued
  request would end the session only when the device is online again, which is what an expiry or "sign out
  everywhere" does already. Recorded as a known issue instead.

## References
- apps/web/src/api.ts (`OfflineError`, `useLogout`), lib/push.ts (`dropPushSubscriptionHere`, `offline`
  state), pages/Clip.tsx, lib/automationsApi.ts, pushApi.ts, components/PushSettings.tsx
- apps/web/src/apiOffline.test.ts; Chrome check scratchpad w18-browser/int steps 4a–4d
- ADR 2203 (when copies are deleted), 2221 (subscriptions belong to a session)
