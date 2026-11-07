# 0920. Template model: one tree format for documents and structures; legacy paths removed

- Status: Accepted
- Date: 2026-11-07

## Context
Review of templates before the public release found:
1. **Two template systems.** The gallery (`templates` table, `POST /pages/from-template`) created
   one document. In parallel, `pages.is_template` + `POST /pages/:id/instantiate` copied a page
   subtree. The UI toggle for `is_template` was removed on 2026-09-23 and nothing called
   `instantiate`, but `PATCH /pages/:id` still accepted `isTemplate`, `PageMetaDTO` still carried
   it, and pages flagged `'1'` are excluded from query blocks, public folder shares and webhooks
   with no way left to unflag them.
2. **Two substitution implementations** with different variable sets (`from-template`:
   date/time/author/title; `instantiate`: date/time/title), both using server-local time.
3. **Lossy and kind-blind saving.** "Save as template" stored `stateToBlocks(page)`: unknown blocks
   (callouts) were silently dropped (`stateToBlocks` skips them without an error), a collection or
   canvas page produced an empty *document* template, and sub-pages were ignored.
4. A private template could only come from a private page — no "only me" for other pages.
5. No categories, search, preview, file export/import or MCP access; built-in copy was partly
   translated phrasing ("발산-수렴", "액션 아이템").
6. Duplicate (and the removed instantiate) do not rewrite links/relations inside the copied tree;
   copies still point at the originals (unchanged here, noted for a follow-up).
7. Daily notes do not use templates: the client creates a page titled `YYYY-MM-DD` via
   `createPage` (ADR 0904). A per-workspace "daily note template" would be one setting on top of
   this model; it is out of scope.

## Decision
- **One model** (`apps/server/src/templates/structure.ts`): a template is a tree of nodes
  `{ id, kind: doc|folder|collection|canvas, title, icon, state?, props?, properties?, fields?,
  views?, children }`. Document and canvas bodies are stored as their **Yjs state** (base64), so
  everything the editor stored survives, including blocks the server schema does not know.
- **Storage without a migration.** `templates.content` is jsonb: an **array** is a legacy
  single-document template (blocks), an object `{ v: 2, root }` is a tree. Meta lives in
  `default_props` (`withDate`, `category`, `kind`, `pageCount`, `inputs` — computed at save time;
  rows without it get it derived on read). Existing rows keep working unchanged.
- **Built-ins** are spec trees in code (Markdown bodies, collection fields/views/rows), compiled
  once per key and language into the same model and instantiated by the same function.
- **Removed:** `POST /pages/:id/instantiate`, `isTemplate` in `updatePageSchema`/`PageMetaDTO`.
  The column `pages.is_template` stays (never written any more); the query/public/webhook filters
  keep hiding the few legacy rows flagged `'1'`, so nothing that was hidden becomes visible or
  public by surprise. Proposed follow-up migration: `UPDATE pages SET is_template = '0'` after
  notifying owners, then drop the column and the three filters.

## Trade-offs
- Yjs states in jsonb are ~33% larger than bytea and the list query must not select them: it
  reads only meta columns (legacy rows' content is selected only when their meta is missing).
- Saved templates are snapshots; editing the source pages does not update them.
- Attachments are referenced, not copied: deleting the original file breaks a template image.
