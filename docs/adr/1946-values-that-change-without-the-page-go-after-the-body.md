# 1946. Values that change without the page go after the body

- Status: Accepted
- Date: 2026-11-10
- Amends: 1654 (claims line position), 1842 (verified line position), 1846 (owner status)

## Context
Prompt caches match a byte-identical prefix (ADR 0937, 1543). 0.15.0 put three values into read_page's
header that change without the page changing: the owner's live status (`- owner: Mia (status "…" until
…)`, ADR 1846), the verified/stale line (day granularity, ADR 1842) and live section claims (ADR 1654,
already the last header line). Anything after them — the whole body — dropped out of the cached prefix
whenever a status was set, a day passed or a claim came and went. The outline put claims on the section
lines and the verified line in its header; a section read put both in its header.

## Decision
- Full read: header (`id … can`, flags, large/ink/properties, owner, review dates) → `---` → wrapped
  body → blank line → trailer lines `- owner status: "…" until …`, `- verified: …` / `- stale: …`,
  `- claims: …`, then `- linked from …` when asked (ADR 1948). `- owner: Name` stays in the header
  (it changes with the page's settings).
- Section read: claim and verified lines after the wrapped section text.
- Outline: one `claims: §a …` line and the verified line after the section list.
- `unchanged` answers keep the claim on the line after (ADR 1654).
- Owner status text goes through `cleanText` (it is member-written; it was printed raw).

## Not changed (recorded)
- `updatedAt` and `version` stay in the header: they change only with the page.
- Review lines (`reviewDue …(stale, p=…)`) come from the daily batch and stay in the header (ADR 0951).
- find_context's verified marks are the find_context owners' (ADR 1907 moved them).

## Consequences
- The header + body prefix is stable across status changes, days and claims.
- Agents read the trailer after the body; MCP.md describes the new positions (draft).
- Tests: verifyStatus.db.test.ts (verified, stale and owner status at the end), mcpFixes013.db.test.ts
  (claims after the body and after the outline list).

## References
- apps/server/src/mcp.ts (`trailer`, read_page, `readOutline`)
- docs/adr/0937-*, 1543-*, 1654-*, 1842-*, 1846-*, 1907-*
