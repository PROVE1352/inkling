# 0812. Operational defaults and small hardening

- Status: Accepted
- Date: 2026-11-07
- Audit: C-M9, C-M10, B-M2, B-M5, B-M6, B-M7, C-L1, C-L3, C-L8, C-L10

- `COOKIE_SECURE` passes through compose (default 0); `PUBLIC_URL=https://…` forces Secure cookies.
- `NODE_ENV=production` requires a signup key unless `SIGNUP_REQUIRE_KEY=0`; with no accounts the boot log points to `deploy/signup-key.sh`.
- `requestTimeout` 300 s (25 MB uploads, 50 MB folder imports).
- `GET /api/health/ready` (DB probe, 2 s timeout, 5 s cache); `/api/health` stays liveness.
- All server env vars pass through compose as `${X:-}` (except PORT/DATA_DIR/DRIZZLE_DIR/WEB_DIST, which break when empty); boot log prints experimental features, signup-key mode, mail, origin, secure cookies.
- Backup prune runs before the free-space check (newest set kept); the sidecar's `pg_restore --list` SIGPIPE bug (dumps > 64 KB always failed verification under `pipefail`) is fixed with `pg_toc`.
- Guard matches `req.routeOptions.url` (route pattern) instead of the raw URL (`/api/auth/log%69n` bypass).
- Collab client IP walks X-Forwarded-For through TRUST_PROXY hops like Fastify's trustProxy.
- Request logs mask `/ical/<token>`, `/api/public/<token>`, `/s/<token>` and secret query parameters.
- Multipart: fields 20, fieldSize 100 KB, parts 40 (folder import: files + 21), headerPairs 200.
- Missing `/assets/*` → 404; revoked collab connections get `PermissionDenied('permission-changed')` before close.
