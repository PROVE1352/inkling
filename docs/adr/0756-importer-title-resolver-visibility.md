# 0756. Wiki-link title resolution respects page visibility

- Status: Accepted
- Date: 2026-11-07

## Context
`buildTitleResolver` (folder/zip/markdown import, vault sync PUT/POST, `POST /pages/:id/content`) loaded every live page title of the workspace without `visibleTo`. Importing a note containing `[[Someone's private page]]` resolved it to `/w/<ws>/p/<id>`, revealing that the page exists and its id.

## Decision
The resolver takes the acting user's id and filters with `visibleTo(userId)`; all five callers pass it. The resolver is built once per import run (once per request for sync/content). Test: `perf.test.ts` "importer resolver ignores other users' private pages".

## Alternatives considered
A cross-request title cache for vault-sync bursts was rejected: a sync creates pages and then links to them in the next request, so a cache needs invalidation on every create/rename/alias/scope/trash change; loading 5k titles is ~10 ms.
