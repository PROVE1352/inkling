# 1043. A one-line "large page" hint in agent tool output

- Status: Accepted
- Date: 2026-11-07

## Context
The production page that motivated ADRs 1040–1042 grew because an agent loop appended every
experiment to one page (MCP `update_page append`). Nothing told the agent the page had become
expensive to read and write. Server-side fixes lower the cost, but a page that keeps growing makes
every full read and every store bigger.

## Decision
- A page is **large** when its stored Yjs state is ≥ 1 MiB (`LARGE_PAGE_STATE_BYTES`) or its indexed
  body is ≥ 50,000 estimated tokens (`LARGE_PAGE_TOKENS`, sum of `page_chunks.token_estimate`).
  - 1 MiB: on the measured 4.5 MB page a full decode costs 130–210 ms (≈ 30–45 ms per MB) and a full
    Markdown export 1.2 s, so from 1 MiB a whole-page read or a store blocks the event loop for tens
    to hundreds of milliseconds.
  - 50k tokens: more than any single budgeted read returns (`read_pages` ≤ 30k, `find_context`
    ≤ 12k), so the page cannot be read whole in one budgeted call anyway.
  - Both values come from columns read without a decode: `octet_length(page_docs.state)` reads the
    TOAST header, `token_estimate` is an integer. They are computed in the existing agent-context
    query (two scalar subqueries, no extra round trip) as `large` per page.
- Output: a fixed sentence, no numbers, so it is deterministic for the same document size class and
  cache-friendly (ADR 0937):
  `large page: read it by section (read_page outline=true, then section=…) and add new entries to a child page instead of appending here`
  - `read_page` (outline, section, full): a header line; `update_page` and `patch_section`: a second
    line after the result; `find_context`: `; large page` on the fragment line plus one closing line
    when any shown page is large.
- docs/MCP.md and AGENTS.md tell agents to split growing logs into child pages.

## Alternatives considered
- **Refuse or throttle appends to large pages.** Breaks working agent loops; the hint plus the cheaper
  write path is enough.
- **Character threshold (100k characters).** Needs `char_length` over every chunk's text (detoast) on
  every tool call; tokens are what the agent pays for anyway.
- **Put the size in the hint.** Numbers change with every edit and would vary the output of otherwise
  identical calls.

## References
- apps/server/src/context/largePage.ts, apps/server/src/routes/editLock.ts (agent-context `large`)
- apps/server/src/mcp.ts (`read_page`, `update_page`), apps/server/src/mcpTools/contextTools.ts (`find_context`, `patch_section`), apps/server/src/mcpTools/agentContext.ts (`largeLine`)
- apps/server/src/context/largePage.db.test.ts
