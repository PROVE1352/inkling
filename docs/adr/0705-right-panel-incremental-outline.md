# 0705. Right panel outline from the ProseMirror doc with a per-block cache

- Status: Accepted
- Date: 2026-11-07

## Context
300 ms after each edit the right panel called `editor.document` (ProseMirror → BlockNote JSON for
the whole document) and walked it three times for headings, outgoing page links and tags.

## Decision
`lib/docOutline.ts` reads the ProseMirror doc directly. ProseMirror nodes are immutable and
structurally shared, so a summary per top-level `blockContainer` is cached in a `WeakMap` keyed by
the node: after an edit only changed blocks are re-read. Semantics are the old ones (heading
text/level/id, `link` marks to `/w/<ws>/p/<id>`, `#tag` after start/whitespace, tables excluded);
equality with the old algorithm was checked in the browser on the 3 701-block document (401 headings,
30→31 tags after an edit) and on a page with links and nested blocks.

Measured (Chromium, 3 701 blocks, per tick): old 1.4–4.9 ms, new 0.2 ms after an edit (BlockNote
already caches block JSON, so the old path was cheaper than feared; the gain is ~10× but small in
absolute terms on desktop).

## Alternatives considered
- Keep `editor.document` and lengthen the debounce: still O(document) per tick.
- Server-computed outline: stale while typing.

## Trade-offs
Depends on BlockNote's ProseMirror layout (doc → blockGroup → blockContainer → content, blockGroup).

## How others solve it
Editors usually derive outlines from their own document model incrementally (CodeMirror's syntax tree, Lexical's dirty nodes).

## Consequences
None beyond the layout dependency above.

## References
- apps/web/src/lib/docOutline.ts, apps/web/src/components/RightPanel.tsx (useMemo over `computeOutline`)
