# 0901. Locale resolution order and where the choice is stored

- Status: Accepted
- Date: 2026-11-07

## Decision
The web client resolves the UI language as:
1. the user's explicit choice (Settings → Language, or the picker on the sign-in pages), kept in
   `localStorage['inkling-locale']` and, when signed in, in `users.locale`;
2. the server's `DEFAULT_LOCALE`, sent as `defaultLocale` by `GET /api/auth/mode` only when the
   operator set it (cached in `localStorage['inkling-locale-default']` for the first paint);
3. `navigator.languages`;
4. `en`.

`users.locale` is a nullable text column (`null` = automatic). `PATCH /api/auth/me/locale`
saves it; `GET /api/auth/me` returns it, and the client adopts a non-null value on sign-in, so a
choice made on one device follows the account. Both fields are extension fields: the shared DTOs
(`AuthModeDTO`, `UserDTO`) are not changed; `api.ts` types them locally (`MeDTO`,
`AuthModeExtDTO`).

The server reads `DEFAULT_LOCALE` (`en` | `ko`, default `en`) for its own output (ADR 0903).
`/auth/mode` reports it only when it is set explicitly, so an unconfigured server lets the
browser language decide instead of forcing English.

## Trade-offs
Before sign-in the choice lives only in the browser. The first paint uses cached values; if
`/auth/mode` returns a different default, the app remounts once.
