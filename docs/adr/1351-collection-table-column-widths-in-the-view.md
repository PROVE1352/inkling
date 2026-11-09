# 1351. Collection table: column widths dragged in the header, saved on the view

- Status: Accepted
- Date: 2026-11-09

## Context
ADR 1322 sized the table's columns from their minimums (title 240 px, fields 150 px) and shared the rest
of a wide pane out with `fr`. A column could not be made wider than its share, so a long title or a text
property was always cut. Notion keeps a width per column per view.

## Decision
- The view config (`collection_views.config`, jsonb, `viewConfigSchema` in `packages/shared`) gets two
  optional keys, so no migration:
  - `columnWidths`: field id → px, integer, 150–1,600, at most 200 entries;
  - `titleWidth`: px, integer, 240–1,600. The title column is not a field, and field ids are free text,
    so a key such as `"title"` inside `columnWidths` could collide with a real field.
  The minimums are ADR 1322's track minimums (`COLUMN_WIDTH` in shared, used by the web table too); a
  request outside the range is a 400, like any invalid config.
- A stored width is a fixed track; a column without one keeps its `minmax(min, fr)` track. The grid's
  minimum width is the sum of the fixed widths and the other columns' minimums. When every column has a
  width, the trailing "+" column takes what is left of a wide pane (`minmax(44px, 1fr)`), so the row
  borders still reach the pane edge (`lib/columnWidths.ts columnTracks`).
- Each header cell has a handle on its right edge (the same `ResizeHandle` as the sidebar, ADR 1350),
  next to the sort button, not inside it. Every track is written as `var(--tc-<i>, <track>)`; a drag
  sets `--tc-<i>` and `--tc-min` on the table root once per frame. The header strip and the rows' scroller
  (two elements since ADR 1322) both read the variables, so they stay aligned without re-rendering up to
  150 rows on each pointer move. On release the width is clamped and saved with the rest of the config
  (`PATCH /collection-views/:id`, which replaces the config), and the variables are removed.
- Double-click removes the width (back to the pane-sized track). Keyboard on a focused handle: ←/→ 16 px,
  Shift 64 px, Home to the minimum.
- Who may save: the same rule as sorts. Someone for whom the collection is read-only (an edit lock, a
  guest with a view level) can still drag, but the width stays on that screen until the view's stored
  widths change or the page reloads; no request is sent. The server refuses the write anyway
  (`assertPageEditable` on the route).

## Alternatives considered
- Keep widths in localStorage per device. Everyone looking at a shared view would see a different
  table, and a width set for a colleague's long property would not reach them; Notion stores it on the
  view. Device-local is what read-only viewers get.
- One map with a reserved key for the title (`"__title"`). Field ids are client-chosen strings up to 40
  characters, so any reserved key is only unlikely, not impossible.
- React state per pointer move. A 150-row page of the table re-renders every row (cells are not memoized
  against grid changes); the CSS variable is one style write per frame.

## Consequences
- Clients that PATCH a view config without the new keys drop the widths, because the config is replaced
  as a whole (as for every other key). The web app always sends the full config. Template export and
  import carry the widths (both go through `viewConfigSchema`); an older server strips them on import
  (zod drops unknown keys) and keeps the rest of the view.
- MCP tools and `inklingctl` do not read view configs; nothing changes there. The API documentation of
  `ViewConfig` lists the two keys (v0.10.0 additions).
- Widths of deleted or hidden fields stay in the config; they are ignored when drawing and do not count
  towards the grid's width. Showing a hidden field again brings its width back.

Tests: `apps/web/src/lib/columnWidths.test.ts` (tracks, minimum width, all-fixed tables, stale and
out-of-range widths, config edits, keys), `apps/server/src/viewColumnWidths.db.test.ts` (stored and read
back, bounds, replaced with the config). Browser check (Playwright, 1440 px): drag +160 px, header and
rows both 310 px; ←/→ saved and kept after reload; double-click back to 150 px; a member under an edit
lock resizes on screen only, with no request to `/collection-views/`.
