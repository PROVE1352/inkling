# 2443. The public render cache is keyed by whose access its charts use

- Status: Accepted
- Date: 2026-11-11

## Context
Public HTML is cached per page revision for up to 10 minutes (ADR 0753): `pages.updated_at` changes with
every document store, so an edit is a new key. Charts (ADR 2440–2442) add data that does not change the
host page's revision: the switch, the recorded person's membership, and the rows of the sources.

## Decision
- One cache entry holds the HTML and its `charts` list together (`cachedRender`, `PublicRender`), so a cached
  page never pairs anchors of one render with the charts of another.
- The key adds the person whose access the charts use, or nothing: `p|<page>|<rev>|<token>|<enabler or ''>`
  (folder pages likewise). `chartsEnabler` runs on every request before the lookup (one indexed read of
  `workspace_members`), so turning the switch off or on, a different manager turning it on, and the person
  leaving the workspace each change the key at once. A link with the switch off, or whose person left, uses
  the same key as before 0.20 plus an empty part.
- The numbers inside a cached entry can be up to 10 minutes old (as ADR 1605's tables were), and so can a
  source that became invisible to the person without touching the host page (made private, trashed). The
  aggregate cache under it (ADR 1602, 60 s, keyed by the workspace version) is per person.

## Alternatives considered
- **No render cache when the page has charts**: always fresh, but every visit to a public report would
  aggregate and render the whole page again — the cost ADR 0753 removed.
- **The workspace version in the key** (what the aggregate cache uses): fresh numbers, but any edit anywhere
  in the workspace (including every keystroke's store) evicts every public page of it.
- **The workspace access version (`bumpAcl`) in the key**: covers grants and roles, not membership removal or
  a page turned private; the membership read covers the case that matters at once.

## Consequences
- Documented: "chart numbers on public pages can be up to 10 minutes old" (dialog hint, GUIDE, OPERATIONS).
- Tests: `charts/publicCharts.db.test.ts` ("off again: gone at once from a warm cache", "the person who turned
  it on leaves the workspace: the charts go, cache or not").

## References
- `apps/server/src/routes/public.ts` (`cachedRender`, `revKey`), ADR 0753, 1602, 1605, 2441
