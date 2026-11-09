# 1606. create_chart and create_view write through the existing routes

- Status: Accepted
- Date: 2026-11-10

## Context
Agents should add charts and views by name, and 0.12's suggestion mode, edit policy, auto-accept
rules, locks and section claims must apply to them as to any other write.

## Decision
- `create_chart(pageId, section?, placement?, collectionId | query, view?, kind, groupBy, bucket?,
  series?, seriesBucket?, measure?, measureField?, sort?, limit?, title?, options?, suggest?)`: maps
  property and view names to ids (`GET /collection?rows=0`), validates with the shared schema, checks
  the data once through the aggregate route (a hidden source or a bad field writes nothing), then
  writes the chart token through `POST /pages/:id/section` (append / prepend / insert_after) or, without
  a section, `POST /pages/:id/content` append. A 202 from those routes is answered as a suggestion.
  The answer carries the data line and the token.
- `create_view(collectionId, type, name, config?, chart?)`: names accepted where field ids go
  (groupByFieldId, dateFieldId, startFieldId, endFieldId, sorts/filters fieldId, chart settings);
  validated with `viewConfigSchema`; one `POST /pages/:id/collection/views` with the new `config`.
- read_page annotations: ADR 1604. Both tools use `wrapWrite` (read-only connections are refused),
  member text in answers is wrapped as untrusted. The injection heuristics list the two tool names.

## Alternatives considered
- A server route that inserts a chart block directly into the Yjs document: a new writer of
  documents with its own suggestion/lock handling (ADR 0750, 1530).
- Accepting raw ztd specs from agents: our format is what is stored; library options pass through
  `options`.

## Consequences
- Tests: `charts.db.test.ts` (unknown property lists the properties, hidden source refused, insert at
  §section, read_page shows it, suggestion instead of a write, chart and board views by name,
  read-only refused).
