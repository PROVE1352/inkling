# 2324. A screen that cannot be drawn says so instead of going white

- Status: Accepted
- Date: 2026-11-10

## Context
A browser check of 0.18 twice found a tab that was completely white: no sidebar, no spinner, no text,
`#root` empty. Neither run kept enough to name the trigger, and it did not come back in about twenty
reruns. Injecting faults one at a time into a real Chrome showed which states leave the screen white,
and that these paths are older than 0.18:
- **React unmounts everything on an error no boundary catches** (React 19, `createRoot`). The web app
  had no error boundary at all. A render or effect that throws anywhere (the editor, a block, the
  sidebar) took down the whole tab, sidebar included.
- **A route chunk that fails to load** (`lazyNamed` → `reloadOnceForStaleChunk`, ADR 0704/0706) reloads
  the tab once and otherwise rethrows into the void. If the chunk fails again within 60 s (a server that
  is restarting, a flaky connection, a chunk gone after a deploy without a service worker), the tab
  stays white until the person thinks of reloading. Measured: a 404 on the `PageView` chunk → one
  automatic reload → white for good.
- **The entry script graph fails** (any of the ~26 statically imported chunks: aborted or 404). Nothing
  of React runs, so no boundary can help; `#root` stays as `index.html` left it, empty.

## Decision
- `AppErrorBoundary` (`components/AppErrorBoundary.tsx`) in two places:
  - outermost in `main.tsx`, around the providers: an error that reaches the root shows a full-screen
    notice ("This screen could not be shown", what to do, a Reload button, the error text under
    Details) instead of unmounting;
  - around the page area in `AppLayout` (`<Outlet>`), keyed on the path: a page that cannot be drawn
    keeps the sidebar, and moving to another page draws it again.
  A failed dynamic import gets its own sentence (connection dropped or new version installed). The
  boundary uses `t()` rather than the hook, so it works outside `LocaleRoot`. `reloadOnceForStaleChunk`
  keeps its one automatic reload; its rethrow now lands in a boundary.
- `index.html` starts `#root` with a static notice and reload link (English and Korean), hidden by
  `index.css` and revealed after 12 s by a zero-length CSS animation. React's first render replaces it,
  so a normal start never shows it. No script is involved (the shell runs under `script-src 'self'`).
  If the stylesheet failed too, the notice shows unstyled at once, which still beats a blank page.

## Alternatives considered
- **`createRoot(…, { onUncaughtError })` that writes HTML into the container**: works without a component,
  but it sits outside React and cannot keep the sidebar for a page-level failure. The boundary covers both.
- **Retrying the chunk import a few times before reloading**: helps only the chunk case, and a
  retry loop on a server that keeps answering 404 still ends in the same place. The notice is needed
  either way.
- **An inline `<script>` in `index.html` that checks after a timeout whether React mounted**: needs
  `'unsafe-inline'` or a hash in the CSP; the CSS reveal needs neither.
- **Retrying the render from the notice instead of reloading**: a render that threw usually throws again
  with the same data, and a chunk error needs a reload anyway; Reload is the one action that fixes both.

## Consequences
- Instead of a blank tab, a person sees what happened and a button. The error text is visible under Details,
  which helps bug reports.
- The trigger of the two white tabs in the 0.18 browser check is still unknown (see the investigation
  notes). The check now has steps that fail a route chunk, the entry script and a render on purpose and
  expect the notice.
- `index.html` carries a few lines of fallback text; crawlers of the app shell may index it.
