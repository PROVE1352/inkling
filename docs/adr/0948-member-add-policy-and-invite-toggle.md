# 0948. Member-add policy and an invite link switch (closes C-M3)

- Status: Accepted
- Date: 2026-11-07

## Context
KNOWN-ISSUES C-M3 (remaining part): any member could add existing users directly with
`POST /workspaces/:id/members`, so a person an owner removed could be re-added by any member.
The invite code was always valid; the only control was regenerating it.

## Decision
- `workspaces.member_add_policy` ∈ `owners | admins | members`, **default `admins`** (owners and
  admins). Checked in `GET member-candidates` and, under the `ws-members:` lock, in
  `POST members` (apps/server/src/routes/workspaces.ts:323, :367).
- `workspaces.invite_link_enabled` (default true). Off: `POST /workspaces/join` and
  `GET /workspaces/invite-preview` answer the same 404 `INVALID_CODE` as a wrong code (the switch
  is not revealed). Join now runs under the member lock and re-reads code + switch, so a
  concurrent removal (which regenerates the code) or switch-off wins (workspaces.ts:210-241).
  When the link is off only owners still receive the code in `WorkspaceDTO.inviteCode`.
- Removing someone still regenerates the code in the same transaction (unchanged).
- Owner-only setting (`PATCH /workspaces/:id/settings`), audited as `settings.updated`.

## Alternatives considered
- Keep "all members" as default: leaves C-M3 open on every existing workspace.
- A block list of removed users: needs its own UI and still lets any member add other people;
  the policy plus regeneration covers the reported abuse.
- Expiring invite links: useful later; the switch covers "stop joins now".

## Trade-offs
- Behaviour change: in existing workspaces plain members can no longer add people until an owner
  chooses "All members".

## How others solve it
- Notion: invite link toggle in Settings → People; member invite restrictions on Enterprise.
  https://www.notion.com/help/add-members-admins-guests-and-groups
- Slack: "who can invite members" setting and invitation approval.

## Consequences
- C-M3 is removed from docs/KNOWN-ISSUES.md.

## References
- apps/server/src/db/schema.ts:199, :201
- apps/server/src/routes/workspaces.ts:210, :270, :323, :367
