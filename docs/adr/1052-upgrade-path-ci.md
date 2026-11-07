# 1052. Upgrade-path CI: every earlier release's image fills a database, the new image migrates it

- Status: Accepted
- Date: 2026-11-07

## Context
Migrations grew from 0027 to 0033 between v0.1.0 and v0.3.1 within one day, and users jump several
releases at once. CI's `db` job (ADR 0881) applies all migrations to an empty database; it never
starts from an older schema with data in it, and never boots the server's own migrator
(`runMigrations` in `apps/server/src/db/index.ts`, one transaction at boot).

## Decision
`.github/workflows/upgrade.yml` (push to `main`, pull requests touching the server, shared package,
Dockerfile, lockfile or the test itself, manual runs, and called by release-image.yml before
publishing) runs one leg per earlier release: v0.1.0 (commit `9dc9a9b`, no tag exists), v0.2.0,
v0.3.0, v0.3.1. Each leg:
1. Builds the old release's image from its tree and this commit's image (Buildx, GitHub Actions
   cache; one cache scope per release, which never changes).
2. Runs `scripts/upgrade-test/run.sh OLD NEW`: a `postgres:16` container on a private network, the
   old image with `SIGNUP_REQUIRE_KEY=0`, and `scripts/upgrade-test/seed-verify.mjs seed`, which
   writes through the old API: the first account (admin), a second workspace, a document with
   Markdown body (headings, list, tag, wikilink) and a nested child, a private page, a folder, a
   comment thread with a reply, and a collection with two extra fields and three rows with values.
   It reads all of it back through the old API as a fingerprint.
3. Stops the old app with SIGTERM (it flushes documents), checks both documents are in `page_docs`,
   and records the row count of every table.
4. Boots the new image on the same database and `/data` volume and requires: `/api/health` and
   `/api/health/ready`, `drizzle.__drizzle_migrations` holding exactly as many entries as the image's
   `drizzle/*.sql`, the same row count in every pre-existing table, the old session cookie still
   valid, password login, and `seed-verify.mjs verify` returning the same workspaces, pages,
   comments, collection fields, views and row values. Every seeded line must survive in the Markdown
   export; a changed serialisation of the same lines is only a warning.
5. Stops the new app cleanly.

## Alternatives considered
- **Node + a GitHub `services: postgres`, like the `db` job**: faster, but tests the source tree, not
  the image users run (`DRIZZLE_DIR`, `NODE_ENV=production`, the Alpine runtime), and cannot be
  reproduced locally without installing each old release's dependencies. The script owns its
  Postgres container instead, so CI and a laptop run the same steps.
- **Seeding with SQL**: version-specific and skips the code that writes documents (Yjs state,
  derived indexes); the HTTP API is what old releases actually used to write the data.
- **Pulling old images from GHCR**: faster once they exist, but v0.1.0 has no image and the test
  would depend on the registry; may replace the old-image build later.
- **Exact equality of the Markdown export**: a legitimate serializer change would fail the upgrade
  test without any data loss.

## Trade-offs
- About 5–10 minutes per leg, in parallel; old-release builds come from cache after the first run.
- The fingerprint covers representative data, not every table's semantics; row counts catch lost or
  duplicated rows anywhere, not changed values outside the fingerprint.
- Attachments and plugin data are not seeded (they live on the `/data` volume, which is reused as is).

## Consequences
- A migration that fails on real data, a boot step that rewrites old rows, or an API change that
  loses old data fails CI and blocks the release image (ADR 1050).
- A new release is added to the matrix when it is tagged; v0.1.0 can switch to its tag name once
  tagged. Reproduce locally: CONTRIBUTING.md "Running CI locally".
