# 0978. Reserved OAuth client names

- Status: Accepted
- Date: 2026-11-07

## Context
Dynamic client registration lets anyone choose `client_name`. That name is shown in "Connected
agents", in the audit log and change feed ("Alice via <client>") and in the `via` provenance of
agent writes (ADR 0936). A client named "Inkling", "Admin", "System" or after a member would make
agent actions read as system or human actions.

## Decision
- Names are folded before comparison: NFKC, lower case, common look-alikes mapped to Latin
  (Cyrillic/Greek letters, 0→o, 1→i, 3→e, 4→a, 5→s, 7→t, @→a, $→s, !→i, |→i, l→i), and every
  character that is not a letter or digit removed.
- `POST /oauth/register` refuses (400 `invalid_client_metadata`) a name whose folded form equals a
  reserved word: inkling, admin, administrator, system, root, owner, moderator, support, staff,
  관리자, 시스템, 운영자, 잉클링. Names that merely contain them ("Inkling Notes Helper") pass.
- At consent (`POST /oauth/authorize`), a client whose folded name equals the display name of any
  member of the consenting user's workspaces (themselves included) is refused
  (`CLIENT_NAME_RESERVED`). Registration is anonymous and global, so the member check happens where
  the workspaces are known and does not reveal names to a registrant.
- Length and control-character cleanup stay where they were.

## Alternatives considered
- Global uniqueness of client names: collides with legitimate clients registering many times.
- Prefixing every client label in the UI ("App: …"): helps the UI but not the audit log text.

## Trade-offs
- A member whose display name equals a popular client ("Claude") blocks that client for everyone in
  their workspaces until one of them renames (KNOWN-ISSUES).
- Folding `l` to `i` is coarse; it only matters for exact folded matches.

## How others solve it
- Discord: reserved words in application and bot names ("discord", "clyde"), with look-alike checks.
- Slack: app display names cannot impersonate Slack or workspace members; admins approve apps.

## Consequences
- Existing clients keep working; a reserved-name client fails on the next consent.

## References
- apps/server/src/clientName.ts:39, :51
- apps/server/src/routes/oauth.ts:171, :393
