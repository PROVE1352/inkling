# Query blocks

A **Query block** shows a live table or list of pages, written in a subset of the
[Obsidian Dataview](https://blacksmithgu.github.io/obsidian-dataview/) query language.

Insert one with **/ → Query**. The block is a code block whose language is `dataview`; the
results render underneath and refresh when pages in the workspace change. Because it is a plain
` ```dataview ` fence, the query survives markdown export, the MCP connector and vault sync
unchanged — an Obsidian vault with the Dataview plugin runs the same query.

```dataview
TABLE status, due, file.tags
FROM #project AND "Work/Clients"
WHERE status != "done" AND due < date(today)
SORT due ASC
LIMIT 50
```

## Query shape

```
TABLE [WITHOUT ID] <expr> [AS "Label"], …   |   LIST [<expr>]   |   TASK
[FROM <source>]
[WHERE <expr>]
[SORT <expr> [ASC|DESC], …]
[LIMIT <n>]
```

* Keywords are case-insensitive. `FROM` must come first; `WHERE`, `SORT`, `LIMIT` may appear in
  any order, each at most once.
* `TABLE` shows a page-link column first unless `WITHOUT ID` is given.
* `LIST <expr>` shows the value next to each page link.
* `TASK` lists checklist items **that carry a date** (the `page_tasks` index — the same items the
  calendar and the due view show). Undated checklist items are not indexed and do not appear.

## Sources (`FROM`)

| Source | Matches |
|---|---|
| `#tag` | pages with the tag in their text or in a `tags` property. Case-insensitive; `#a` also matches nested `#a/b`. |
| `"Folder/Sub"` | pages anywhere below that page path (titles joined by `/`, as in the sidebar tree), plus the page at that exact path |
| `[[Page]]` | pages that link **to** `Page` |
| `-src`, `NOT src` | negation |
| `a AND b`, `a OR b`, `( … )` | combinations |

Without `FROM`, every document page you can see in the workspace is considered.

## Fields

| Field | Value |
|---|---|
| `file.name`, `file.link` | page title |
| `file.ctime`, `file.mtime` | created / last modified (timestamp) |
| `file.cday`, `file.mday` | created / modified date (`YYYY-MM-DD`, in your time zone) |
| `file.tags` | list of `#tags` (text tags and the `tags` property) |
| `file.folder` | path of the parent (`Work/Clients`), `""` at the root |
| `file.path` | path of the page itself |
| any other name | the page **property** with that name (case-insensitive), else — for collection rows — the **collection field** with that name. Select options show their label. |
| `` `Name with spaces` `` | back-ticks quote a property name |
| `text`, `due`, `completed` / `checked` | **TASK only**: the item text, its date, its check state |

## Expressions

* Literals: `"text"`, `42`, `3.5`, `true`, `false`, `null`
* Dates: `date(today)`, `date(tomorrow)`, `date(yesterday)`, `date("2026-11-07")`.
  `today` is the viewer's local date.
* Comparison: `=` `!=` `<` `<=` `>` `>=`
  * `field = "x"` is also true when the field is a **list** containing `"x"`.
  * Comparing with a number compares numerically (numeric strings count).
  * Comparing with a date compares the `YYYY-MM-DD` part; `file.ctime` / `file.mtime` compare
    against local midnight of that date.
* `contains(list, "x")` — list membership, or substring for text values.
* Boolean: `AND` / `&&`, `OR` / `||`, `NOT` / `!`, parentheses. A bare field is true when it is
  set and not `false`, `0`, `""` or `[]`.

## Limits

| Limit | Value |
|---|---|
| query length | 2 000 characters, 400 tokens, nesting depth 24 |
| columns / sort keys | 20 / 5 |
| rows | `LIMIT` ≤ 500 (default 200); the block says when results were cut off |
| execution | 3 s statement timeout — narrow the query with `FROM` / `WHERE` if it is hit |

Results only include pages you are allowed to see (shared pages and your own private pages);
trashed pages and templates are excluded.

## Errors

Syntax errors are shown inside the block with the line, column and a caret under the problem.
The same parser runs in the browser and on the server (`packages/shared/src/query.ts`).

## Differences from Dataview

Not supported: `CALENDAR` queries, `GROUP BY`, `FLATTEN`, inline fields (`key:: value`),
arithmetic, durations (`date(today) - dur(1 week)`), regex functions, DataviewJS, and
`FROM` on outgoing links (`outgoing([[Page]])`). `TASK` covers dated checklist items only.

## API

`POST /api/workspaces/:id/query` — see [API.md](API.md#query-blocks).
