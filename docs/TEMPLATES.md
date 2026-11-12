# Templates

A template creates a page — or a whole structure of pages — with its text already laid out.
Open the gallery from **New page ▾ → Start from template** (or the command palette), pick a
template, answer its questions and press **Create**. 한국어: [TEMPLATES.ko.md](TEMPLATES.ko.md).

Design records: [ADR 0920](adr/0920-template-model.md) (model and clean-up),
[0921](adr/0921-structure-templates-atomic-instantiation.md) (structures),
[0922](adr/0922-template-variables.md) (variables),
[0923](adr/0923-templater-compatibility-no-code.md) (Templater),
[0924](adr/0924-template-file-format.md) (files),
[0925](adr/0925-template-gallery-visibility-mcp.md) (gallery, visibility, MCP).

## Kinds of templates

| Kind | What it creates |
|---|---|
| Document | One page with its body. |
| Structure | A page tree: the root page plus sub-pages, folders, databases (fields, views, row templates and optionally starter rows) and canvases. Links between its pages, database relations and canvas cards point at the new pages. |

A database's own [row templates](#row-templates) are a separate thing: they fill in a new row
of that database.

### Built-in templates

Built-ins are part of the app (they improve with updates and cannot be deleted). They exist in
English and Korean; you get the one matching your language.

| Template | Category | Kind | Contents |
|---|---|---|---|
| Meeting notes | Meetings | Document | Goal, attendees, agenda, notes, decisions, action items, open questions. Dated (shows on the calendar). |
| Daily standup | Meetings | Document | Yesterday / today / blockers per person. Dated. |
| Meeting series | Meetings | Structure (3) | Purpose and standing agenda page + a **Meetings** database (table and calendar views) with the first meeting. |
| Project | Projects | Structure (7) | Overview page + **Tasks** database (board by status, table, calendar; Status, Owner, Due, Priority) with three starter tasks + **Meeting notes** folder with a kickoff page. Asks for the goal and target date. |
| Project kickoff | Projects | Document | Why, goals, scope, milestones, team, risks, working agreements. |
| Brainstorm | Docs | Document | Question, constraints, ground rules, ideas, themes, shortlist, next steps. |
| Retrospective (KPT) | Docs | Document | Keep / Problem / Try and action items. Asks which period you are looking back on. |
| Reading list | Personal | Structure (2) | A database with a gallery "shelf", a board by status and a table; asks what you are reading now and creates its notes page. |
| Weekly review | Personal | Structure (9) | Review page titled with the ISO week + a **Habits** table with a row per weekday. |

### Your own templates

**Save as template** is in a page's ⋯ menu and in the right panel. Choose a name, icon,
description and category, and whether to include:

- **Sub-pages, databases and canvases** under the page (otherwise only the page itself is saved);
- **Database rows** as starter rows (otherwise databases keep their fields and views but start empty).

A template saved from a private page is private (only you see it). For other pages you can tick
**Only me**. Everyone else in the workspace sees shared templates. The creator and workspace
owners can delete a template.

The template is a snapshot: later edits to the original pages do not change it. People and
person properties are not saved in templates. Images and files stay as links to the original
attachments.

## Variables

Variables are written in the text and filled in when a page is created (on the server, at that
moment). They work in page bodies, page titles, canvas text cards and text values of database
rows.

| Variable | Becomes | Example |
|---|---|---|
| `{{title}}` | Title of the created root page | `Apollo` |
| `{{date}}` | The date, `YYYY-MM-DD` | `2026-11-07` |
| `{{date:FORMAT}}` | The date in a format (see below) | `{{date:dddd, MMMM D}}` → `Saturday, November 7` |
| `{{time}}`, `{{time:FORMAT}}` | Current time (`HH:mm` by default) | `09:05` |
| `{{weekday}}` | Day of the week, in your language | `Saturday` / `토요일` |
| `{{author}}` | Your name | `Ada` |
| `{{workspace}}` | Workspace name | `Acme` |
| `{{input:Question\|default}}` | Your answer to a question asked before creating; the default when left empty | `{{input:Target date\|TBD}}` |
| `{{cursor}}` | Removed; the caret is placed here when the page opens | |

- **Date and time** use your device's time zone (the server's `TZ` if the client sends none). For
  dated templates the gallery shows a date field; `{{date}}` follows it.
