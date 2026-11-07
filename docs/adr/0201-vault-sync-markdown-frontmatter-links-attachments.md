# 0201. Vault sync markdown: frontmatter, wikilinks and attachments

- Status: Accepted (experimental `vault-sync`)
- Date: 2026-11-07

## Context
The existing export writes only `inkling-id`/`updated` frontmatter and drops page properties,
tags and aliases; import strips frontmatter entirely. Wikilinks are stored as links by page id and
exported as `[[shown text]]`, which no longer resolves after the target is renamed. Attachments
live behind `/files/<id>` with per-page visibility.

## Decision
- **Frontmatter is part of the synced content** (`md/syncMd.ts`). Rendered: `inkling-id`, then
  `aliases`, `tags` (list, no `#`), then every page property by name — checkbox → bool, number →
  number, date → unquoted `YYYY-MM-DD`, tags → list, others → string (quoted when YAML would read
  it as another type). `updated:` is not written (it would change the hash on metadata-only
  saves). The internal `fullWidth` property is never exported and always kept.
- **Parsing** is a hand-written YAML subset (no dependency): `key: scalar`, quoted keys/values,
  flow lists `[a, b]`, block lists `- a`, comments. Nested maps and block scalars (`|`, `>`) are
  reported back as `droppedFrontmatterKeys` and not stored. Existing properties keep their id and
  type when the new value still fits; otherwise the type is re-inferred. Keys missing from the
  file are removed (the file is the source of truth for user-visible properties); a note without
  any frontmatter block leaves properties untouched.
- **Wikilinks export by current title**: `[[Current Title]]`, or `[[Current Title|shown text]]`
  when the visible text differs (only titles the reader may see are used). Import resolves
  `[[Title|shown]]` and `[[Title#Heading]]` by the title part and keeps `shown` as link text.
- **Attachments**: the server keeps `/files/<id>` URLs; the CLI maps them to
  `assets/<fileId><ext>` with relative links per note, downloading missing files. Local links to
  vault files and Obsidian `![[file.png]]` embeds (resolved shortest-path-first, like Obsidian) are
  uploaded with `pageId` set (so private pages keep private attachments), deduplicated by SHA-256,
  and rewritten to `/files/<id>`. Types outside the server allow-list stay as plain relative links.

## Obsidian syntax that does not round-trip losslessly (verified in smoke)
| Syntax | Result in Inkling | Back in the vault |
|---|---|---|
| Callout `> [!note] Title` | quote block; text kept | `> [!note] Title\` + `>  body` — Obsidian still shows a callout, title line gets a trailing `\` |
| Page embed `![[Page]]` | paragraph text `![[Page]]` (not a live embed) | unchanged text |
| File embed `![[img.png]]` | image block | `![img.png](assets/<id>.png)` (standard markdown) |
| `==highlight==`, `%%comment%%`, `$$math$$` | literal text | unchanged |
| Soft line breaks inside a paragraph | hard breaks | `line\` + newline (renders the same with Obsidian's default "strict line breaks: off") |
| `-` / `_x_` / `\| a \| b \|` | normalized | `*` bullets, `*x*`, padded tables |
| Inline fields `key:: value`, nested frontmatter maps | text / dropped | as above |
| Callout/mention/page-embed blocks created in the web editor | not in the server schema | dropped from the markdown (pre-existing limitation of export) |

## Alternatives considered
- A YAML library — new dependency (not allowed in this phase) and a larger parser attack surface
  for a format we only need a subset of.
- Exporting links as `[[pageId]]` or `inkling://` URLs — stable, but unreadable in Obsidian.
- Storing attachments under their original names — collisions across notes; id-based names make
  the server → vault mapping deterministic.

## Trade-offs
- Removing properties absent from the file means a user who deletes a frontmatter line deletes
  the property — intended, but different from "plain note keeps properties".
- `[[Title|shown]]` appears after a server-side rename of the target; it is correct Obsidian
  syntax but noisier than before.

## How others solve it
- Obsidian itself rewrites `[[links]]` in all files on rename; our server-side equivalent is the
  current-title export plus the referrer re-sync described in ADR 0200.
- Logseq keeps properties as `key:: value` blocks; Obsidian Dataview reads both frontmatter and
  inline fields. We support frontmatter only.

## Consequences
- Tags written in frontmatter appear in `file.tags` / `FROM #tag` queries (ADR 0203) and in the
  page property panel; inline `#tags` keep coming from the text index.

## References
- apps/server/src/md/syncMd.ts (`renderFrontmatter`, `parseFrontmatter`, `frontmatterToMeta`, `exportWikiLinks`, `wikiTitleResolver`)
- apps/server/src/md/convert.ts:220 (`blocksToMarkdown`, the generic `[[shown text]]` export)
- apps/server/src/md/importer.ts:57 (`buildTitleResolver`)
- apps/cli/src/commands/sync.ts (`toLocal`, `toServer`)
- apps/server/src/routes/files.ts:31 (upload allow-list mirrored in apps/cli/src/sync/vault.ts)
