# 2300. Workspace groups and archive are a person's own list, not a state of the workspace

- Status: Accepted
- Date: 2026-11-10

## Context
People who make one workspace per contest or class end up with a long switcher (every workspace on
one level, in creation order) and, since 0.17, with agents whose find_context and search without
workspaceId still read every finished contest. ADR 2187 declined a per-connection default search
workspace; the request here is different: "let me put workspaces aside".

## Decision
- Two things, both **per person**: named **groups** in the switcher ("Contests", "Classes") with an
  order, a fold state and an order of workspaces inside, and **archived** workspaces.
- Archiving changes only what that person sees by default: the workspace moves under a folded
  "Archived" section of their switcher and leaves the default scope of their cross-workspace reads
  (ADR 2303). It stays open and editable to them and to every other member; nobody else is told.
- One click reverses it (per workspace, or "Unarchive all" for a group).
- Workspaces outside any group stay at the top, as before; a person without groups or archived
  workspaces sees the switcher exactly as before plus one menu item, "Organize workspaces…" (ADR 2305).

## Alternatives considered
- **Archive as a workspace state** (set by an owner, for everyone): that is a "closed" workspace,
  read-only for all; it needs roles, audit, notifications and write refusals in every route. Out of
  scope; listed as a candidate in the 0.18 drafts.
- **Shared groups** (a group the team sees): groups are how one person sorts their own list; a team
  layout would need an owner and conflict rules. Candidate only.
- **Hide instead of archive** (gone from the switcher): a hidden workspace is easy to lose; the folded
  section keeps it one click away.

## Consequences
- Migration 0057 (ADR 2301); routes under /api/me (ADR 2302); default scope rules (ADR 2303).

## References
- apps/server/src/workspaceListing.ts, routes/workspaceListing.ts; apps/web/src/components/WorkspaceSwitcherList.tsx, WorkspaceOrganizer.tsx
- docs/adr/2187-*, 2301-* .. 2305-*
