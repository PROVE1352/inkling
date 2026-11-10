# 2143. A files field: designed, not in 0.17

- Status: Accepted
- Date: 2026-11-10

## Context
The evaluation's list of missing Notion field types includes files. The other six types of 2140 are
values; a files field is an upload surface with its own permission and export questions.

## Decision
Not shipped in 0.17. The design, for when it is built:
- Type `files`, value `string[]` of `files.id` (at most 20), each file uploaded with `files.page_id` = the
  row, so the existing download rule (visible page) applies, guests included (ADR 1252), and trashing the
  row hides them.
- Browser: the existing upload route (`POST /api/files` with the row as page). Agents: `upload_file` with
  the row as page, under the 0.16 switch and limits (ADR 2065), then `update_row {"Files": [ids]}`; the
  server keeps only ids of files whose `page_id` is the row.
- Public forms: no file questions (anonymous uploads would need their own budget and scanning).
- Exports: CSV/XLSX write file names and URLs; Markdown export links them; Notion import maps file columns.
- Filters: empty / not empty; sort: count; formulas: the count.

Reasons to wait: the anonymous form path, export of binary columns and guest download rules each need
tests of their own; 0.17 already changes field types, filters, sub-items and guest access.

## Alternatives considered
- **Ship it browser-only**: agents and forms would see a type they cannot write; the MCP refusal and form
  exclusion would have to be undone later.

## References
- ADR 2044, 2045, 2065 (agent uploads), 2140
