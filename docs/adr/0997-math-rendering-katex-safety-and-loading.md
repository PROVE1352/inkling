# 0997. Math rendering: KaTeX with safety options, lazy loading, editing UX, share page and print

- Status: Accepted
- Date: 2026-11-07

## Context
Equations are stored as LaTeX in two node types (ADR 0995) and written as `$$` / `$…$` in Markdown
(ADR 0996). They have to render in the editor, on the public share page, in print / PDF export,
in both themes and on phones, from untrusted input (any member, any agent, any imported file), under
the app's CSP (`script-src 'self'`, `font-src 'self' data:`, no CDN) and without making the first
screen heavier. KaTeX 0.19.1 is the renderer (added to `apps/web` at an exact version).

## Decision
### Safety
- Every render uses `trust: false` (`\href`, `\url`, `\includegraphics`, `\htmlClass/Id/Style/Data`
  stay inert), `throwOnError: false`, `strict: 'warn'`, `maxExpand: 1000`, `maxSize: 20` (em) and a
  fresh empty `macros` object (`lib/mathRender.ts`).
- Before KaTeX sees a source, `checkLatexSource` (`@inkling/shared/math`) refuses macro definitions
  (`\def`, `\gdef`, `\edef`, `\xdef`, `\let`, `\futurelet`, `\global`, `\long`, `\newcommand`,
  `\renewcommand`, `\providecommand`) and the link/HTML commands above with a clear message, and
  sources longer than 4,000 characters (shown as text with a warning). `trust: false` is the
  second layer.
- Errors are shown, not thrown: a parse error shows the source and KaTeX's message in small text;
  an unknown command renders in the error colour with the reason under the formula (KaTeX gives the
  reason only when asked to throw, so it renders a second time with `throwOnError: true` in that
  case only).
- KaTeX output is inserted with `innerHTML` only from KaTeX itself; user text in it is escaped by
  KaTeX (tested with `\text{<img …>}`).

### Loading
- `katex`, its stylesheet and fonts are dynamic imports. Vite bundles them under `assets/` (fonts)
  and `assets/lazy/` (code), so they are same-origin (CSP unchanged), not precached by the service
  worker and fetched only by pages that show math. Browsers download only the woff2 files a page
  uses.

### Editing
- Block: click (mouseup — ProseMirror's node selection on mousedown re-renders the node view, so the
  browser never fires `click`) opens a monospace textarea with a live preview (debounced 150 ms);
  leaving it or ⌘/Ctrl+Enter saves, Esc cancels. A blur within 400 ms of opening that is not caused
  by a new pointer press is ProseMirror taking focus back after the click; the field keeps focus.
- Inline: click opens a popover (portalled to `body`, so ProseMirror never sees its key events)
  with an input and preview; Enter saves, Esc cancels, an emptied equation is removed, and the caret
  returns right after the node.
- Creation: slash menu "Math block" / "Inline math" (aliases in English and Korean: `math`,
  `equation`, `latex`, `수식`, …), ⌘/Ctrl+Shift+E (Notion's key, free in this app; wraps the
  selected text), and typing `$x^2$`: the closing `$` converts with the same pandoc rule as Markdown
  import (`$5 and $10` stays text, and sources that look like money such as `$5-$` are skipped).
  Not in code blocks or code marks. The typing rule is a keyboard shortcut on `$`, so it needs a
  real `keydown`; Android virtual keyboards often send none, and there the slash menu is the way.
- A just-inserted node opens its editor only in the tab that inserted it (a module-level marker),
  so a collaborator receiving the same empty node does not get focus pulled into it.
- Read-only pages (lock, ink mode) render without editing.

### Share page, print, themes, phones
- The share page HTML carries the source (ADR 0995, 0999). `PublicView` sanitizes first (ADR 0852;
  `data-latex` is a `data-*` attribute and survives, and `<math>` would not), then renders KaTeX into
  `[data-latex]` elements itself, through the same engine as the editor (ADR 0998).
- `print.css`: formulas print whole (no scroll box), display equations avoid page breaks, editing
  chrome is hidden. Before printing every pending formula is rendered (ADR 0998).
- KaTeX draws with `currentColor`, so it follows the theme; editing chrome and errors use the palette
  variables with a dark-mode error colour. Wide display equations scroll inside their block
  (`overflow-x: auto`), so a phone never scrolls the page sideways.

## Alternatives considered
- **MathJax**: larger, slower, and its SVG/CHTML output needs more CSS and font plumbing.
- **CDN KaTeX**: breaks the CSP and offline use.
- **Render inside the sanitizer's allowlist**: KaTeX's MathML and inline styles would have to be
  allowed for all share HTML; rendering after sanitizing keeps the allowlist unchanged.

## Consequences
- Tests: `apps/web/src/lib/mathRender.test.ts` (options, refused commands, `trust: false` without
  the pre-check, parse errors and warnings, size cap, escaping), `sanitizeHtml.test.ts` (server
  math markup passes unchanged; markup inside `data-latex` never becomes an element).
- Bundle and timing numbers are in ADR 0998 and docs/PERFORMANCE.md.
