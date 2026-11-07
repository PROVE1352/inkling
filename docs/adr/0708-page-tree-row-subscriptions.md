# 0708. Sidebar tree: memoized rows with per-row subscriptions

- Status: Accepted
- Date: 2026-11-07

## Context
Every visible tree row re-rendered on each navigation. With 2 335 expanded rows (7 imported
folders) a navigation cost ~430 ms of long tasks; row renders were counted at 7 009 per navigation
(three per row). Causes: `expanded`/`activePageId`/selection passed as props/context to every row;
react-router's `useNavigate()` re-renders its caller on every location change under `BrowserRouter`;
`AppDnd` passed inline sensor options to `useSensor` (new sensors → new dnd-kit context on every
render) and an inline context object; `buildTree` recreated every node.

## Decision
- A small store (`createRowStore`) holds expanded set, open page, keyboard selection, multi-selection
  and renaming; `useTreeRow(store, id)` subscribes each row to its own booleans
  (`useSyncExternalStore`). The tree context is stable (actions forward to the latest closures) and
  includes a stable `navigate`.
- `buildTreeShared` reuses a node when its page object and child nodes are unchanged; rows are
  `memo`.
- `AppDnd`: sensor options are module constants; the tree DnD context value is memoized.

Measured (headless Chromium, production build, 2 335 rows expanded, 6 navigations): row renders per
navigation 7 009 → 4; long tasks per navigation ~430 ms → ~115 ms (the remainder is layout of the
40 k-node sidebar). Collapsed tree: 0 ms. Selection, navigation highlight, expand toggle and
multi-select highlighting checked in Chromium and WebKit.

## Alternatives considered
- Virtualizing the tree: removes the remaining layout cost but changes DnD and keyboard handling;
  follow-up if trees of thousands of expanded rows are common.
- `React.memo` alone: defeated by the props/contexts above.

## Trade-offs
Rows read their flags from a store written during the tree's render and notified in a layout effect
— the usual "latest value" pattern; it assumes the tree is not rendered in a discarded concurrent render.

## How others solve it
Large-tree components (VS Code's explorer, react-arborist) virtualize rows and keep per-row state in stores.

## Consequences
Remaining cost scales with the number of expanded rows' DOM; see the virtualization follow-up.

## References
- apps/web/src/components/PageTree.tsx:52 (`createRowStore`), :105 (`useTreeRow`), :179 (`buildTreeShared`)
- apps/web/src/components/PageTreeItem.tsx (memo, `useTreeRow`, `nav.navigate`)
- apps/web/src/components/dnd/AppDnd.tsx:74 (sensor options), :351 (context value)
