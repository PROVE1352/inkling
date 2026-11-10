# 2002. Three MCP prompts: fixed server text, id arguments only

- Status: Accepted
- Date: 2026-11-10

## Context
MCP prompts are text a person picks from the client's menu (Claude Code: `/mcp__inkling__catch-up`)
and that the client puts in the conversation as the person's own turn. That makes them more trusted
than tool output: anything a prompt carries is read as the person's request. Workspace rules for
agents come only from `get_instructions` (locked instruction pages, ADR 0975), and member-written
text is data inside `<untrusted_content>` (ADR 0976). A prompt that included page text, a title or
a workspace's instructions would move member text across that line.

## Decision
- Three prompts, `prompts/list` order fixed:
  - `catch-up` (`workspace?`): get_instructions once per workspace, catch_up, then a summary in a
    fixed order (what needs the person, threads, others' changes); nothing acknowledged or changed.
  - `meeting-notes` (`page`): get_instructions(forPageId), read_page, restructure into Summary,
    Decisions, Action items, Open questions with patch_section and the version read (suggest=true
    where `can:` says so); keep links, mentions and `inkling:` lines; no assignments or mentions.
  - `memory-review` (`workspace?`, `page?`): get_instructions, check_notes (ADR 2003), read only what
    each finding needs, propose fixes, apply only what the person approves; verifying is a person's
    statement; trash nothing without the person's OK.
- **The text is fixed server text** (`mcpTools/prompts.ts`): steps and tool calls, each ending with
  the `<untrusted_content>` rule. No database read happens in prompts/get.
- **Arguments are ids only**: a full id or an 8+ hex prefix, checked by a zod pattern before the
  text is built (an invalid value is an InvalidParams error, nothing interpolated), lower-cased. A
  prompt can never carry a title, page text or an instruction.
- **Profile-aware tool names**: in a `core` connection a hidden tool is written as
  `more_tools(tool="check_notes", arguments={…})` (ADR 2000); `toolProfiles.test.ts` checks that
  every tool a prompt names is listed in that profile.

## Measured
prompts/list: 691 chars, ~173 tok (3 prompts); prompts/get answers: catch-up ~185, meeting-notes
~210, memory-review ~221 tokens. The capability line is part of the initialize difference in ADR 2001
(+64 chars for resources and prompts together). Clients show the list in a menu; a prompt's text
enters the context only when the person picks it.

## Alternatives considered
- **Workspace-defined prompts (a page as a prompt template)**: the person's own client would present
  member-written text as the person's request; the instruction pages already have their channel.
- **Free-text arguments** (a topic, a date range): a person could paste anything, but so could a page
  that tricks a model into calling prompts/get on another client; ids keep the text closed.
- **More prompts** (weekly report, decision log): each costs list bytes on every connection; three
  cover the flows this release adds (catch-up, memory review) and the most asked one (meeting notes).

## References
- apps/server/src/mcpTools/prompts.ts, mcpTools/toolProfiles.test.ts
- docs/adr/0975-*, 0976-*, 2000-*, 2003-*
