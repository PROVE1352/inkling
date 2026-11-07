# 1183. Row templates travel with their database in copies and template files, not in exports

- Status: Accepted
- Date: 2026-11-07

## Context
A database is copied by **Duplicate**, saved by **Save as template** (a structure template, ADR
0921), written to template files (ADR 0924) and exported as Markdown with the workspace (zip). Each
path has to either carry row templates or leave them out on purpose.

## Decision
- **Duplicate** (`POST /pages/:id/duplicate`) copies the templates of every copied database inside
  Postgres (`copyRowTemplates`: `INSERT … SELECT` over an old → new id map), next to fields and
  views. Values are kept as they are (same workspace); body links keep pointing at the originals,
  as in the copied pages.
- **Structure templates**: `TNode.rowTemplates` (`{ name, icon, title, props, state?, isDefault }`)
  on collection nodes. `snapshotTree` reads them with the fields; person values other than `me` are
  dropped, as person values of rows are. `instantiateTree` inserts them in its transaction; internal
  links in their bodies are remapped to the new pages like any page body, but their variables are
  left as written: they belong to the rows created later, so `deriveMeta` does not list their
  `{{input:…}}` prompts and the gallery does not ask them.
- **Template files**: the manifest's collection node gets `rowTemplates: [{ name, icon, title,
  props, default, file }]`, the body as `pages/<ref>-t<n>.md` (the same Markdown conversion as page
  bodies). Import validates values against the imported fields (`sanitizeTemplateProps`), drops
  person ids other than `me` and keeps at most one default.
- **Workspace Markdown export / import**: not included. That export writes a database as a GFM
  table of its rows and does not keep fields' configuration or views either; row templates follow
  views. Notion imports bring none.

## Alternatives considered
- **Leave them out of structure templates**: a "Meetings" database saved as a template would lose
  the part that makes it useful; rejected.
- **Export row templates in the workspace zip** (e.g. a `.templates/` folder): would be the only
  database configuration in that export and has no importer counterpart; rejected until the export
  carries database configuration at all.

## Trade-offs
- A template file's row template bodies pass through Markdown, so blocks without a Markdown form
  are lost there, as they are for page bodies in template files. Duplicate and Save as template keep
  the Yjs state.

## Consequences
- Template files written before this change import unchanged (`rowTemplates` is optional).
