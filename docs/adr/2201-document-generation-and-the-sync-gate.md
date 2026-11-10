# 2201. Document generation and a sync gate before every Auth

- Status: Accepted
- Date: 2026-11-10

## Context
A device copy (ADR 2200) holds an old state of a page plus, possibly, edits the server never got.
Every server path that changes a body edits the page's one Y.Doc (`openDirectConnection` +
transact): version restore (`routes/snapshots.ts`), AI-edit revert (`revert.ts`), split
(`routes/splitPage.ts`, parent), update_page / patch_section (`md/docWrite.ts`,
`context/sectionWrite.ts`, minimal edits), vault sync (`routes/sync.ts`). No path replaces a
`page_docs` row of an existing page with a new document; trash and purge only touch `pages`. So a
merged copy can neither revive what the server deleted (the delete set covers it) nor double the
body. What a blind merge *can* do is lose work silently: an edit typed offline inside a block that a
restore, a revert or a split removed lands in a deleted block and is never seen
(`offline.test.ts`, "baseline"). History is lost only outside the app: a database restored from a
backup (CLI only, `deploy/restore.sh`), or a crash between a socket acknowledging an edit and the
debounced store writing it. A device that kept those ops would push them back over the restored
state on merge.

The provider makes this hard to guard: on every (re)connect it sends Auth and SyncStep1 and answers
the server's SyncStep1 with everything the local doc has. A tab left open through an outage merges
before any code of ours runs — unless the code runs before Auth.

## Decision
- **`pages.doc_gen`** (migration 0057, integer, default 0) is bumped by `bumpDocGen()` (`docGen.ts`)
  **after** the content transact of: version restore, AI-edit revert, split (parent), and the
  delete-everything fallbacks of update_page (`writeBlocksToDoc`) and vault sync. Minimal edits
  (update_page's `applyDocumentReplace`, patch_section, append) do not bump: they change only the
  blocks they rewrite, as a collaborator typing at the same time would.
- Order: content first, then the bump, then `{t:'gen', gen}` to the page's open clients. The
  collaboration socket reads the generation in `onAuthenticate`, before any content goes to that
  connection, and sends it in `connected` (`collab.ts`). A client therefore never pairs a newer
  generation with older content; the only possible error is a spurious recovery copy.
- **`GET /api/pages/:id/sync-check`** (`routes/offlineSync.ts`) answers `{ gen, canEdit, trashed,
  sv }` with the socket's visibility rules (guests included), except that a trashed page the caller
  could see answers `trashed: true` instead of 404. `sv` is the live document's state vector, else
  `page_docs.state_vector`. 403/404 mean no access; `TWO_FACTOR_REQUIRED`, 401, 5xx and network
  errors say nothing about the page and never delete anything.
- **The gate** (`lib/offline/gate.ts`) is the provider's `token` callback, which the provider awaits
  before Auth on every (re)connect. An empty document passes without a request. Otherwise it asks
  sync-check and runs `decide()` (`decide.ts`):
  - no access → `forget`: the copy is deleted, unsent edits included (ADR 2203);
  - trashed → `recover` (unsent edits) or `reset`;
  - the server lacks ops of the copy other than those of its own unsent edits (history lost) →
    `recover` ('replaced'), even with nothing marked unsent: those ops were acknowledged once;
  - unsent edits and a different generation → `recover` ('restored');
  - unsent edits and no edit right → `recover` ('readonly'): the server would drop them with
    `SyncStatus(false)` on every reconnect;
  - otherwise `merge`.
  Anything but merge throws, so the provider gives the document up (`authenticationFailed`): the
  shared socket marks the name denied and never authenticates it again on that socket (updates typed
  while the check ran stay queued unprocessed there). CollabEditor stores the recovery item, deletes
  the copy and reopens the page from the server with a notice saying why. Three failed checks in a
  row reopen it 10 s later.
- **Recovery items** keep the whole device state; Settings → Offline lists them with a read-only
  preview, a link to the page and Delete.
- Old clients ignore `{t:'gen'}` (CollabEditor only reacts to `t:'comments'`); a new client on an
  older server never learns a generation and relies on the history check.

## Alternatives considered
- **Merge, then keep a recovery copy when the generation changed**: the restored page would carry
  offline additions the restorer never saw, and every reconnect would need the pre-merge state.
- **Generation inside the Y.Doc** (a Y.Map key): a stale copy carries the old value into the merge.
- **A second Y.Doc bridged to the editor's** (sync into a fresh doc, then copy the diff): no gate
  needed, but every open page holds two documents and every update is applied twice, which the
  large-page budget (ADR 1040–1043) cannot afford.
- **Only the state-vector check, no generation**: catches lost history but not restore, revert or
  split, which keep it.

## Consequences
- Every open of a page that has a device copy, and every reconnect of an open page, costs one small
  GET before Auth. A first open without a copy costs nothing. Without a device copy (setting off,
  storage unavailable) there is no gate: there would be nowhere to keep a recovery item, so such a
  tab syncs exactly as in 0.17.
- A restore, revert, split or full rewrite during someone's outage turns their unsent edits on that
  page into a recovery item even when they touched other blocks: safe, sometimes more than needed.

## References
- apps/server/src/docGen.ts, collab.ts, routes/offlineSync.ts, routes/snapshots.ts, revert.ts,
  routes/splitPage.ts, md/docWrite.ts, routes/sync.ts, drizzle/0057_offline_doc_gen.sql
- apps/web/src/lib/offline/decide.ts, gate.ts, apps/web/src/components/CollabEditor.tsx
- apps/server/src/offlineSync.db.test.ts, apps/web/src/lib/offline/offline.test.ts
