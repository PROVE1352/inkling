# 1743. Semantic candidates pass the same permission boundary as find_context

- Status: Accepted
- Date: 2026-11-10

## Context
Vectors are stored per chunk for every live page, private pages included (the indexer cannot know who
will search). The cache is per workspace, not per person. The caller passes a list of workspace ids.

## Decision
`semanticCandidates()` applies the permission rules itself, in SQL, on every call, before the limit:
1. **Workspaces:** of the given ids, only live workspaces where the user is a member, not blocked for
   the current agent connection, inside the connection's range, and not blocked by an unmet two-step
   requirement (the rules of `memberWorkspaceIds`, retrieve.ts). A wrong or forged list cannot widen
   the search. Guests get no semantic candidates (find_context does not search guest workspaces either).
2. **Pages:** live pages (`deleted_at IS NULL`) that pass the `visibleTo` rule — shared, or private and
   created by the user — and the connection range / guest scope (`pageInRangeSql`). Only vectors of
   these pages are scored; the SQL fallback has the same conditions in its WHERE clause.
3. **Back to sections:** the statement that maps the best vectors to current chunks repeats the
   workspace, trash and visibility conditions, so a page trashed or made private between steps is not
   returned.

## Alternatives considered
- **Trust the caller's workspace list** (as `findContext` does). One more query per call buys
  independence from the caller; the entry point is meant to be reused.
- **Score first, filter the top k.** Visible results could be crowded out by invisible ones and the
  answer would depend on other people's private pages. Filtering before scoring avoids both.

## Consequences
- DB tests (`context/semantic.db.test.ts`) check, on the cache path and the SQL path: another person's
  private page, a page in the trash, a workspace the person is not in, and a deleted workspace never
  appear; the author sees their own private page; an outsider gets nothing.

## References
- docs/adr/0803-*, 0947-*, 1112-*, 1200-*, 1252-*, 1740-*, 1741-*
- `apps/server/src/context/semantic.ts`
