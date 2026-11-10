# 1870. Public form answers are people's input, not agents' edits

- Status: Accepted
- Date: 2026-11-10

## Context
A row sent through a public form is made as the member who published the form, with
`via = "public form"` (ADR 1822), so the change feed and catch_up can say "Alice via public form".
Every other non-null `via` is the OAuth client name of an agent connection, and many places read
"`via` is set" as "an agent did it": the activity AI and people filters, the AI clients list, the
"Written by AI" badge, the daily AI summary (in-app and the `agent_digest` webhook), the team agents
board (ADR 1862), the quiet rule for agents' mentions, the "AI edit" snapshot, and the rule that
agents' mentions do not ping a webhook or Slack channel. A visitor's answer showed up in all of them as
an AI edit.

Wave 13 also put three new features next to each other that this integration had to line up: member
status (ADR 1845, 1846), assigning work to a person's agent connection (ADR 1864) and Slack channel
posts (ADR 1802).

## Decision
- One predicate, `apps/server/src/agentVia.ts`: `isAgentVia(via)` (TypeScript) and `agentViaSql(col)` /
  `personViaSql(col)` (SQL). An agent is a non-null `via` other than `PUBLIC_FORM_VIA`. Every place that
  sorts changes into AI and people asks it; `via IS NOT NULL` alone is no longer used for that.
  Labels keep the raw `via` ("via public form" stays in the feed, catch_up, mail and webhooks), and the
  revert dialog still offers "revert" on form rows (cleaning up spam answers is a feature).
- `public form` is a reserved OAuth client name (`clientName.ts`, folded like the others), so no agent
  can register under the form's marker and pass for people. A client registered under that name before
  this release keeps working; it is refused at its next consent.
- Member status reaches row assignments: `update_row` / `create_row` that write a person cell (also by
  naming a person's agent connection, where the cell holds the person) end with one `status:` line;
  `query_rows` ends with one line for the people in the shown person cells (the query route lists them
  as `people`, sorted, absent when none). The caller's own person is left out. Agent chips in page
  Markdown count as their person for the existing mention status line. No status, no line, no
  statement; the line is sorted by name and then user id, so the same statuses give the same text.
- Work handed to one agent connection (ADR 1863) never becomes a Slack channel post, also when the
  person keeps a copy (`person_too`): the channel follows the person's own events only, so a comment that
  mentions Bob and hands to Bob's agent posts once.

## Consequences
- A form answer is never quieted, summarised or counted as AI work; the publisher's team board shows no
  "public form" agent.
- New code that needs "was this an agent" must use `agentVia.ts`; a grep for `via_client IS NOT NULL`
  should only find it there.
- Agent output gains about 11 tokens per status line (one person), and nothing when nobody involved has
  a status.

## References
- apps/server/src/agentVia.ts, apps/server/src/agentVia.db.test.ts
- apps/server/src/mcpTools/rowStatus.db.test.ts, apps/server/src/slack/slack.db.test.ts,
  apps/server/src/shareFormGate.db.test.ts
- ADR 1002, 1004, 1822, 1846, 1862, 1863, 1864
