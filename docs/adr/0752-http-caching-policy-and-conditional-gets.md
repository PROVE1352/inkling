# 0752. HTTP caching: immutable assets, revalidated shell, private API, version-validated ETags

- Status: Accepted
- Date: 2026-11-07

## Context
`@fastify/static` sent `max-age=0` for everything, so hashed bundles were revalidated on every load, while API responses carried no Cache-Control at all (a shared cache could store an authenticated response). The web app polls large GETs: a 10k-row collection is 4.6 MB, the workspace tree 5.7 MB (15k pages), graph 2.5 MB, due list 1.7 MB.

## Decision
- Static (`httpCache.staticCacheControl`): `assets/*` and `workbox-<hash>.js` → `public, max-age=31536000, immutable`; `index.html`, `sw.js`, `registerSW.js`, `manifest.webmanifest` and the SPA fallback → `no-cache`; other public files (icons) → one day.
- API scopes (`/api`, `/mcp`, `/oauth/*`): default `Cache-Control: private, no-store` unless the route sets its own.
- GET JSON ≥ 1 KB without a route ETag: content-hash weak ETag (sha1, 1.9–4.8 ms per 5.7 MB) with `private, no-cache`, `If-None-Match` → 304. This saves transfer and client parsing, not server work.
- Routes that can validate **before** doing the work set a version ETag (`precheckEtag` / `collectionEtag`): viewer id + `workspaceVersion` (max updated/deleted, live count, collection definition changes) + index epoch where derived indexes are read (graph, due) + server-local date (due) + this collection's views fingerprint. Applied to the page tree, graph, due list and collection GET. The ETag includes a per-process boot id through the index epoch so a restart cannot collide.
- Compression stays in Caddy (`encode gzip zstd`); the app registers no compression plugin, so there is no double compression. Verified through Caddy 2: gzip is applied, the weak ETag passes through unchanged and a conditional request returns 304.

## Measurements (5k pages + 10k-row collection, interleaved full vs conditional request, p50)

| endpoint | full 200 | conditional 304 |
|---|---|---|
| page tree (5.7 MB) | 101 ms | 7.1 ms, 0 B |
| graph (2.5 MB) | 91 ms | 6.4 ms |
| due (1.7 MB) | 84 ms | 7.1 ms |
| collection (4.6 MB) | 80 ms | 7.3 ms |

Compressed sizes through Caddy-equivalent settings: collection 4.6 MB → 418 KB gzip / 373 KB zstd; tree 5.7 MB → 392 KB / 366 KB.

## Not done (needs the web/shared DTO owner)
Collection rows repeat page-meta fields that are constant or always empty for rows: `workspaceId` (530 KB of 5.0 MB), `parentId` (500 KB), `deletedAt`, `kind`, `scope`, `isTemplate`, `aliases`, `fullWidth`, `coverUrl`, `icon`, `createdAt`. A slim `CollectionRowDTO` {id, title, icon, sortOrder, updatedAt, props} would cut the raw payload by ~60%. The tree likewise includes every collection row (10k of 15k nodes). Proposed to P-web; not changed here to keep the shared DTO stable.

## Trade-offs
- A version ETag can only be as precise as `workspaceVersion`: user renames (person rollups) do not bump it, so a rollup showing a person's name can be stale until any page in the workspace changes.
- `workspaceVersion` aggregates over all of a workspace's pages (~445 buffer hits, ~1.5 ms at 15k pages) and scales linearly; a `(workspace_id, updated_at)` index or a trigger-maintained version row is the escape hatch if workspaces grow by 10x.
- `private, no-cache` lets the browser keep large API bodies in its HTTP cache (never in shared caches); content-hash/user-scoped ETags make cross-user reuse in one browser impossible.
