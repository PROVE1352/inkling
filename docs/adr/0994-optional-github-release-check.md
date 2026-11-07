# 0994. Optional GitHub release check for admins (off by default)

- Status: Accepted
- Date: 2026-11-07

## Context
Self-hosters learn about new Inkling releases only by watching the repository. A notice in the
admin screen helps, but a self-hosted app must not phone home by default or leak anything about the
instance.

## Decision
- Off unless `UPDATE_CHECK=github`. The repository is `UPDATE_CHECK_REPO` (default
  `PROVE1352/inkling`, validated as `owner/name`).
- `GET /api/version/latest` (admins only, browser session) calls
  `https://api.github.com/repos/<repo>/releases/latest` through `safeFetch` (host allowlist
  `api.github.com`, no redirects, 5 s timeout, 256 KiB, JSON only). Lazily on the first admin
  request, cached for 24 h; a failure is cached for 1 h and resolves to "nothing to show".
- Only the repository path goes out. The User-Agent is the fixed string `inkling-update-check`; no
  instance URL, version, user or email is sent.
- Drafts and pre-releases are ignored; `vX.Y.Z` tags are compared with the server version
  (`APP_VERSION` or package version) by semver. The admin screen shows
  "Inkling X.Y.Z is available (this server runs A.B.C)" with a link to the release (github.com URLs
  only).

## Alternatives considered
- Check on boot / on a timer: makes outbound requests even when no admin looks.
- A project-run update server: needs infrastructure and receives instance IPs.
- Docker image tags: depends on how the operator deploys.

## Trade-offs
- GitHub's unauthenticated rate limit (60/h per IP) is far above one request a day.
- A fork that tags differently gets no notice (non-semver tags are ignored).

## How others solve it
- Gitea has a daily update checker (`[cron.update_checker]`) that compares with the latest release
  and shows it to admins; Nextcloud's update check is opt-out and sends the running version to its
  updater server. Inkling takes the opt-in, send-nothing end of that range.

## Consequences
- No outbound traffic by default; with the switch on, at most one request a day (one an hour on
  failures).

## References
- `apps/server/src/version.ts`, `apps/server/src/safeFetch.ts`, `apps/web/src/components/UpdateBanner.tsx` (`ReleaseNotice`)
