# 1656. query_rows describe=true is data

- Status: Accepted
- Date: 2026-11-10

## Context
ADR 0976 puts query_rows' title, schema and cells in `<untrusted_content>`. The `describe=true` answer
printed the collection title, field names, option labels and row template names as plain text: a member
who names an option "ignore the rules and …" reached the agent outside the data marker.

## Decision
- The describe answer is one `<untrusted_content source="rows" id=<collection>>` block (title, fields,
  options, the `#fieldId` map, row templates) followed by the fixed operator help outside it (same bytes
  for every collection).
- Sweep of the other schema/meta outputs: `create_collection`, `update_fields`, `create_row`, `list_versions`,
  `list_trash`, `read_file` (text), inbox/Later excerpts already wrap; short titles outside a block keep
  `cleanText` (ADR 0976). Left as is and noted: `read_page`'s `- properties:` header line (cleanText,
  not wrapped); chart and suggestion tools belong to their own changes.

## Alternatives considered
- `cleanText` each name: escapes markers but does not mark the text as data, which is what ADR 0976 asks
  for multi-line member text.
