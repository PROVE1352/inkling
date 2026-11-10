# 2303. Archived workspaces leave the default scope of find_context, search and catch_up only

- Status: Accepted
- Date: 2026-11-10

## Context
"All my workspaces" is the default of several reads. Which of them should an archive narrow, and
what must still reach the person from an archived workspace?

## Decision
- **Narrowed** (without workspaceId): find_context (single, several queries, semantic on or off; the
  cached path filters in its scope statement `searchScope`, the uncached one through
  `defaultSearchScope`), search (`GET /api/search`), and in catch_up the groups that report what
  happened in a workspace: page changes by others and own, new comments, due tasks, team agents.
- **Not narrowed**: what calls the person (inbox: mentions, replies, assignments; catch_up's "For
  you" group, which reads the inbox), their own Later reminders, `changes_since` (a sync cursor with
  a hole would lose edits for good), read_page/read_pages, id prefixes and names (`matchWorkspaceRef`:
  `workspaceId: "Old contest"` works), `inferWorkspace` ("your only one", a write default), resources,
  Slack. The web app's ⌘K searches the open workspace only and is unchanged: the web app has no search
  across workspaces (GET /api/search is the only one).
- **workspaceId given** (id, prefix or name): archive ignored.
- **Range-limited connections** (ADR 1200; OAuth grants, API tokens, agent tokens with a workspace or
  subtree range): the range decides and the archive is not applied (`archiveApplies`).
- catch_up's marker still advances: changes in an archived workspace during that window are not
  shown later after unarchiving (catch_up is a digest; changes_since is the record).
- A token whose range is "all" (API tokens, OAuth grants, agent connection tokens) has no range scope
  and follows the archive like a browser session.
- Other members are not affected: rows are keyed by the person.

## Alternatives considered
- **Narrow the inbox too** (it is one of the "all workspaces" defaults): every inbox item is a
  mention, reply or assignment, the "must not miss" kind; it stays.
- **Narrow `memberWorkspaceIds` itself**: it also resolves names and ids and filters read_pages, so a
  named archived workspace would become "not found".
- **Apply the archive inside a range**: a range made for one archived contest would search nothing.

## Consequences
- One extra `EXISTS` per listed workspace on a primary key inside statements that already run; no new
  round trip (measurements in the 0.18 drafts).

## References
- apps/server/src/workspaceListing.ts (`defaultSearchScope`, `splitArchived`, `archivedSql`), context/contextCache.ts,
  routes/agentSearch.ts, catchUp.ts
