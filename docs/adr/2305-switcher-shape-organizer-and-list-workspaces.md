# 2305. Switcher shape, the organizer, list_workspaces fields; group names are not workspace arguments

- Status: Accepted
- Date: 2026-11-10

## Context
Most people have one to three workspaces and should not notice the feature. People with many need
groups and an archive both in the switcher and in Settings, on a phone too. Agents should see the
grouping without a new tool.

## Decision
- **Switcher** (`WorkspaceSwitcherList`): without groups and archived workspaces, the old list exactly
  plus one menu item "Organize workspaces…". With them: ungrouped first, then each group under a
  foldable head (the fold is saved on the account; a folded group still shows the open workspace),
  then "Archived (n)", folded unless the open workspace is archived. Order inside a part: stored
  position, then the server's order. The command palette and the start page follow the same order
  (`lib/workspaceListing.ts`); the start page never lands on an archived workspace unless it was the
  last one used or all are archived. There is no keyboard shortcut per workspace to align.
- **Organizer** (`WorkspaceOrganizer`), in a dialog from the switcher and in Settings › Sidebar: groups
  (add, rename, ↑/↓, archive all / unarchive all, delete), workspaces per group with the sidebar
  settings' sortable rows (drag handle and ↑/↓, ADR 1020) inside a group, a select to move to another
  group, an archive button; the archived list with "Unarchive". Dragging across groups is not offered:
  the sortable pattern of the sidebar settings is one list per context.
- **list_workspaces** prints `"group": "<name>"` and `"archived": true` only where set; the list order
  is unchanged (search and list_workspaces print in it, ADR 1543). GET /workspaces adds `listing`.
- **Group names as workspaceId** (search one group) are not accepted. Weighed against ADR 2187: the
  "hidden state" objection does not apply (the agent names the group in the call), but
  `idArg('workspace')` is shared by write tools and resolves to exactly one workspace (ADR 2186); a
  group argument needs its own parameter and its own range rules. Candidate in the 0.18 drafts.

## Consequences
- i18n in `en/ko/workspace-groups.ts`; WorkspaceSwitcher.tsx and Settings.tsx gain a few lines.
- Browser check: w18-browser/wsgroup/check.mjs (desktop and a 390 px phone).

## References
- apps/web/src/components/WorkspaceSwitcherList.tsx, WorkspaceOrganizer.tsx, lib/workspaceListing.ts (+ test), workspaceListingApi.ts
