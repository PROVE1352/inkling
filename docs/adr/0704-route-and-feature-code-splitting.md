# 0704. Route- and feature-level code splitting

- Status: Accepted
- Date: 2026-11-07

## Context
Everything except exceljs and Shiki grammars was in one 2.38 MB entry chunk (705 KB gzip): the
login page and the app shell downloaded BlockNote, Mantine, React Flow + d3, the graph engine,
database views, Admin, calendars, Shiki's regex engine.

## Decision
- `App.tsx`: every route except the shell (`AppLayout`, `Home`, `Login`) is `React.lazy`; routes
  inside the layout get an in-pane Suspense fallback so the sidebar stays. The editor chunk is
  prefetched on idle after the shell mounts.
- `PageView`: `CollectionView` and `CanvasView` (React Flow + d3) are lazy; `RightPanel`'s
  `LocalGraph` (d3-force engine) loads when its section opens.
- Entry trimming: `requestPropsFocus` moved to `lib/propsFocus.ts` (the shell imported all of
  RightPanel for it); the plugin iframe host loads on first plugin command; the inbox channel
  imports yjs/Hocuspocus on demand.
- Code blocks: `lib/codeBlockOptions.ts` replaces `@blocknote/code-block`'s options. The upstream
  module builds its Shiki highlighter at import time; ours keeps the language table (verbatim copy,
  pinned 0.51.4, equality checked in `lib/perf.test.ts`) and imports the package inside
  `createHighlighter()`, which BlockNote only calls asynchronously.
- A lazy chunk of a previous deploy that 404s/returns HTML triggers one reload (`reloadOnceForStaleChunk`, 0706).

Measured (vite build, gzip of the static import closure from index.html):
| | before | after |
|---|---|---|
| entry (login, shell) | 680 KB | 163 KB |
| doc page (entry + editor) | 680 KB | 517 KB |
| canvas page | 680 KB | 578 KB |
| database page | 680 KB | 540 KB |
| graph view | 680 KB | 179 KB |
| admin | 680 KB | 174 KB |
CSS unchanged (49 KB gzip).

## Alternatives considered
- `manualChunks` vendor splitting only: smaller files, same bytes on the critical path.
- Lazy-loading BlockNote inside PageView: the editor is the page; it would only add a waterfall.
- Dropping zod from the client (≈15 KB gzip in the entry via `@inkling/shared` schemas used by
  Login/Register): needs a shared-package split; left for later.

## Trade-offs
One extra round trip on a cold first visit to a non-shell route (mitigated by idle prefetch and the
service-worker precache). The copied language table must be refreshed on a BlockNote upgrade (the
unit test fails if it drifts).

## How others solve it
Route-based `React.lazy` + prefetch is the standard React/Vite pattern (Remix/Next do it per route).

## Consequences
Old builds' lazy chunks must stay reachable or fail cleanly → 0706.

## References
- apps/web/src/App.tsx, apps/web/src/pages/PageView.tsx:70-74, apps/web/src/components/RightPanel.tsx (LocalGraph)
- apps/web/src/lib/codeBlockOptions.ts, apps/web/src/lib/propsFocus.ts, apps/web/src/plugins/integration.tsx
- apps/web/src/components/AppLayout.tsx (`InboxRealtime`)
