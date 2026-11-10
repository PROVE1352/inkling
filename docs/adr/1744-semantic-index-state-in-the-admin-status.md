# 1744. Semantic index state in the admin status, never the key

- Status: Accepted
- Date: 2026-11-10

## Context
After turning semantic search on, an operator needs to know whether the backfill is progressing and
whether the endpoint works. The API key is a secret like the OIDC client secret (ADR 1160).

## Decision
`GET /api/admin/status` (admins, browser session; ADR 1230) gains an optional `semantic` object, present
only while the feature is on: model, endpoint as scheme + host + path (no credentials, no query string),
vector length, sections indexed / waiting, chunks indexed / waiting / refused, last error (time and a
message that has the key and anything bearer-like removed), last success, backoff end, cache size.
Counts come from one statement, cached for 30 seconds. A failing count query yields
`{ enabled: true, error }` instead of failing the status page. The admin page shows it as one small
panel under the agent usage table. `/api/health` and `/api/health/ready` are unchanged: they never call
the embedding endpoint, so a broken endpoint never makes the server look unready.

## Alternatives considered
- **A status item in a group (warn level on errors).** Would raise the admin banner for an optional
  feature's transient errors; the panel informs without alarming.
- **A separate route.** One more route and policy entry for the same audience.

## Consequences
- The response with the feature off is unchanged (the field is absent).

## References
- docs/adr/1230-*, 1160-*, 1740-*, 1742-*
- `apps/server/src/status/routes.ts`, `apps/web/src/status/AdminStatusCards.tsx`
