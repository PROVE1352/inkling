# 0902. API errors: English messages, translated by code on the client

- Status: Accepted
- Date: 2026-11-07

## Context
Server error messages were Korean strings mixed into route handlers. The API is also used by the
CLI, the MCP server and third-party clients, which need stable, language-neutral errors.

## Decision
- The server keeps `{ error: { code, message } }` (docs/API.md). `code` is the contract;
  `message` is English and meant for logs and English UIs. Codes and HTTP statuses did not change.
- `api.ts` `parseError` stores the raw text on `ApiError.serverMessage` and sets
  `ApiError.message` to `localizeApiError(code, message)`:
  - English UI: the server message (it is the most specific text), else `errors.<CODE>`.
  - Other locales: a translation of the exact English message (`i18n/ko/server-messages-*.ts`,
    used for specific messages that travel with generic codes such as `VALIDATION` or
    `FORBIDDEN`), else `errors.<CODE>` (with `{message}` for codes whose text embeds server
    detail, e.g. `QUERY_SYNTAX`), else the English message.
- Call sites keep showing `err.message`; they get the localized text without changes.

## Alternatives considered
- Localizing on the server from `Accept-Language`: every route would need a locale and a
  translation table on the server, and non-browser clients would get mixed languages.
- New specific codes for every message: cleaner long-term, but changes the API contract and the
  tests that match on codes. New errors should prefer a specific code.

## Trade-offs
An English message that is edited on the server loses its Korean exact-match translation and
falls back to the generic code text until the map is updated.
