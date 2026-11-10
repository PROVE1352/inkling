# 2241. Automations act as their author through REST, capped by whoever triggered them

- Status: Accepted
- Date: 2026-11-10

## Context
A rule's actions write rows, notify people and call webhooks long after the person who set it up left the
page, and they are started by someone else: a member, a page guest, an agent connection, a public form
visitor with no account, or a date. Whoever's rights the actions use must not let anyone do more than
they could do themselves — for example a guest or a form visitor adding rows to a database they cannot
edit, or an agent limited to one subtree writing outside it.

## Decision
- **Who makes rules**: whoever can edit the database (the bar of PUT /collection/fields: member + edit
  lock), in the browser only (`authVia === 'cookie'`, like edit locks; no MCP tool in v1). Members who can
  see the database list rules and their runs; guests do not.
- **Whom a rule runs as**: its author — whoever saved it or turned it on last (turning it off keeps the
  author). Editing someone's rule therefore never borrows their rights. A deleted author account stops
  the rule (failed run).
- **How**: every write action calls the existing REST route through `app.inject` (as the MCP server does),
  authenticated by `x-inkling-automation-run: <token>`: a 256-bit token that lives in an in-process map
  for one action (automations/context.ts, auth.ts). The request is a non-browser client (`authVia
  'bearer'`, no connection scope). So membership, visibility, edit locks (`assertCan`), placement, the row
  cap, person cells, agent hand-offs and two-way relations are checked exactly as for the author's own
  request. Notifications and webhook deliveries have no REST route; they are queued directly, to members
  who can see the row and to hooks registered in the same workspace.
- **The trigger's cap**: an action that writes outside the triggering row (add a row to a database) runs
  only if whoever triggered could make that write: a member with edit access to the target. Refused, with
  the reason in the run log: public form answers, page guests, and agent connections (the run cannot carry
  their range or blocks) unless the target is the rule's own database. Handing a row to an AI connection
  is refused for form answers and guests. Dates have no trigger person: author's rights only.
- Writes on the triggering row itself (set values, assign) are the rule's purpose and run with the
  author's rights for every trigger, including a form answer (a visitor cannot choose those values).
- **What cannot trigger**: writes refused before they happen — read-only tokens, suggest-only connections
  (ADR 2040: row writes are not in `OPEN_WHILE_SUGGEST_ONLY`), locked pages — start nothing. A suggestion
  a person accepts is that person's write.
- Trash: a run whose row is in the trash, deleted or moved out is skipped (recorded); a target database in
  the trash fails the run with the route's 404.

## Alternatives considered
- **Run as the person who triggered**: a public form has no person, a guest's rules would silently do
  nothing, and the author could not rely on the rule (Notion runs as the rule; Airtable as its owner).
- **Run as a system actor**: no permission check left to apply; every action would need its own.
- **Call internal functions instead of REST**: duplicates the permission and side-effect code of a dozen
  routes; the MCP server already proved the inject pattern (ADR 0930).
- **A synthetic session per run**: rows in `sessions`, cookies on inject, and a credential that outlives
  the call if anything goes wrong.

## Trade-offs
- A rule keeps working for others with its author's rights until the author loses them; the run log shows
  who the author is and why a run failed.
- The cap is coarse for agents: a rule started by an agent write cannot add rows to another database.

## Consequences
- apps/server/src/automations/{context,runner}.ts (`triggerMayReach`), auth.ts (one header branch),
  routes/automations.ts. Tests: automations.db.test.ts (guest, public form, agent, read-only token,
  suggest-only, edit lock, author change).
