# 1862. Team agents board

- Status: Accepted
- Date: 2026-11-10

## Context
With several people's agents in one workspace, people want to see at a glance who is working on
what: which sections are claimed and for how long, which suggestions wait, and what each agent did
today. The data exists (section_leases, section_suggestions, page_changes, revert audit events) but
only per page.

## Decision
- `GET /workspaces/:id/team-agents?since=` (members only; guests refused) returns, grouped by person:
  live claims with seconds left (database clock), open suggestions (newest 100), and per agent the
  edits, new pages, suggestions made, changes reverted by a person, and the five most recent pages
  since `since` (the viewer's start of day; default 24 hours, at most 7 days).
- Activity is grouped by (person, client name), because `page_changes` records the client name, not
  the grant. Claims and suggestions carry the connection; an agent row lists the live connection keys
  with that name. Two connections of one person with the same client name show as one row.
- Pages the viewer cannot see now (deleted, someone else's private page, outside a range) are
  `hidden`: no title and no section anchor; counts still include them. People's names and client
  names are shown as members already see them in the member list and "Connected agents".
- `GET /workspaces/:id/agent-connections` lists the members' live connections (ADR 1860) for the
  mention and assignee pickers.
- The web page lives at `/w/:wsId/team-agents`, linked from the Activity view header.

## Alternatives considered
- **A `connection` column on page_changes**: exact per-grant counts, but it touches the change log's
  merge rules and every writer for a display detail; deferred.
- **A sidebar menu entry**: the sidebar menu list is shared with the per-user menu preferences; a link
  from Activity reaches the same people with no preference migration.

## References
- apps/server/src/teamAgents.ts (readTeamAgents), apps/server/src/routes/teamAgents.ts,
  apps/web/src/pages/TeamAgentsView.tsx
