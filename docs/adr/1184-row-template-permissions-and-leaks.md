# 1184. Row template permissions follow the database; what a template can carry into a row

- Status: Accepted
- Date: 2026-11-07

## Context
Templates are written by one person and applied by others, so two questions: who may change them,
and whether a template can put something into a new row that its creator could not see.

## Decision
- **Reading and using** a template requires seeing its database: every route resolves the database
  with `findVisiblePage` + membership (`requireCollectionPage`); a template of a private database is
  404 for everyone else, like the database.
- **Creating, editing, deleting and choosing the default** require editing the database:
  `assertPageEditable(collectionId)` after the membership check, the rule fields and views use, so
  an edit lock (ADR 0970, 0971) and agent rules apply the same way. Writes on one database are
  serialized with `SELECT … FROM collections … FOR UPDATE` (cap, order, default).
- **Creating a row** goes through `assertPlacement` under the tree lock (the database must be
  editable for the person or agent), with `publicRule: false` as in the batch route: a new row adds
  nothing to a public share that the database's rows did not already expose.
- **What a template carries** was reviewed:
  - Relation values: none (no relation defaults), so a template cannot link a row the creator cannot
    see.
  - Person values: `me` or member ids; non-members are rejected when saved and dropped when used.
  - Files in the body: uploaded against the database page, served only to people who can see it.
    A `/files/<id>` URL copied from another page still checks that page's visibility when read.
  - Links, page mentions and page embeds to other pages: the target is checked when it is read, as
    anywhere. What can show is the text the template's author typed, and a page mention's label,
    which is the title at the time it was inserted. This is the same as writing that text in the
    database page itself, and only people who can edit the database can put it there; everyone who
    can see the database can already read the template. Nothing is filtered at use.
  - Structure templates drop person values other than `me` (ADR 1183); a template saved from a
    private page is private, as before.
- MCP: template names and prompts in `query_rows describe` and `create_row` output go through
  `cleanText` (ADR 0976); ids stay outside.

## Alternatives considered
- **Templates visible only to editors**: would hide a template body from people who can see the
  database but not edit it, yet every row made from the template shows them the same content;
  rejected.
- **Strip mentions and links to pages the row's creator cannot see**: would make a row differ by who
  created it and still not hide the typed text; rejected in favour of read-time checks.

## Trade-offs
- A person who can edit the database can change what every new row starts with; there is no
  separate "template editor" right.

## Consequences
- Tests (`rowTemplates.db.test.ts`): private database → 404 on list/read/update/create; locked
  database → 403 `PAGE_LOCKED` on template writes and row creation for a non-editor, owner allowed;
  templates absent from search, the gallery list, `from-template` and `DELETE /templates/:id`.
