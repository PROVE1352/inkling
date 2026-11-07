## What and why

<!-- One or two paragraphs. Link the issue: "Fixes #123". -->

## How it was tested

<!-- Commands you ran and what you checked by hand. -->

- [ ] `pnpm -r typecheck`
- [ ] `pnpm test`
- [ ] `pnpm test:db` against a migrated scratch database (if the change touches the server or SQL)
- [ ] Manual check in the browser (if the change touches the UI or collaboration)

## Checklist

- [ ] New behaviour has tests next to the code (`*.test.ts`, see CONTRIBUTING.md).
- [ ] Schema changes come with a generated migration (`pnpm db:generate`), and the migration runs inside a transaction (no `CONCURRENTLY`, `VACUUM`, `REINDEX`).
- [ ] A design decision with real alternatives has an ADR in `docs/adr/`.
- [ ] No dependency changes, **or** `pnpm-lock.yaml` was regenerated with `pnpm install` and `pnpm check:pins` passes.
- [ ] No secrets, personal data or production URLs in code, fixtures or screenshots.
