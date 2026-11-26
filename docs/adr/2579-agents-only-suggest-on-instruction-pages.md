# 2579. Agents only suggest changes to agent-instruction pages

- Status: Accepted
- Date: 2026-11-26

## Context
A page designated as agent instructions (docs/adr/0975-*) is locked with the default presets
(people: editors, agents: same). Owners and admins skip the people layer, so their agents could rewrite
the instructions directly. One prompt injection read by an admin's agent could change the "trusted"
`<instructions>` every agent of the workspace receives (C-mcp M3).

## Decision
- The lock walk marks the leaf's own node when the page has an `agent_instructions` row. For agent
  requests, `effectiveCaps` turns EDIT into SUGGEST on such a node (a stricter preset stays as it is), and
  `chainAgentPolicy` answers "review" for it. So patch_section, patch_sections and update_page leave a
  suggestion that no auto-accept rule takes, and rename, move, trash, restore and split are refused with a
  PAGE_LOCKED message that says the page holds agent instructions.
- The designation's lock presets are unchanged; the rule follows the designation (removing it restores
  the lock's own rules). Set and remove already bump the workspace access version, so cached lock chains
  are not reused across them. People's edits are unchanged.

## Consequences
- An agent cannot trash or move a folder that has an instruction page below it.
- `read_page` shows `can: read,comment,suggest` on an instruction page to every agent.
