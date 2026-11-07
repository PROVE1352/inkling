# 0922. Template variables: server-side at instantiation, inside text runs only

- Status: Accepted
- Date: 2026-11-07

## Decision
- Variables: `{{title}}`, `{{date}}`, `{{date:FORMAT}}`, `{{time}}`, `{{time:FORMAT}}`,
  `{{weekday}}`, `{{author}}`, `{{workspace}}`, `{{input:Question|default}}`, `{{cursor}}`.
  Formats are a moment.js token subset implemented in `templates/variables.ts` (no dependency);
  month/weekday names come from `Intl` in the creator's locale.
- **When and where:** on the server, when a page is created from the template. The client sends
  only answers (`inputs`) and its IANA time zone (`tz`); `date` from the gallery replaces the day.
  Without a valid `tz` the server's `TZ` applies (ADR 0903).
- **Text runs only.** Substitution walks the Yjs XML and replaces text run by run (a run = text
  with one set of marks), deleting and re-inserting with the same attributes. Marks and link
  attributes therefore survive; a variable split across two formats is not recognised; inline
  code and code blocks are skipped so documentation about templates stays literal. Titles, canvas
  text cards and text values of rows use the same string function.
- **Unknown or malformed variables stay literally**, as do variables with an argument they do not
  take (`{{title:x}}`).
- **Inputs:** questions are collected in order of first appearance (max 20) and listed in the
  template DTO; the gallery asks them in a step before creating, prefilled with the default. An
  empty answer falls back to the default written at that occurrence. Answers are plain text.
- **Cursor:** the first `{{cursor}}` (root first, depth-first) is removed and returned as
  `{ pageId, blockId, offset }`; the client opens the page with `?cursor=<blockId>:<offset>` and
  the editor places the caret there after sync.

## Trade-offs
Variables are never re-evaluated later; a page shows the date it was created with.
