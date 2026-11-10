# 1926. Unsaved edits in the browser: leave guard, deferred release, indicator

- Status: Accepted
- Date: 2026-11-10

## Context
Nothing in the browser persists a document (ADR 0992). While the connection is down, edits live only
in the tab's Y.Doc, and a reload, a tab close or opening another page in the app dropped them
without a word. The README said "offline edits merge on reconnect", which holds only while the tab
stays open on that page.

## Decision
- An edit is unsaved when a local update (origin other than the provider) happened and the provider's
  unsynced count has not been back to 0 since. The raw count is not used alone: it is reset to 1 on
  every sync, and read-only connections never get it back to 0. Read-only and denied documents never
  count. The logic is a pure module (`lib/unsavedEdits.ts`) with node tests.
- `beforeunload` asks before a reload, tab close or leaving the app while any document holds an
  unsaved edit.
- Leaving a page inside the app does not block: the released provider stays attached (and keeps its
  socket reference) until the server acknowledges its edits, then it is destroyed.
- The connection dot turns amber and says "Not saved yet" when unsaved edits have waited longer than
  1.5 s (normal typing is acknowledged in milliseconds), for any open document, including one just
  left.
- Local persistence (IndexedDB) stays out of scope.

## Alternatives considered
- **Blocking in-app navigation with a dialog**: needs a data router (`useBlocker`) and interrupts the
  user for something the app can finish on its own once the connection is back.

## References
- apps/web/src/lib/unsavedEdits.ts, apps/web/src/lib/collabSocket.ts, apps/web/src/pages/PageView.tsx
