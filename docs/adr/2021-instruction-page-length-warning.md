# 2021. A long instruction page shows a warning; the server measures, the web only shows

- Status: Accepted
- Date: 2026-11-10

## Context
`get_instructions` returns every `always` instruction page in full (ADR 0975), and agents are told to call it once
before working in a workspace. Whatever such a page holds is read at the start of every agent session in that
workspace. Teams tend to grow these pages into the place for everything an agent should know: rules, project
facts, decisions, links. Then each session pays for the whole page before it does anything, and the facts in it go
stale without anyone noticing, because the page is locked and few people edit it.

The useful shape is a short page that says what the rules are and where things are, with links; the details live in
ordinary pages that `find_context` finds when they are needed (docs/RECIPES.md, "Team memory").

## Decision
- The **server** decides what "long" is and measures each instruction page on the Markdown agents get
  (`GET /api/workspaces/:id/agent-instructions/length`, [ADR 2004](2004-long-instructions-note-and-length-route.md)):
  per page `{ pageId, mode, lines, bytes, tokens, long, truncated }`, `long` = more than 200 lines or 25 KB, the
  same rule as the note at the end of get_instructions. The web app matches its page by `pageId` and shows the
  warning when `long` is true (the token estimate is only displayed). It does not count anything itself, so the
  browser, the tool output and the docs cannot disagree. The route is separate from the lock DTO because measuring
  needs each page's Markdown, which the lock and list paths do not load.
- The **web app** shows the warning where instruction pages are managed and read:
  - the Edit lock dialog's "Agent instructions" part: a short note with the size and what to do ("keep only rules
    and where things are; move details into normal pages and link them");
  - the list of the workspace's other instruction pages in that dialog, and the lock line above an instruction
    page: one small badge.
- No value, no warning. A server without the field, or a page not measured yet, shows nothing; the warning is a
  hint, never a block, and saving or designating a page is unchanged.
- The decision logic is a pure function (`lib/instructionLength.ts`) with its own tests; the component renders
  nothing unless that function says the page is long.

## Alternatives considered
- **Count tokens in the browser** from the editor's text: duplicates the server's estimator and drifts from what
  agents are actually sent (`applies:` lines, wrapping), and a reader without edit rights has no editor loaded.
- **Refuse long instruction pages**: the page is the owners' to write; a limit would push rules into places agents
  do not read as instructions.
- **Show the warning on every page** that an instruction page links to: noise; the cost is in the instruction page.

## Consequences
- One extra request (members only, cached 30 s) where an instruction page's lock line or the lock dialog is shown;
  lock and designation changes refetch it. Guests see the lock line without the badge.
- The threshold can change on the server without a web release.
