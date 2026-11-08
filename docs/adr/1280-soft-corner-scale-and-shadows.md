# 1280. Soft corner scale, softer shadows, drawn checkboxes

- Status: Accepted
- Date: 2026-11-08

## Context
Corners were Tailwind's defaults (`rounded` 4 px, `rounded-md` 6 px, `rounded-lg` 8 px) plus hand-written values
in index.css (callout 10, code 8, select list 8, math popover 8, images 4, public images 6) and BlockNote's own
6 px menus with square tooltips. Next to Linear and Arc the app read as angular, and the values did not form a
scale: a menu (6) was rounder than its own select list (8) but squarer than a callout (10). Shadows were
Tailwind's (`shadow-xl`, a short dark drop) and nearly invisible on the dark theme, where menus share the page
colour. Checkboxes were the OS control, square and blue on every theme. The user asked for "soft, not toy-like".

## Decision
- **One scale, as Tailwind v4 theme variables** (`@theme` in index.css, rem so the zoom setting scales them):
  | token | px | used for |
  |---|---|---|
  | `--radius` / `--radius-sm` (bare `rounded`, `rounded-sm`) | 7 | icon buttons, chips, swatches, tooltips |
  | `--radius-md` (`rounded-md`) | 10 | buttons, menu rows, inputs, menus, sidebar rows, body blocks |
  | `--radius-lg` (`rounded-lg`) | 14 | cards, popovers, toasts |
  | `--radius-xl` (`rounded-xl`) | 18 | modals, palettes, sheets |
  Bare `rounded` compiles to `var(--radius)` once `--radius` is in `@theme` (checked in the built CSS); without
  it Tailwind inlines 0.25 rem. Modal surfaces (Modal, command palette, search, history, shortcuts, trash,
  fields, import, local graph, confirm dialog) move from `rounded-lg` to `rounded-xl`.
- **Body blocks share `--radius-md`**: callout (unchanged 10 px), code block (8 → 10), images and video
  (BlockNote 4 → 10), tables, math blocks; on the public page code, images and tables likewise.
- **Tables get a rounded outer edge** without breaking cell borders: `border-collapse: collapse`
  (prosemirror-tables) cannot round a table, so the grid becomes `separate` with `border-spacing: 0`; every cell
  draws only its right and bottom edge, the first row of the first row group and the first column add the top
  and left edge, and the four corner cells take the radius (the header background is clipped by it). The
  wrapper's horizontal scroll and BlockNote's resize handles are untouched.
- **BlockNote** takes the scale through `--bn-border-radius: 10px` (small/medium/large 8/10/12) on
  `.bn-root.bn-root` (doubled class: BlockNote's own `.bn-root` defaults arrive later with the editor chunk and
  won the tie), its menu shadows through `--bn-shadow-medium/light`, and tooltips get 7 px instead of 0.
- **Shadows**: `--shadow-sm … --shadow-2xl` redefined as wider, lighter, two-layer shadows whose colours are
  variables (`--nd-shadow-1/2/3`, `--nd-ring`). Tailwind v4 inlines a shadow's colour into each utility, so a
  `.dark { --shadow-xl }` override would do nothing; colour variables inside the theme value do switch per theme
  (checked in the built CSS). Dark mode uses denser black shadows plus a 0.5 px white ring at 6 % on `xl`/`2xl`,
  so menus on the same colour as the page still have an edge. Border colours are unchanged.
- **Checkboxes** are drawn (`appearance: none`, base layer so size utilities win): 14 px, 1.5 px border in the
  secondary colour, 4 px corners (`--radius-sm` − 3 px), accent fill with a white check, an indeterminate dash,
  focus ring. Check-list items in the editor keep 16 px and no colour transition.

## Alternatives
- **Utility rewrite in every component** (`rounded-md` → `rounded-[10px]`): ~700 call sites, and the next
  contributor would type `rounded-md` again. Changing the variables moves every existing use at once.
- **Round the table through `overflow: hidden` on `.tableWrapper`**: the wrapper is also the horizontal scroll
  box and carries BlockNote's add-row/column buttons in its padding; clipping it cuts those and the outer cell
  borders at the corners.
- **Rounded scrollbar thumbs** with `::-webkit-scrollbar-thumb`: Chromium ignores those pseudo-elements while
  `scrollbar-width`/`scrollbar-color` are set (the thin themed bars), and in Chromium and WebKit on macOS they
  turn overlay scrollbars into classic ones that take layout width. Not adopted; the platform thumbs on macOS and
  Windows 11 are already rounded.
- **Bigger radii (12/16/20)**: rows and menu items started to look like pills at 28 px height.

## Consequences
- Small square things that used `rounded-md` (16 px icons, kbd hints) are now nearly round; none looked wrong in
  the screenshots, but new tiny elements should use `rounded` (7 px).
- A checkbox's look is now ours on every platform; the OS high-contrast mode still applies `forced-colors`.
- The public share page's tables use separate borders as well; a table with a header group plus body keeps one
  line between them.
