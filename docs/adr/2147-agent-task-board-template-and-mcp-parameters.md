# 2147. An agent task board template; sub-items in query_rows and create_row

- Status: Accepted
- Date: 2026-11-10

## Context
Teams run several agents on one workspace (ADR 1860–1864): one agent takes a large task, splits it, and
others pick up the parts. The pieces exist in 0.17 — sub-items (2144), IDs (2140), a person cell with the
person's agent connection (1861) — but each team would assemble the board by hand, and agents need to
read a subtree and add a sub-task without first learning field ids.

## Decision
- **Built-in template `agentBoard`** ("Agent task board" / "에이전트 작업 보드", category projects):
  Status (To do, In progress, Blocked, Done), Assignee (person; the agent connection goes next to it),
  Parent task (sub-items), Evidence (text: PR, commit or doc link), ID (`TASK-n`); views: by status
  (board), task tree (table, nested), list; one example task with two sub-tasks whose body explains the
  split-and-pick-up flow. Builtin specs gain two placeholders resolved at compile time: `@self` for a
  relation to the collection itself and `@row:<title>` for a starter row's link to another starter row.
- **MCP**: `query_rows` takes `under` and `depth`; `create_row` takes `parent`; both accept a row id, an
  ID (`TASK-3`) or an exact title. `update_row` accepts an ID for the Parent item. `create_collection` /
  `update_fields` field specs take `prefix` (uniqueId) and `subItems` (relation, update_fields only).
  Fixed cost (`scripts/mcp-tools-list-cost.ts`, per tool before/after): full profile +181 tok (12,370 →
  12,551 for the 0.16 tool set; create_collection +76 and update_fields +19 for the seven type names in the
  field type enum and the two spec keys, query_rows +56 for under/depth, create_row +29 for parent,
  create_view +1 for `list`), core profile +85 (7,437 → 7,522: query_rows and create_row). No new tool.
- The flow for docs/RECIPES is in the 0.17 notes.

## Alternatives considered
- **New tools (`list_subtasks`, `add_subtask`)**: two more entries in every tools/list for what two
  parameters do.
- **Claiming by a lease field**: the person cell with "this connection" (ADR 1864) already says who took a
  row, and update_row's baseVersion makes a second claim fail.

## References
- apps/server/src/templates/builtins.ts, packages/shared/src/templates.ts, mcpTools/collectionTools.ts,
  mcpTools/structureTools.ts
- ADR 1860–1864, 2000, 2140, 2144
