# 2577. Restore and split follow the agent edit policy; a grace-period accept needs a live connection

- Status: Accepted
- Date: 2026-11-26

## Context
The agent edit policy (docs/adr/1544-*, 1545-*) turns agent edits into suggestions under "auto" and
"review", but only patch_section, patch_sections and update_page consulted it. `restore_version` and
`split_page` rewrote the page at once under any policy (C-mcp M5). The grace-period sweeper accepted
a suggestion even when its connection had been revoked or blocked meanwhile (C-mcp L2).

## Decision
- `POST /pages/:id/snapshots/:sid/restore` and `POST /pages/:id/split` (not its preview) refuse an agent
  request when the page's effective policy (lock node, else the workspace default) is not direct:
  403 `PAGE_LOCKED`, naming the policy and telling the agent that a person does it in the web app or that
  it can leave a suggestion with patch_section / update_page. People's requests are unchanged.
- `runAutoAccepts` checks, before applying, that the suggestion's connection is still live in its
  workspace (`connectionLiveSql`: not revoked or expired, member, in range, not blocked). Otherwise the
  suggestion stays open for a person with the reason. Rows without a connection key are not checked.

## Consequences
- Under "auto" or "review" an agent can no longer undo people's work by restoring an old version.
- An agent asked by its person to restore under such a policy must ask the person to do it.
- Suggestions of a revoked connection that were already accepted stay accepted.
