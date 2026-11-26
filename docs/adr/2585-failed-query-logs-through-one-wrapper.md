# 2585. Failed-query errors reach the log through logSafeError, console included

- Status: Accepted
- Date: 2026-11-27

## Context
drizzle wraps a failed query in a DrizzleQueryError whose message, stack and `params` carry the bound
values: emails, page text, webhook URLs stored without `APP_SECRET_KEY`, tokens (0.25.3 review F-4).
errors.ts `logSafeError` makes such an error log-safe (the SQL with placeholders, the Postgres code and a
message with the values cut out), but only where it is called. The global error handler was one place;
background jobs log their errors with `console.error(…, err)` in about a hundred places.

## Decision
- The global error handler (index.ts) and the MCP route log `logSafeError(err)`; route loggers that pass
  `{ err }` pass `{ err: logSafeError(err) }`.
- At start the server calls `installLogSafeConsole()`: `console.error` and `console.warn` pass every
  argument through `logSafeError`, which returns anything that is not a failed query unchanged.

## Alternatives considered
- **Wrap every call**: about a hundred edits, and the next `console.error(…, err)` would miss it.
- **A pino `err` serializer**: covers only the Fastify logger, not console, and needs pino's own
  serializers, which the server does not depend on directly.

## Consequences
- A failed query's values of four or more characters are not in the log; shorter ones can remain in the
  Postgres message. `detail` and `where` (a unique violation's key) are left out.
- Errors turned into text before logging (`` `… ${err}` ``) are not covered; new code should pass the
  error itself.
