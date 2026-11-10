# 2103. check_notes reports section links whose heading is gone

- Status: Accepted
- Date: 2026-11-10

## Context
check_notes (ADR 2003) reports `[[X]]` that never resolved and links to trashed pages. A section link
to a live page whose heading was deleted is just as broken for the reader.

## Decision
- A new broken-link state **`noHeading`**: a section link (page_links.sections) from a page in scope
  to a page the viewer can see, whose heading resolves to `missing` by ADR 2102's order (block id,
  name, change log). Renamed headings are not reported. Text `Title#Heading` with the target's current
  title; the MCP line reads `[[Title#Heading]] heading not found in page <id8>`.
- Same non-oracle rule as the rest of the check: hidden targets are skipped, never reported. Order
  is fixed (source, target, stored order of the refs) so the same notes give the same answer.

## Alternatives considered
- **Report renamed headings too, as "out of date".** The link works; the report is for repairs.

## Trade-offs
- One outline read per target page that has section links in scope, and a change-log query per
  name that resolves to nothing.
