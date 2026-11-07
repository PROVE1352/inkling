# 0937. Prompt-cache-friendly, deterministic MCP output

- Status: Accepted
- Date: 2026-11-07

## Context
LLM APIs cache prompt prefixes: a request is cheaper and faster when its beginning is byte-identical
to a recent one. An agent that re-reads the same outline or re-runs the same find_context only
benefits if the server answers with the same bytes. Ties sorted by insertion order, a clock-based
recency bonus or a timestamp in a response break that.

## Decision
- **Same input + same documents → same bytes** for find_context, read_page (all modes),
  read_pages, list_pages and search; query_rows and changes_since follow the same rule (ADRs 0934,
  0932; the changes_since cursor sits on its own last line).
  - Every sort has a total tie-break: SQL `ORDER BY …, page_id, ord`; `byScore` (score, page id,
    position) for the heap, packing and fragments (`context/rank.ts:137`); list_pages children by
    `sortOrder` then id.
  - Scores are rounded to 1e-6; recency is measured against the newest candidate's `updatedAt`, not
    the clock (`retrieve.ts`).
  - No request ids, current times or durations in text; only document `updatedAt`.
- **Stable parts first**: page header and outline before section text; fragment headers before
  bodies; pointers ("also relevant") and next-step hints last.
- **Fixed instructions and descriptions**: constant strings, no per-user insertion (the read-only
  sentence is a constant variant).
- Test: context.db.test.ts "deterministic output" calls seven read tools twice and again after
  editing an unrelated page; all byte-identical.

## Alternatives considered
- **Latent communication between agents** (KV-cache/hidden-state exchange such as C2C, LatentMAS,
  Interlat) cuts tokens further but needs white-box access to model internals; agents reach Inkling
  through hosted APIs where only text crosses the boundary, so provider prefix caching is the
  practical lever.
- **Server-side response cache keyed by request**: saves server CPU, not the client's prompt cost.

## Trade-offs
Ordering by a fixed tie-break can favour lower UUIDs among exact ties; ties are rare after scoring.

## How others solve it
Provider docs on prompt caching recommend putting static content first and keeping it byte-stable;
search engines use document-id tie-breaks for reproducible pagination.

## Consequences
New tools must keep output deterministic; the determinism test is the template.

## References
- apps/server/src/context/rank.ts:111, :137, :146; apps/server/src/context/retrieve.ts
- apps/server/src/mcp.ts:63 (`renderPageList`), :144 (`SERVER_INSTRUCTIONS`)
- apps/server/src/context/context.db.test.ts ("deterministic output …")
