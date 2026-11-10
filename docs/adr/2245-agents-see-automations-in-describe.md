# 2245. Agents see a database's enabled automations in query_rows describe; they cannot make rules

- Status: Accepted
- Date: 2026-11-10

## Context
An agent that updates a row may start rules that notify people, call webhooks or add rows elsewhere. It
should know before it writes, without a new tool or longer tool descriptions (fixed cost per session,
ADR 2000).

## Decision
- `query_rows describe=true` adds, inside the existing untrusted block, `Automations (run after your
  writes, as the rule's author):` and one line per enabled rule: `- <name>: <trigger> → <actions>` (the
  server's `summary`, e.g. `Status changed to "Review" → notify Owner`). Nothing is printed for a database
  without enabled rules, or when the caller may not list them (a guest).
- No MCP tool creates, changes or lists rules in v1; rule routes refuse bearer requests for writes.
  Rule names are member-written text and stay inside `<untrusted_content>`.

## Alternatives considered
- **A hidden `list_automations` tool**: one more tool for information that belongs next to the schema the
  agent reads before writing.
- **A line in update_row / create_row results** after the fact: the agent learns too late.

## Consequences
- mcpTools/collectionTools.ts (`loadAutomationLines`), AutomationDTO.summary. No tool description changed.
