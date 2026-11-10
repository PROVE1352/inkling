# 1828. Testing forms and formulas

- Status: Accepted
- Date: 2026-11-10

## Context
The public form route is the first anonymous write. Its tests must show what a visitor can read and
write, and that the limits hold, not only that a happy path works.

## Decision
- `forms.db.test.ts` checks: the public read has no row title, other property, person, workspace,
  page or view id; a write with extra keys writes only the asked properties and answers exactly
  `{ ok: true }`; honeypot; 413 over 32 KiB; strict body; every closing case answers the same 404;
  the row is in the change feed and catch_up "via public form". The per-IP limit is tested on a small
  app that registers `@fastify/rate-limit` with the options of index.ts (the shared test app has no
  limiter); each other anonymous request uses its own address.
- `formula.test.ts` (pure) covers the language; `collectionQuery/formula.db.test.ts` the read, write,
  query, chart and MCP paths; `apps/web/src/lib/forms.test.ts` the web logic (questions, checks,
  formula cells, sorting and filtering by formulas).

## Alternatives considered
- Add the rate limiter to the shared test app: every other suite would start sharing one budget.

## Consequences
- A change to the rate-limit options in index.ts must be mirrored in the test (noted there).
