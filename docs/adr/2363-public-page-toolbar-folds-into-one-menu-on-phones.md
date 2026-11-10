# 2363. Public page actions: a row of buttons, one "⋯" menu on narrow screens

- Status: Accepted
- Date: 2026-11-10

## Context
The public page had a theme switch in the corner and a "Present" button under the title. Wide view, Save
as PDF and Download Markdown (ADR 2360–2362) make five actions; on a 390 px phone a row of five labelled
buttons does not fit next to anything.

## Decision
- One toolbar (`role="toolbar"`, `components/PublicToolbar.tsx`) above the title, hidden when printing.
  From the `sm` breakpoint up it is a row of labelled buttons in tab order: Present, Wide view
  (`aria-pressed`), Save as PDF, Download Markdown (only when the link allows it; an `<a download>`), and on
  single-page links the theme switch. Folder links keep their theme switch in the side list / top bar.
- Below `sm` the row is replaced by one "⋯" button (`aria-haspopup="menu"`, `aria-expanded`, label
  "More"). Its menu (`role="menu"`, items `menuitem` / `menuitemcheckbox` for wide view) takes focus on
  open, moves with the arrow keys, Home and End, closes on Escape (focus back to the button), on Tab and on
  a click outside.
- Strings live in a new area file `i18n/{en,ko}/public-view.ts` (also the share dialog's download row and
  the audit label); the dictionaries get one import and one spread line each.
- The single-page link's corner theme switch stays for the loading, not-found and gate screens only.

## Alternatives considered
- **Keep "Present" under the title and add more buttons there**: five buttons under every title, and no
  place for them on a phone.
- **Icon-only buttons at every width**: unclear for "Wide view" and "Save as PDF"; the menu has labels.

## Consequences
- `data-testid="public-present"` stays on the desktop button (other checks click it); on a phone it is
  inside the menu.
- The public page's own JS grew by about 4.9 KB (1.3 KB gzip), plus print.css and 0.5 KB of view CSS.

## References
- `apps/web/src/components/PublicToolbar.tsx`, `apps/web/src/pages/PublicView.tsx`, ADR 1843
