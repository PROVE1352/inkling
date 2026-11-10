# 1846. Member status in presence, mentions and agent output

- Status: Accepted
- Date: 2026-11-10

## Context
A status helps only where someone is about to involve the person: mentioning, assigning, or seeing
who is on the page. Agents mention people (`@[Name](user:<id>)`) and set document owners too.

## Decision
- **Presence**: the awareness `user` field also carries the account id (BlockNote passes the object
  through unchanged; the canvas sets it directly). The avatar shows the status emoji and the text in
  its title, looked up in the members list. Awareness is client-written, so the id only picks which
  (already visible) status to show.
- **Agents, at the moment of involving someone** (zero tokens otherwise):
  - after `patch_section`, `update_page` and `create_page` whose Markdown mentions people:
    `status: Mia "🎓 Exam week" until 2026-11-14` (one line; `create_page` adds a `status` field);
  - `read_page`'s owner line: `- owner: Mia (status "🎓 Exam week" until 2026-11-14)`.
  Only members of the page's workspace are looked up (a mention of an outsider id says nothing).
  Text is member-written: `cleanText`, quoted, capped at 80 characters.
- Not in `find_context`: it is read far more often than people are involved.

## Alternatives considered
- **A members tool for agents**: one more call; the status is needed where the person already appears.
- **Block mentions of away people**: the status is information, not a rule.

## Consequences
- About 15 tokens per mentioned person with a status. Assignment tools of other areas (collection
  person fields, agent task assignment) can call `peopleStatusLine(workspaceId, userIds)`.
