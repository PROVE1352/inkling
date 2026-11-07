# 0880. Tests run on node:test through tsx, discovered by a repo script

- Status: Accepted
- Date: 2026-11-07

## Context
The repository had ten `*.test.ts` files (server 7, web 2, cli 1; 209 tests) written against
`node:test` and run by hand with `npx tsx --test <file>`, as noted in each file header. There was
no `test` script, so nothing ran them in CI. Two wrinkles:
- `apps/web` has no `tsx` dependency; its test headers say to run them from `apps/server`.
- `apps/server/src/perf.test.ts` has a `[db]` suite that needs a migrated Postgres. It is skipped
  with a suite-level `{ skip: !DATABASE_URL }` and returns early, so its six tests are never
  registered: the summary reports `skipped 0` whether or not they ran.

## Decision
- Keep `node:test` + `tsx`. Every package with tests has `"test": "node ../../scripts/run-tests.mjs"`;
  the root has `pnpm test` (`pnpm -r test`) and `pnpm test:db`.
- `scripts/run-tests.mjs` finds `src/**/*.test.ts` with `fs.readdirSync({ recursive: true })`,
  resolves `tsx` from the package or, failing that, from `apps/server`, and runs
  `node <tsx cli> --test --test-reporter=spec <files>` with the package as cwd. Imports in a test
  file resolve relative to the file, so web tests still use `apps/web/node_modules`.
- The script exits non-zero when a package has no test files.
- `--db` (server `test:db`) exits with an error when `DATABASE_URL` is unset. The guarantee that
  the `[db]` suites ran is "DB mode without a database is an error", not a skip count.
- Test files stay next to the code they test; no `__tests__` or `test/` directories.

## Alternatives considered
- A glob in `package.json` (`tsx --test 'src/**/*.test.ts'`): package scripts run under `sh`,
  where `**` is not recursive without quoting, and quoting relies on Node's own glob expansion,
  which treats an empty match as success. A package whose tests all vanish would stay green.
- Vitest or Jest: a new dependency and a second assertion style for 209 existing tests; the
  lockfile is frozen in this phase.
- Adding `tsx` to `apps/web`: needs a lockfile change; borrowing the server's copy is enough for
  DOM-free tests.
- Detecting skipped `[db]` tests from the reporter output: does not work, see Context.

## Trade-offs
- Web tests depend on `apps/server` being installed. In a workspace install it always is.
- Web tests carry `// @ts-nocheck` (the web tsconfig has no Node types) and are therefore not
  typechecked.
- The `[db]` tests insert rows and do not clean up; they need a disposable database.

## Consequences
- `pnpm test` is the single entry point locally and in CI; `pnpm test:db` adds the database
  suites (CI job `db`, ADR 0881).
- New tests are picked up by naming alone.
