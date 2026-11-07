# 1232. Release check lists recent releases to see security fixes

- Status: Accepted (amends docs/adr/0994-*)
- Date: 2026-11-08

## Context
The opt-in release check (docs/adr/0994-*) asked GitHub for `releases/latest` and showed "X.Y.Z is
available". The status summary (docs/adr/1230-*) should also say whether the update fixes a
security problem. A server two releases behind needs to know about a security fix in the release in
between, which `releases/latest` does not show.

## Decision
- Still off unless `UPDATE_CHECK=github`, still at most one request a day (one an hour after a
  failure), still only the repository path and the fixed User-Agent go out.
- The one request is now `GET https://api.github.com/repos/<repo>/releases?per_page=20` (same
  `safeFetch` limits; body cap raised from 256 KiB to 1 MiB for twenty release notes).
- Latest = the highest semver among non-draft, non-prerelease `vX.Y.Z` tags. `securityFix` is true
  when any such release newer than the server has a `## Security` / `### Security` (or `### 보안`)
  heading in its notes — the CHANGELOG convention (Keep a Changelog) copied into the release. It is
  `null` when no newer release has notes to read, and the summary then reports a plain update.
- `GET /api/version/latest` keeps its fields and adds `securityFix`.
- In the status summary a newer release is `warn`, a newer release with security fixes is `error`.

## Alternatives considered
- **`releases/latest` plus the body**: misses a security fix in a skipped release.
- **Fetch `CHANGELOG.md` from raw.githubusercontent.com**: a second host and a larger file; the
  changelog of the default branch may describe unreleased work.
- **GitHub Security Advisories API**: needs advisories to be published separately; the project
  records security changes in the changelog.

## Trade-offs
- A release whose notes are empty or written without the heading reports `null`/`false`; the
  release procedure should paste the CHANGELOG section into the release.
- Twenty releases cover a server far behind; older skipped releases are not looked at.

## References
- apps/server/src/version.ts (`parseReleaseList`, `releaseCheck`), apps/server/src/version.test.ts
