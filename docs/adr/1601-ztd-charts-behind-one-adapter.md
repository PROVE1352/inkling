# 1601. ztd-charts for drawing, behind one adapter, loaded on first sight

- Status: Accepted
- Date: 2026-11-10

## Context
Drawing needs SVG charts with keyboard and screen-reader support, reduced motion, light/dark and
Korean number formats. Writing them is large; the dependency policy (ADR 0882) asks for a reason and
a pinned version. Candidate: `ztd-charts` 0.5.0 (MIT, 36 charts in SVG, no runtime dependencies,
peer react ≥ 18, JSON spec with a public schema, `ztd-charts/spec` without React).

## Supply-chain check (2026-11-09/10)
- npm tarball `ztd-charts-0.5.0.tgz`: sha1 `143c0800ee7b01b3d6181bc9d38a19414a5e84a4`, integrity
  `sha512-ttIsC3pM…f+U/1Q==` match the registry and the lockfile; 57 files, 1.0 MB packed, 4.0 MB
  unpacked (`dist/`, `schema/`, README, LICENSE, package.json).
- No `dependencies`, no `install`/`preinstall`/`postinstall`/`prepare` script, no `bin`.
- Source: github.com/Junhan2/ztd-charts, commit b905474 "chore(release): 0.5.0" (2026-11-09 04:01
  UTC, npm publish 04:24 UTC). `package.json`, README, LICENSE (MIT, "Copyright (c) 2026 Junhan2")
  and all 37 schema files are byte-identical to that commit; every named function in `dist/` exists
  in `src/` (one bundler rename). No build was run from the clone.
- Network and code loading in `dist/`: one `fetch` (`useChartData` for a spec's `{url}` data); the
  HTML export of `ztd-charts/server` writes esm.sh / jsdelivr URLs. No `eval`, `new Function`,
  `child_process` or `process.env`.
- Risks recorded: the repository is five days old, one maintainer, no git tags or provenance;
  0.5.0 was younger than pnpm's minimum release age, so pnpm added
  `minimumReleaseAgeExclude: [ztd-charts@0.5.0]` to `pnpm-workspace.yaml` (removable after
  2026-11-10 04:24 UTC).

## Decision
- `apps/web` depends on `"ztd-charts": "0.5.0"` (exact). `apps/server` does not: the server validates
  our own format with zod (ADR 1600) and exports/public pages show tables (ADR 1605). Server-side
  SVG or PNG would need `react-dom/server` (and a rasterizer for PNG) on the server; deferred.
- One adapter, `apps/web/src/components/charts/adapter.ts`, turns our settings + an aggregate into a
  library spec (`toChartSpec`). Data is always inline rows built from the aggregate; the library's
  `data.url` / CSV paths are never used, so a chart cannot make the browser fetch anything. If the
  library's spec changes, only the adapter changes; a test checks every kind with the library's own
  `validateSpec`.
- `ChartRender.tsx` is a separate chunk (React.lazy), loaded the first time a chart is on screen
  (IntersectionObserver). It imports the 15 named components of the kinds we offer and maps spec →
  props as the library's `<Chart>` does (`resolveDef`, `encodingToProps`); `<Chart>` itself imports
  all 36 charts (98.5 KB gzip against 48.1 KB, PERFORMANCE.md).
- Theme follows the app (`ThemeProvider` light/dark), locale `ko-KR` / `en-US` from the app language.

## Alternatives considered
- Hand-written SVG bars/pies: less code to audit, but keyboard, screen-reader table, motion and
  locale formats would be ours to build and test.
- A larger established library (e.g. a canvas or D3-based one): more dependencies, more bytes, no
  JSON spec for agents.
- `ztd-charts` on the server for spec validation: our zod schema already decides what is stored.

## Consequences
- A new kind needs its component added to `ChartRender` and a line in the adapter.
- Library upgrades: run the adapter test, compare the chunk size.
