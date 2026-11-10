# 1961. patch_section keeps its baseVersion rule (not ADR 1947's)

- Status: Accepted
- Date: 2026-11-10

## Context
ADR 1947 gave `update_page(mode='replace')` a precondition: with `baseVersion` the page version must
still match; without it the replace is refused when a person edited the page last. It recorded the same
rule as fitting patch_section's `replace`/`delete`, and the wave 14 drafts listed "patch_section
replace/delete still accept a missing baseVersion" (MCP-REPL-2).

That premise holds for the REST route only. The MCP tool has refused `replace`/`delete` without
`baseVersion` (already in 0.15.0, contextTools.ts: `baseVersion is required for mode=replace; get it from
read_page(pageId, outline=true) or find_context (v=…)`), and patch_sections requires it per edit
(ADR 1542). The section version check runs inside the document transaction (applySectionPatch, under
the write gate), so it cannot be overtaken by an edit between check and write — update_page's two-step
check (MCP-REPL-1) can.

## Decision
No change. patch_section `replace`/`delete` keep the stricter rule: always a `baseVersion`, checked
atomically, with the conflict answer carrying the current section text and version (one call to retry).
`append`, `prepend` and `insert_after` take none, as before; which section they reach is now checked
by ADR 1960 instead.

The REST route `POST /pages/:id/section` keeps `baseVersion` optional: it is also the browser-less API
for scripts, and a person's own token deciding to overwrite is not the agent-overwrites-person case
ADR 1947 is about. Agents reach it through the MCP tool.

## Consequences
MCP-REPL-2 is dropped from the known issues. ADR 1947's "patch_section … optional there too" describes
the REST route.
