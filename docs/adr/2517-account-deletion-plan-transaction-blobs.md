# 2517. Account deletion: one function, plan then one transaction, names scrubbed

- Status: Accepted
- Date: 2026-11-12

## Context
Leaving, the account lifetime and the admin's forced deletion all delete accounts. Content of shared
workspaces must stay for the other members, but the person's name and sign-in ID must not: several
tables copy them as text, and some uuid columns have no foreign key.

## Decision
- `deleteAccount(userId, { by })` (`account/deletion.ts`): `planAccountDeletion` (also the preview and
  the dry run) → one transaction under the admin lock → upload blobs unlinked after the commit.
- `admin` keeps 0.21.1: 409 `SOLE_OWNER`, private pages to the trash, the signup key's use given back.
- `self` and `expiry`: workspaces where the person is the only member (or deleted and solely theirs)
  are purged with their files; a sole-owned shared workspace passes to the oldest admin-role member,
  else the oldest member, who gets a `workspace_owner` notification (even past
  LIMIT_WORKSPACES_PER_USER); private pages and private templates are purged everywhere; shared pages,
  comments and versions stay with their author columns set to null (the foreign keys).
- Scrubbed in the same transaction: `page_changes` (private-page entries deleted, `actor_id` nulled:
  no foreign key), `workspace_audit_events` (`actor_name`, labels of rows about the person, JSON values
  equal to the name or ID in workspaces the person was in or appears in), the workspace made at
  sign-up named after the person (renamed "Workspace"), invitations addressed to the person.
- Sessions, tokens, OAuth grants, push subscriptions, 2FA, consent records and the rest cascade with
  the users row. Open collaboration sockets and the inbox channel are closed after the commit.

## Consequences
- A test scans every text, varchar, array and jsonb column for the name and ID, and every uuid column
  for the id, after a deletion by the person and by expiry: none remain.
- Kept: mentions other members wrote (the label in their documents), text members typed themselves,
  the uuid inside `workspace_audit_events.target_id` of rows about the person (no name), outbox
  payloads (ids only, purged by their own retention), `page_mentions.user_ids` of other members' pages,
  and the admin path's audit names.
