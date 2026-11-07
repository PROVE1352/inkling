# 1222. Callout, quote, divider, code and toggle styling next to Notion; quieter page open

- Status: Accepted
- Date: 2026-11-08

## Context
After ADR 1090 the body matched Notion's numbers, yet blocks still looked heavier: a blue stripe on every callout,
grey quote text, a mid-grey divider, a black code block with white text on the light theme, an italic empty-block
hint (synthetic oblique Hangul) whose Korean text repeated "입력" three times, handles that popped in, and on every
page open a "Connecting…" pill that showed for a frame or two and a fade that also slid the page 4 px.
Compared side by side with a public Notion page (2026-11-08, screenshots in the report). That page has callouts,
dividers and headings but no quote, toggle or code block; those follow Notion's documented defaults instead.

## Decision
- **Callout**: radius 10 px, 12 px padding (measured), no stripe, the type colour only as an 8 % tint (13 % on
  dark); the icon sits in a box one text line high so it lines up with the first line.
- **Quote**: 3 px bar in the text colour, text not greyed, 14 px padding.
- **Divider**: 1 px `rgba(28,19,1,.11)` / dark `rgba(255,255,235,.1)` in a 13 px block (measured).
- **Code**: side-bar tone box, 8 px radius, 85 % monospace. Token colours: `lib/codeBlockOptions.ts` wraps the
  Shiki highlighter so every `codeToTokens` call asks for both GitHub themes with `defaultColor: false`; tokens
  carry `--shiki-light` / `--shiki-dark` and index.css picks one by theme (no re-highlighting on theme switch).
  BlockNote's parser otherwise uses the first loaded theme (github-dark) in both themes.
- **Toggle**: 16 px triangle in the ink colour, 0.15 s turn.
- **Empty-block hint**: upright, 70 % of the secondary colour; text "글을 쓰거나 /를 눌러 블록을 고르세요" /
  "Write, or press '/' for blocks" (`editor.placeholder`, passed through BlockNote's dictionary).
- **Handles**: fade in over 0.12 s (opacity only); the indent guide uses the theme line colour.
- **Page open**: the doc column fades in (opacity only, 0.15 s) instead of fade + 4 px slide; the
  "Connecting…" pill appears only after 400 ms (`nd-late`), so a normal open does not flash it. Rendering and
  editability are not gated on sync (ADR 0850's early-typing case).
- All animations stop under `prefers-reduced-motion`.

## Alternatives
- Grey callouts like Notion's default: Inkling's callouts have types (note, tip, warning, danger, info) whose
  colour is information; kept as a light tint.
- Hiding the editor until the first sync to avoid the empty-then-full jump: rejected, it would hide typing before
  sync. The fade covers the jump on a local server (body arrives ~25 ms after the title).

## Consequences
- Code token colours depend on Shiki's dual-theme output (`@shikijs/core` 4.x): colours, italics and bold arrive
  as `--shiki-light*` / `--shiki-dark*` variables, which index.css maps per theme. Re-check after a BlockNote or
  Shiki upgrade.
