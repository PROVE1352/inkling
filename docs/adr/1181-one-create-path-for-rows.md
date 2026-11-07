# 1181. One create path for rows; template values reuse the template and MCP grammars

- Status: Accepted
- Date: 2026-11-07

## Context
Rows were created three ways: the web's table/gallery button and the board column and calendar
day buttons used `POST /pages` (then, for board and calendar, a second `PATCH /pages/:id/props`);
MCP `create_row` and REST clients used `POST /pages/:id/collection/rows/batch`. The two routes
differ: `POST /pages` sets `created_via` and queues `page_created` webhooks but checks no row cap;
the batch route checks the cap and queues assignment events but neither of the former. A template
applied in only some of these places would make the same button behave differently in a board and
in a table, and an agent would get other rows than a person.

## Decision
- `POST /pages/:id/collection/rows` creates one row: `{ template?, title?, props?, inputs?, tz? }`.
  `template` omitted → the database's default (an empty row if there is none); `null` → an empty
  row; an id → that template (404 `TEMPLATE_NOT_FOUND` otherwise). The web (new row, board column,
  calendar day, ▾ menu), MCP `create_row` and REST clients all use it.
- `createRow` (`apps/server/src/rowTemplates.ts`) does, in order: pick the template; render the
  title (a typed title wins), then the property defaults and the body with `ctx.title` set to the
  row title; put explicit `props` over the defaults; under the workspace tree lock
  `assertPlacement(publicRule: false)`, row cap and next sort order in one statement, insert the
  page (`created_via`, the template's icon) and its `page_docs`, queue assignment events and the
  `page_created` webhook in the same transaction (ADR 1150); after commit, index the body (text,
  chunks, tags, tasks, links) like `instantiateTree`.
- Values: the title, text/URL defaults and the body use the template variables of ADR 0922
  (`renderString`, `transformDocState`: inside text runs only, never in code). `{{input:…}}` prompts
  of the title, text defaults and body are listed in the template DTO; the web asks them first,
  MCP passes `inputs`, missing answers use the prompt's default. Dates take the MCP filter grammar
  (`today`, `today+7`, `today-1`, `YYYY-MM-DD`, `parseDateValue`), computed from the creator's wall
  clock (`wallClock(now, tz)`), the same day `{{date}}` uses. Person takes `me` (the creator) or a
  member id. Relation and rollup have no defaults in this version.
- Explicit values follow the batch rules (`sanitizeBatchProps`; non-members → 400). Template
  defaults are checked again at use (`sanitizeTemplateProps`): a deleted option, a field that
  changed type or a member who left drops that one value, and the row is still created.
- `POST /pages` and the batch route are unchanged: `POST /pages` stays the generic "new page"
  (no template), the batch route stays the import/paste path (rows carry their own values).

## Alternatives considered
- **Apply templates in `POST /pages` when the parent is a collection**: changes a generic route
  for every client, including the ones that create rows they fill right after; rejected.
- **Apply them in the batch route**: imports and pastes would get template bodies; rejected.
- **Client-side templates** (web copies the body and values): agents would not get them, and the
  web would need the body before every create; rejected.

## Trade-offs
- An empty row now checks the row cap (a count over the collection's children in the same pass
  that reads `max(sort_order)`). Measured: no change for an empty row.
- A templated row waits for its body to be indexed, as a page from a gallery template does.

## Consequences
Measured with an out-of-tree script (in-process `app.inject`, the test harness of
`mcpTools/testHarness.ts`, Postgres 16.13 in Docker, Node 22.23.4, Apple M4): four collections with
four fields (select, date, person, text), N=200 sequential requests per case after 20 warm-up
requests, two rounds (cases forward, then reversed); the template had a 1.8 KB body (Markdown with
three headings, lists, a task and a quote) and four values (`today+7`, `me`, an option, a text with
`{{author}}`). Results (ranges over the two rounds):

| Case | p50 | p95 |
|---|---|---|
| Empty row, `POST /pages` (before) | 2.71–3.41 ms | 3.35–4.99 ms |
| Empty row, new route | 2.81–3.22 ms | 3.40–3.83 ms |
| Board column, `POST /pages` + `PATCH props` (before) | 5.30–5.92 ms | 6.88–7.04 ms |
| Board column, new route with the value | 3.05–3.34 ms | 3.64–4.05 ms |
| Row from the template | 11.18–11.40 ms | 13.29–13.49 ms |

Recorded in docs/PERFORMANCE.md.
