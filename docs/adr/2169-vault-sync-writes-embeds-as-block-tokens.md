# 2169. Vault sync writes embeds as block tokens; the revision carries the Markdown format

- Status: Accepted
- Date: 2026-11-10

## Context
Sync Markdown used the plain notation (ADR 1500), which leaves out page embeds (inline database views
included), link embeds, plugin blocks and charts: plain Markdown has no form for them. A note edited in
the vault and uploaded did not contain them, and the PUT, a minimal edit of the whole document,
deleted them: any vault edit of a page removed its embeds, views, plugin blocks and charts
(`vaultSyncReadiness.db.test.ts`, "blocks Markdown cannot carry"; KNOWN-ISSUES listed it as a
known loss).

## Decision
- Sync Markdown writes those four block types as the one-line block tokens of the agent notation
  (`<!-- inkling:pageEmbed {"pageId":"…"} -->`), produced by the same code that writes them for agents.
  Every import already reads tokens back into the same block, and the minimal edit then recognises
  them as unchanged, so they keep their ids. Obsidian hides HTML comments in reading view. Mentions
  stay `@Label` and file or audio blocks stay links, as before (the CLI maps links to vault files).
- The revision's metadata half now includes a format marker (`md2`). A client holding text in the
  old form has a revision that never matches: its write gets 412 with the current text (with tokens)
  and goes through the three-way merge, so the token lines are merged in instead of the blocks being
  deleted. A DELETE with a pre-0.17 metadata half is accepted when the document half matches (the
  page goes to the trash anyway).

## Alternatives considered
- **Full agent notation for sync**: mentions would become `@[Label](user:<id>)` and file blocks hidden
  tokens in the vault; Obsidian shows the first oddly and the CLI would no longer download the second.
- **Keep blocks the note does not mention** (server-side): a vault user could never delete an embed,
  and the server cannot tell an old note from a deliberate deletion.
- **Obsidian syntax** (`![[Page]]` for page embeds): readable, but `![[…]]` already has a meaning in
  existing vaults (kept as text, ADR 0201), and link embeds, plugin blocks and charts have none.

## Consequences
- Embeds, views, plugin blocks and charts survive vault edits; deleting a token line deletes the block.
- After the upgrade, the first upload of a note last synced by 0.16 merges once with the token form;
  an edit on the line next to an embed gives a conflict copy (nothing is lost).
- Pages with such blocks get a different content hash: the first sync after the upgrade reads them
  again when they change.

## References
- apps/server/src/md/syncMd.ts (`withBlockTokens`), apps/server/src/routes/sync.ts (`SYNC_MD_FORMAT`, DELETE)
- apps/server/src/md/notation.ts (agent notation, ADR 1500)
- apps/server/src/routes/vaultSyncReadiness.db.test.ts (R7, R10)
