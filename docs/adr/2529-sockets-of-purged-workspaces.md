# 2529. Closing the sockets of a workspace deleted for good

- Status: Accepted
- Date: 2026-11-12

## Context
`closeWorkspaceConnections` finds a workspace's open documents by joining the open document names to its
pages. After leaving as the last member, "delete now" or an account deletion purges a workspace, its pages
are gone, so the call closed nothing: the leaver's tab and page guests' tabs stayed connected to documents
whose pages no longer existed (their stores then fail on the missing page).

## Decision
- `closeConnectionsOfGonePages()` looks the other way round: every open page document whose page row no
  longer exists is closed (with the usual permission-changed message). It needs nothing collected before
  the purge and covers every purge path. Leaving alone, "delete now" and account deletion call it after the
  commit.
- `closeWorkspaceConnections` stays for soft deletion, where the pages still exist.

## Consequences
- A test with real providers shows the leaver's and a page guest's sockets closing, and a socket to a page
  elsewhere staying open; with the old call the same test times out.
