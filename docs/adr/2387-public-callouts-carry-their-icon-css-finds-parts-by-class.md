# 2387. Public page callouts carry their icon; the CSS finds the icon and the text by class

- Status: Accepted
- Date: 2026-11-11

## Context
On a public link (`/s/:token`) a callout at the top of a page was unreadable: the label, an inline code
span and the following sentences stood side by side in narrow columns, ran out of the tinted box and, on a
390 px phone, widened the page to 579 px. Every type was tinted the note blue.

The public page shows the server's HTML (`blocksToFullHTML`, `md/serverSchema.ts`), not the editor. Since
b818274 (0.12.0) the server renders a callout as `div.nd-callout > div.nd-callout-content`: the text alone.
The app's stylesheet (since 1a2815f, 0.8.0) styles `.nd-callout > :first-child` as the icon box (a flex row
1.5em high), because in the editor the first child is the type switcher. On public pages that rule hit the
text. The tint was an inline custom property (`--nd-callout-accent`) set by the editor's React render; the
server never wrote it, and the public sanitizer would drop it anyway (ADR 0852 keeps a few layout
properties only).

A side-by-side audit of every block the editor has (app vs public link, light/dark, 1280/390 px) also found
that text and background colours never showed on public pages: the server HTML keeps BlockNote's colour
attributes, but BlockNote's rules read palette variables that only the editor's root element sets.

## Decision
- **Server HTML carries the icon.** The callout render writes `span.nd-callout-icon` (`aria-hidden`) with the
  type's emoji, then the text element; an unknown type is drawn as a note. The icon is outside `contentDOM`,
  so HTML read back (paste, clipping) takes the text only, and Markdown keeps `> [!type] text` (callouts
  become quotes before BlockNote's Markdown export, `md/notation.ts`).
- **One emoji table** in `@inkling/shared` (`CALLOUT_EMOJI`), used by the editor's type switcher and the server.
- **CSS by class, not by position.** `.nd-callout > .nd-callout-icon` is the icon box (the editor's switcher
  span carries the class too); `.nd-callout-body` (editor) and `.nd-callout > .nd-callout-content` (server)
  are the text, `flex: 1; min-width: 0; display: block`. HTML rendered before this change (text only) still
  flows as one block, just without an icon.
- **Tint by attribute.** `.nd-callout[data-callout-type=…]` sets `--nd-callout-accent` for the five types; the
  editor no longer sets it inline. Same values as before.
- **Public icon box** one public line high (`line-height` 1.7 there, 1.5 in the editor), the emoji at the
  editor's 1.125×.
- **Colours on public pages.** `.nd-public-body` sets BlockNote 0.51's default palette (light and dark, the
  values the editor shows) and its own rules for `[data-style-type=textColor|backgroundColor][data-value]`
  and blocks and table cells with `data-text-color` / `data-background-color` (a block's colour covers its
  children, as in the editor). They do not rely on BlockNote's stylesheet arriving with the public chunk.
  The dark palette is screen-only: printed or saved as PDF from the dark theme, the page keeps the light
  palette like the rest of the paper (ADR 2361).

## Audit (2026-11-11, Chrome; screenshots and probe in the w192 browser check)
| Block | Result |
|---|---|
| Paragraph, bold/italic/underline/strike/inline code, alignment, headings 1–3, bullet/numbered/check lists with nesting, quote, divider, table, image with caption and width, math (inline and block) | Same as the app (public prose style: slightly different spacing, quote line and link colour, index.css M15) |
| Callout, 5 types | Broken, fixed here |
| Text colour, background colour (inline, block, table cell) | Broken, fixed here |
| Mentions, page links | Different by design: `@label` text (ADR 1500), links inside a folder link go to its public page |
| Link embed (card), page embed, database view | Different by design: the URL (no cached preview title in the sample), title link and body one level deep, table (ADR 2121) |
| Query block | Not compared: the sample query matched no rows in the app either ("No matching pages"); the public page said "No results inside this link." (ADR 2121) |
| Mermaid | Different by design: the picture without the editor's frame (ADR 2191) |
| Button | Different by design: inert, grey (ADR 2244) |
| Chart | Current behaviour, not changed here: a table of the data inside the link (ADR 1605) |
| Toggle heading, toggle list | Next: always open on public pages, the arrow does not fold |
| Code block | Next: no language label and no highlighting on public pages |
| File block | Next: name and caption shown, but no link to open the attachment |

## Alternatives considered
- **CSS only, icon from `::before` by type**: fixes old HTML too, but puts the emoji table into CSS as well
  as the editor, and the app's presentation slides (copies of the editor's DOM) would need it switched off.
- **Widen the sanitizer to keep `--nd-callout-accent`**: the sanitizer is an allowlist of layout properties
  (ADR 0852); a custom property is a value the page's CSS reads anywhere, and the type attribute already
  says the same thing.
- **Render public pages with the editor (read-only BlockNote)**: same look by construction, but the public
  chunk would carry the editor, and the server-side filtering of embeds and queries (ADR 2121) is HTML work.

## Consequences
- Public HTML is cached in process memory for at most 10 minutes per page revision (`routes/public.ts`,
  ADR 0753) and responses are `no-store`; a deploy restarts the process, so no old HTML outlives it. The CSS
  still handles text-only callouts.
- Markdown exports, the public Markdown download, MCP reads and the version preview are unchanged
  (`md/publicHtml.test.ts`).
- Tests: `apps/server/src/md/publicHtml.test.ts`; a browser check measures each callout body (width, bottom,
  the code after a hard break starting a new line at the text's left edge) in the app, on the public page,
  in presentation and print, at 390 px, and with the old text-only HTML, and compares computed colours with
  BlockNote's palette on screen (light, dark) and on paper.

## References
- `apps/server/src/md/serverSchema.ts`, `packages/shared/src/blocks.ts`, `apps/web/src/components/blocks/Callout.tsx`,
  `apps/web/src/index.css`, ADR 0753, 0852, 1222, 1500, 1605, 2121, 2191, 2244
