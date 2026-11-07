# 0405. Experimental feature flags via EXPERIMENTAL_FEATURES

- Status: Accepted
- Date: 2026-11-07

## Context
Several new features (plugins, vault sync, sheets sync) ship before they are stable. Operators of a
public self-hosted app must opt in explicitly, and the web UI must know what is on.

## Decision
`apps/server/src/features.ts` reads the comma-separated env `EXPERIMENTAL_FEATURES` once at boot
(case-insensitive) and exposes `isExperimentalEnabled(name)` and `enabledExperimentalFeatures()`.
Experimental routes are registered only when their flag is on (disabled features 404 rather than
403, so they are invisible), and `GET /api/auth/mode` returns `experimental: string[]` so the web
app hides the matching UI.

## Alternatives considered
- **One env var per feature**: more settings to document; harder to list what is on.
- **Runtime admin toggles in the DB**: needs migrations and live route (un)registration; overkill
  for features that may still change shape.

## Trade-offs
Changing flags requires a restart.

## How others solve it
Grafana uses `feature_toggles`, GitLab uses feature flags with a similar "off by default, opt-in"
stance for experimental features.

## Consequences
Other experimental features reuse the same helper (vault-sync, sheets-sync already do).

## References
- apps/server/src/features.ts:20
- apps/server/src/index.ts:221 (plugins registration)
- apps/server/src/routes/auth.ts:186 (`experimental` in /auth/mode)
- packages/shared/src/index.ts (`AuthModeDTO.experimental`)