- **Inputs** with the same question are asked once. Each occurrence falls back to its own default.
  Answers are inserted as plain text.
- **Cursor**: the first `{{cursor}}` of the first page that has one counts; others are removed.
- **Unknown variables stay as written** (`{{mood}}` is left alone), so the syntax can't eat text.
- **Formatting is kept.** Substitution happens inside one run of text with the same formatting,
  so `**{{author}}**` stays bold and link targets are untouched. A variable split across two
  formats (half bold) is not recognised. Inline code and code blocks are never substituted — use
  them to write about template syntax.

### Date format tokens

Moment.js-compatible subset: `YYYY` `YY` · `MMMM` `MMM` `MM` `M` · `DD` `D` `Do` · `dddd` `ddd`
`dd` `d` · `HH` `H` `hh` `h` · `mm` `m` · `ss` `s` · `A` `a` · `W` `WW` (ISO week) `GGGG` (ISO
week year). Text in `[brackets]` is copied literally. Month and weekday names follow your
language (`MMMM` → `November` / `11월`).

| Format | en | ko |
|---|---|---|
| `{{date:YYYY-MM-DD}}` | 2026-11-07 | 2026-11-07 |
| `{{date:MMMM D, YYYY}}` | November 7, 2026 | 11월 7, 2026 |
| `{{date:YYYY년 M월 D일 dddd}}` | — | 2026년 11월 7일 토요일 |
| `{{date:GGGG-[W]WW}}` | 2026-W45 | 2026-W45 |
| `{{time:h:mm A}}` | 9:05 AM | 9:05 오전 |

## Obsidian Templater compatibility

Templates copied from an Obsidian vault keep working for the most common Templater tags. They
are **rewritten** to the variables above, never executed:

| Templater | Inkling |
|---|---|
| `<% tp.date.now() %>` | `{{date}}` |
| `<% tp.date.now("FORMAT") %>` | `{{date:FORMAT}}` |
| `<% tp.date.now("FORMAT", 7) %>` | the date 7 days later (negative offsets go back) |
| `<% tp.file.title %>` | `{{title}}` |
| `<% tp.file.cursor() %>` | `{{cursor}}` |

Everything else — `<%* … %>` blocks, `tp.system.prompt`, `tp.user.*`, `tp.web.*`, other `tp.file`
functions — stays as plain text. Inkling does not run code from templates (they are shared
between members and imported from files); use `{{input:…}}` instead of `tp.system.prompt`.

## Files: export and import

The gallery exports any template (built-ins too) and imports `.md` and `.zip` files. Imports go
through the same limits and converters as page imports (25 MB per file, 50 MB unpacked, 300
entries, at most 200 pages and 12 levels in one template).

### Document template: Markdown

```markdown
---
inkling-template: 1
name: "Meeting notes"
description: "Goal, agenda, decisions and action items for one meeting"
category: meetings
icon: "📋"
with-date: true
variables:
  - "Which period are you looking back on?|This sprint"
---
**When:** {{date:MMMM D, YYYY}} ({{weekday}}), {{time}} · **Notes by:** {{author}}

## Agenda

1. {{cursor}}
```

- Keys are flat (no nested maps). `category` is one of `docs`, `projects`, `meetings`,
  `personal`, `custom` (anything else imports as `custom`). `variables` lists the input questions
  as `Question|default`; it is informational — the questions are read from the body.
- Any Markdown file without this frontmatter imports as a document template named after the file,
  so an Obsidian template folder can be imported file by file.

### Structure template: zip

```
inkling-template.json
pages/p0.md
pages/p3.md
pages/p5.canvas
```

`inkling-template.json`:

```json
{
  "inkling-template": 1,
  "name": "Project",
  "description": "…",
  "category": "projects",
  "icon": "🚀",
  "withDate": false,
  "variables": ["Target date|TBD"],
  "root": {
    "ref": "p0", "kind": "doc", "title": "Project", "icon": "🚀", "file": "pages/p0.md",
    "children": [
      {
        "ref": "p1", "kind": "collection", "title": "Tasks",
        "fields": [{ "id": "status", "name": "Status", "type": "select", "options": [ … ] },
                   { "id": "parent", "name": "Parent", "type": "relation", "relation": { "targetPageId": "p1" } }],
        "views": [{ "name": "Board", "type": "board", "config": { "groupByFieldId": "status" } }],
        "children": [
          { "ref": "p2", "kind": "doc", "title": "Write the brief", "file": "pages/p2.md",
            "props": { "status": "todo", "parent": ["p2"] }, "children": [] }
        ]
      }
    ]
  }
}
```

