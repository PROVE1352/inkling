# 0700. Push the online-users list to React only when it changes

- Status: Accepted
- Date: 2026-11-07

## Context
`CollabEditor` and `useCanvasDoc` subscribed to the Yjs awareness `change` event and called
`setUsers(readUsers(provider))` every time. Awareness changes on every remote cursor move,
selection change and the 15 s heartbeat, but the list we render (who is here, name, colour) almost
never changes. Each call produced a new array → state update → `onCollabChange` → `PageView`
re-render. The memory audit (out-of-tree measurement scripts) measured 21× more React commits than needed.

Measured (headless Chromium, production build, a second client changing an awareness field
150 times at 100 ms intervals, React commits counted through the DevTools hook):
before 303 commits, after 2–3 commits (Chromium and WebKit). The remote user still appears and
disappears correctly.

## Decision
`readUsers()` + `sameUsers()` live in `lib/collabSocket.ts`. The awareness handler keeps the last
list in a closure and only calls `setUsers` when `sameUsers(last, next)` is false (same length, same
clientId/name/colour in order). No React update is scheduled at all for cursor-only changes.

## Alternatives considered
- `setUsers(prev => same ? prev : next)`: React still schedules a render to run the updater.
- Throttling the handler: fewer commits but still wasted ones, and adds latency to joins/leaves.
- Dropping the users list from `PageView` state: larger change of the top-bar data flow.

## Trade-offs
None material: comparison is O(users) per awareness event.

## How others solve it
Tiptap's collaboration-cursor and Liveblocks expose selector-based presence hooks that compare the
selected slice before notifying React.

## Consequences
Typing next to a collaborator no longer re-renders the page shell per remote keystroke.

## References
- apps/web/src/lib/collabSocket.ts:181 (`readUsers`), :201 (`sameUsers`)
- apps/web/src/components/CollabEditor.tsx (awareness handler in the provider effect)
- apps/web/src/components/canvas/useCanvasDoc.ts (same)
