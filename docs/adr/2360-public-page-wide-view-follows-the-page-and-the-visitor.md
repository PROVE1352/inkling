# 2360. Wide view on public pages follows the page, then the visitor

- Status: Accepted
- Date: 2026-11-10

## Context
Public links (`/s/<token>`, folder pages `/s/<token>/p/<ref>`) showed every page in a fixed `max-w-3xl`
column. Wide tables, inline database views and the tables that stand for charts and query results were
cut to that column and scrolled (or, for BlockNote's `.tableWrapper`, spilled past it). In the app the
"Full width" switch is a page property (`pages.properties` `{id:'fullWidth', value:true}`, `pageDto.ts`);
the separate "line width" setting is per device (`lib/prefs.ts`) and means nothing to a visitor.

## Decision
- The public DTO (`PublicPageDTO.fullWidth`, additive) carries the page's own "Full width", read with the
  same JSON test as `pageDto.ts`; for a folder link each page has its own value.
- A "Wide view" button (`aria-pressed`) on the public page switches the column between the old 48rem and
  the whole window. The visitor's last choice is kept in this browser (`localStorage`
  `inkling-public-width`, read and written in `try`/`catch`) and wins over the page's default on every
  public page; without a stored choice the page's "Full width" decides.
- Wide view widens the blocks that hold wide content (tables, code, images, diagrams). Running text
  (paragraphs, headings, list items, quotes, callouts) stops at 60rem, left-aligned with the title, about
  110 Latin or 60 Korean characters (`publicView.css`).
- A table wider than the column scrolls inside its own box (`.tableWrapper`), so a phone or the narrow
  column never scrolls sideways (checked at 390 px).

## Alternatives considered
- **A per-link "open wide" option in the share dialog**: a second setting for the same thing; the page
  property already says how the author wants the page laid out, and it works for each page of a folder link.
- **Exactly the app's full width (no cap on text)**: the app's `EditorDropZone` drops the max width for
  everything, so on a 1920 px screen a paragraph runs 1800 px. A visitor cannot fix that with a device
  setting, so the public page caps running text. The two now differ on purpose.
- **Remember the choice per link**: a visitor who likes wide pages would have to say so on every link.

## Consequences
- Two screen faults found on the way are fixed with it: the body's `dangerouslySetInnerHTML` object is
  memoised (React 19 compares it by identity and reset the body on every re-render, dropping drawn
  Mermaid diagrams and KaTeX, now triggered by the wide toggle and before by closing a presentation), and
  code blocks follow the page palette (BlockNote's global CSS gave them white text on the public page's
  light `<pre>`).
- A text-only page looks almost the same wide or narrow (text moves from centred to left-aligned and may
  get up to 60rem); the difference shows on pages with tables and diagrams.
- Turning "Full width" on in the app changes the default for visitors who never touched the button.

## References
- `apps/web/src/components/PublicToolbar.tsx` (`usePublicWide`), `apps/web/src/publicView.css`,
  `apps/server/src/routes/public.ts` (`publicViewFlags`), ADR 2363
