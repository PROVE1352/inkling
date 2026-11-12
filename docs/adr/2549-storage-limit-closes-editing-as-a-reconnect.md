# 2549. Going over the storage limit reconnects editing read-only; the demo's containers get no swap

- Status: Accepted
- Date: 2026-11-12

## Context
When a store or a recount took a workspace past its storage limit, `quota/storage.ts` closed the workspace's
live connections with `closeWorkspaceConnections` (and a page past its body cap with `closePageConnections`):
a `permission-changed` PermissionDenied message and close code 4403, the path for access that really changed
(a member removed, a page made private). The web app marks such a document as denied on its shared socket
(`apps/web/src/lib/collabSocket.ts`) and shows it as disconnected, and the provider does not reconnect after
4403. Once a recount found room, `reconnectReadOnlyWorkspaceConnections` only reopened connections that were
still there and read-only: the denied editor was not among them.

Measured with Chrome (production build, demo preset, w22-reports/fix4 step 0): a workspace at 5.5 MB, a 1 MB
insert into the open page from another connection, the store's estimate at 10.29 MB flipped the workspace;
the editor showed "연결 끊김" (disconnected), and what was typed afterwards never reached the server, also
after the 40 s recount put the use back at 9.12 MB, for the 230 s watched. The same with a real overflow
(1 MB more through REST in another page, then that page purged): the editor did not come back without a reload.

Separately, the demo's containers had `mem_limit` without `memswap_limit`. On a host with swap (cgroup v2)
Docker then lets a container use as much swap again, on the host's swap device.

## Decision
- Over the limit (`noteBodyStore`'s flip, a recount that finds the workspace over) and a page body past its cap
  are handled by `liveConnections.ts reconnectWorkspaceForStorage` / `reconnectPagesForStorage`: each editing
  connection is made read-only at once, told why (`{"t":"storage","why":"workspace"|"page"}`, as
  `collab.ts reconnectForStorage` does for a refused update) and its socket is closed with the ordinary 4000
  `storage-full`. The provider reconnects at once and is authorised read-only; when a recount finds room,
  `reconnectReadOnlyWorkspaceConnections` closes it again and it comes back read-write.
- `closeWorkspaceConnections` and its 4403 stay for access changes and deleted workspaces (0.21.1 behaviour).
- Demo preset: the app's heap 448 MB in a 768 MB container (`NODE_OPTIONS`, `APP_MEM_LIMIT`), and every demo
  service (app, db, backup) with `memswap_limit` equal to its `mem_limit` (backup's 256m written out in the
  overlay). `demo.sh` refuses a resolved configuration where one of the three lacks `mem_limit`, an equal
  `memswap_limit`, `pids_limit` or `cpus` (`docker compose config --format json` gives both memory values in
  bytes, `pids_limit` and `cpus` as numbers).

## Measured
- Chrome, same script, after: the workspace at 5.5 MB and the same 1 MB insert no longer flip it (ADR 2548:
  9.11 MB cached); typing reached the server every time for 138 s. With the real overflow and the purge: the
  editor went read-only at once and was editing again 3 s after the purge, without a reload (before: never).
- Memory (production build, macOS, item 6 of w22-reports/merged and fix4): three accounts filling 2.5 MB pages
  in both their workspaces with every page kept open ran out of memory at a heap of 320 and 384 MB and held at 448
  before ADR 2548 (heap at most 434 MB, RSS 734 MB). With ADR 2548 the limit refuses the rest after one such page
  per workspace and the same run peaks at 332 MB heap, 588 MB RSS. RSS minus heap was 255–325 MB, hence 768 MB
  for a 448 MB heap. Pages of tiny map entries (one account) still ran a 448 MB heap out of memory in 12 s.

## Consequences
- A known risk stays: pages of many tiny map entries (about 100 MB of heap for a 2 MB page) let one account
  run the app out of memory even at a 512 MB heap. A server-wide structure budget was not made (it would be a
  new way to lock everyone); the container's limits keep it to the demo, which restarts.
- A container that runs out of memory is stopped and restarted instead of swapping on the host.
