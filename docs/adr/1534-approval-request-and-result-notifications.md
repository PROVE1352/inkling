# 1534. approval_request and approval_result come from suggestions

- Status: Accepted
- Date: 2026-11-09

## Context
The notification kinds `approval_request` (passes mute, ADR 1000) and `approval_result` (an agent
inbox kind, ADR 1003) were defined with no producer.

## Decision
- A new suggestion sends `approval_request` to the page's document owner (`pages.owner_id`, the
  review owner of ADR 0951), else the page's creator, queued with the outbox in the suggestion's
  transaction (ADR 1150). Excerpt: the suggested Markdown (or "(remove §…)").
- A decision sends `approval_result` to the suggestion's author, the person whose connection made it;
  their agents read it with `inbox` (`kinds: ['approval_result']`). Excerpt:
  `accepted|rejected: suggestion <id> (<mode> §<anchor>)`. Rejection is queued in its transaction;
  acceptance after the document edit.
- The engine never notifies an event's actor. When the reviewer is the author (your agent on your
  page), or the author decides on their own suggestion, the event is sent without an actor so the
  person (and their agent) still get it.
- Withdrawn and superseded suggestions send nothing.

## Alternatives considered
- **Notify everyone who can edit**: noisy for shared pages; the owner is the person the review
  features already address.

## References
- apps/server/src/suggestions.ts, apps/server/src/notify/kinds.ts, apps/server/src/mcpTools/inboxTools.ts