- `kind` is `doc`, `folder`, `collection` or `canvas`. Documents point at a Markdown file,
  canvases at a JSON Canvas (`.canvas`) file whose file cards use another page's `ref` as `file`.
- Pages refer to each other by `ref` (`p0`, `p1`, …), never by database id: relation targets,
  relation values in `props`, canvas cards. `[[Title]]` links in Markdown resolve to the
  template's own pages first, then to pages of the workspace you import into that you can see.
- Fields and views use the same shapes as the API (`CollectionField`, `ViewConfig`). A relation
  whose target is not in the template imports as a text field; person values are dropped.

## Row templates

A database can keep up to 20 row templates for its **New row** button. A row template has a
name and icon, a **title** pattern, **property values** and a **body**, and one of them can be the
default. Design records: [ADR 1180](adr/1180-row-templates-stored-apart-from-pages.md) (model),
[1181](adr/1181-one-create-path-for-rows.md) (creating rows, values),
[1182](adr/1182-row-template-editor-on-a-local-document.md) (editor),
[1183](adr/1183-row-templates-in-copies-and-files.md) (copies and files),
[1184](adr/1184-row-template-permissions-and-leaks.md) (permissions).

- **New row** uses the default template, or makes an empty row when there is none. **▾** next to
  it picks a template or **Empty row**. The board's **+** in a column and the calendar's **+** on a
  day use the default too; the column's value or the day's date is applied on top of the template.
- The template's icon becomes the row's icon. A title typed when creating the row wins over the
  title pattern.
- The title, text and URL values and the body use the [variables](#variables) above. `{{title}}`
  is the row's title. `{{input:…}}` prompts are asked before the row is created (MCP clients pass
  `inputs`). Variables are filled when a row is created, never when the template is saved or
  copied.

Property values are stored like row values, with two relative forms:

| Property | Template value | Becomes |
|---|---|---|
| Date | `today`, `today+7`, `today-1` or `2026-12-01` | The creator's date (their time zone), shifted by the days |
| Person | `me` or a member | `me` is whoever adds the row |
| Select, multi-select | Option ids | The same options |
| Text, URL | Text with variables | The rendered text |
| Number, checkbox | The value | The same value |
| Relation, rollup | not available | Set on each row |

A value that no longer fits (a deleted option, a field that changed type, a person who left the
workspace) is dropped when the row is created; the row is still created.

Editing opens the template like a page: the same editor, with the property values above the
body. Changes save as you type. Anyone who can see the database can use its templates; creating,
editing, deleting and choosing the default need edit access to the database, and its
[edit lock](GUIDE.md#edit-lock) applies. Row templates are not pages, so they never appear in search,
backlinks, query blocks, the graph, the sidebar, webhooks or MCP page lists.

**Copies.** Duplicating a database copies its row templates. **Save as template** keeps them
with the database (person values other than `me` are dropped, as for rows), and creating a page
from that template gives the new database the same row templates. Template files carry them in
`inkling-template.json` (below). The workspace Markdown export does not include them, the same as
views.

```json
{
  "ref": "p1", "kind": "collection", "title": "Meetings",
  "fields": [ … ], "views": [ … ],
  "rowTemplates": [
    { "name": "Weekly", "icon": "📋", "title": "{{date}} {{input:Topic|Weekly}} meeting",
      "props": { "status": "plan", "date": "today", "owner": "me" },
      "default": true, "file": "pages/p1-t0.md" }
  ],
  "children": [ … ]
}
```

## API and MCP

REST routes are listed in [API.md → Templates](API.md#templates). MCP clients get
`list_templates` and `create_from_template` ([MCP.md](MCP.md)).

Row templates: `GET`/`POST /api/pages/:id/collection/row-templates`, `GET`/`PATCH`/`DELETE
/api/collection-row-templates/:id`, and `POST /api/pages/:id/collection/rows` to create one row
(`template` omitted → the default, `null` → an empty row). MCP `create_row` takes `template` (a
name or id, or `"none"`) and `inputs`; `query_rows` with `describe: true` lists the templates.
