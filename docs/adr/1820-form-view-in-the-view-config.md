# 1820. A "form" collection view, its questions in the view config

- Status: Accepted
- Date: 2026-11-10

## Context
People want to add rows to a collection by filling a form: the questions in an order they choose,
some required, with a help text each. Members fill it in the app; some forms are for people outside
the workspace (ADR 1821).

## Decision
- `viewTypeSchema` gains `form`; `viewConfigSchema` gains `form: FormSettings`
  (`packages/shared/src/forms.ts`): `fields: [{ fieldId, required?, description? }]` in order (the
  row title is the pseudo id `title`), `title`, `description`, `submitLabel`, `successMessage`.
  Like the chart view (ADR 1603) it lives in `collection_views.config`; the column is a TS-only enum.
- A form asks for text, number, select, multiSelect, date, checkbox, url and person (members only).
  Relations, rollups and formulas are never asked. Unknown or ineligible ids are skipped when read,
  so a deleted property does not break a form.
- One conversion from answers to row props, `formSubmissionProps`, is shared: the web runs it to show
  missing answers before sending, the server runs it again on a public answer.
- Members' answers go through `POST /pages/:id/collection/rows` with `template: null` (the same path
  as "New row"). The web's form view has a fill mode and, for editors, an edit mode.
- MCP `create_view` takes `form` (questions by property name, like `chart`); without it a new form
  asks for the title and the first eligible properties (`defaultFormSettings`).

## Alternatives considered
- A `forms` table separate from views: a second place for something that already is a way of looking
  at a collection, with its own tab, name and order.
- Server-side required checks for member answers: they would need a form id on the generic row
  route; members can add rows without a form anyway.

## Consequences
- 0.14 clients do not know the view type.
- Tests: `apps/web/src/lib/forms.test.ts`, `forms.db.test.ts` (MCP create_view with form settings).
