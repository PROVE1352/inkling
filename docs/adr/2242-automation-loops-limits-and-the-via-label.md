# 2242. Automation loops stop at a marker and a depth limit; their writes read "via automation: <name>"

- Status: Accepted
- Date: 2026-11-10

## Context
An automation's write is a row write like any other, so it starts rules again: a rule on its own row
("when Status changes, set Status"), two databases that add rows to each other, or a long chain. The feed,
catch_up, the version history and the "Last edited by" property (ADR 2141) must say that a rule did it,
without making it an AI write (ADR 1870: `isAgentVia` decides AI steps, quiet notifications, activity
filters).

## Decision
- **Marker**: the request a run makes carries `user.automation = { ruleId, depth, chain }`; `actorOf`
  puts it on the `EditActor`, and the change log keeps it in the outbox payload (`actorJson`). Runs queued
  from such a write get `depth + 1` and `chain + ruleId`.
- A run is **skipped and recorded** when its rule is already in the chain ("loop: this rule already ran in
  this chain") or its depth exceeds `AUTOMATION_MAX_DEPTH` = 3 (four automation steps in a row).
- **Rate limits** per process: 30 runs per rule and 120 per workspace per minute; beyond them a run is
  skipped and recorded. A second server process doubles them (they are a flood guard, not a quota).
- **Label**: an automation's writes have `via = "automation: <rule name>"` (shared `automationVia`, capped
  at 80 characters) and the author as actor. So `page_changes.via_client`, `pages.edited_via` /
  `created_via`, notifications and webhook payloads read "Olivia via automation: Triage".
  `isAgentVia` and `agentViaSql` are false for the prefix, `personViaSql` true: no AI step versions, no
  quiet agent notifications, the "people" side of activity filters. `reservedClientName` refuses OAuth
  client names that fold to a word starting with "automation", so no agent can pass for a rule.

## Alternatives considered
- **Depth only** (no chain): a self-loop would run four times before stopping, writing three times.
- **Never let automation writes trigger rules**: chains across databases (request → log → notify) are the
  main use.
- **A separate `automation_id` column** on page_changes and pages: a migration on two hot tables and every
  reader of via taught a third case; the via string already reaches every place that names an actor.

## Trade-offs
- The label is the rule's name at write time; renaming a rule does not rewrite history.
- Old clients and integrations that treat any via as an agent show the rule like an agent client.

## Consequences
- agentVia.ts, clientName.ts, context/attribution.ts, context/changeLog.ts, rowTemplates.ts (`actorOf`),
  automations/pure.ts (`nextMarker`), runner.ts. Tests: automations.test.ts, automations.db.test.ts (two
  rules feeding each other, a chain of five).
