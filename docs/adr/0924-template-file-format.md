# 0924. Template files: Markdown with flat frontmatter, zip with a manifest for structures

- Status: Accepted
- Date: 2026-11-07

## Decision
- **Document template → `.md`.** Frontmatter keys are flat because the server's frontmatter reader
  is a YAML subset without nested maps (`md/syncMd.ts`): `inkling-template: 1`, `name`,
  `description`, `category`, `icon`, `with-date`, `variables` (a list of `Question|default`,
  informational). Body = the regular Markdown export with variables left as written. A Markdown
  file without the marker imports as a template named after the file (Obsidian template folders).
- **Structure template → `.zip`:** `inkling-template.json` (meta + page tree: kind, title, icon,
  file, row props, collection fields/views) and `pages/<ref>.md` / `pages/<ref>.canvas`. Pages
  refer to each other by `ref` (`p0`, `p1`, …), never by database ids. Internal links are exported
  as `[[Target title]]`.
- **Import reuses the page-import path and limits:** 25 MB upload, `readZipEntryCapped` metering
  (25 MB per entry, 50 MB unpacked), 300 entries; Markdown through `markdownToBlocks` with a title
  resolver that sees only the template's pages and pages visible to the importer (ADR 0756);
  canvases through `canvasJsonToState`. Manifest validated with zod (`collectionFieldSchema`,
  `viewConfigSchema`); unknown fields, person values and relations leaving the template are
  dropped or downgraded to text. Block JSON or Yjs state is never accepted from a file.
- Built-ins can be exported too, so they can be customised and re-imported.

## Trade-offs
Markdown is lossy for blocks without a Markdown form (callouts become quotes, like page export).
Attachments are not bundled; image links keep their `/files/<id>` paths.
