# 2425. Older clients are read-only on pages that hold node types they do not know

- Status: Accepted
- Date: 2026-11-11

## Context
A browser edits a page through y-prosemirror, which deletes every Yjs element its editor schema does not know
(ADR 0940) and sends that deletion to the server like any edit. Columns (ADR 2420) are the first node types a
0.19 editor lacks. Measured with the 0.19.1 web app (`git archive 365b664`, its own build on another port)
against the 0.20 server without a guard, in Chrome:

- a 0.19 tab that only **opened** a page with a group deleted it: the server's page lost the group and every
  block inside it, before anyone typed;
- a group a 0.20 tab added to a page a 0.19 tab had open was gone as soon as the 0.19 tab received it;
- a 0.19 tab with offline copies on (ADR 2200) keeps that deletion as an unsent edit, and after the reload
  into 0.20 the device copy would send it from a client that may write.

Tabs left open over an upgrade are normal (the update banner waits for a reload, ADR 0990), so the server has
to protect the document; nothing can be changed in the 0.19 code.

## Decision
- **Document schema version** (`packages/shared/src/docSchema.ts`): `DOC_SCHEMA_VERSION` (0.20 = 2) and
  `NODE_SCHEMA`, node name → first version that knows it (`columnList`, `column` → 2). A release that adds a
  node type bumps the version and lists the node; `docSchema.test.ts` fails when a server schema node is
  neither a 0.19 node nor listed.
- **Clients say their version** in the collaboration socket URL (`/collab?schema=2`), so every provider of the
  tab (shared socket, dedicated fallback, page embeds) carries it. No parameter (0.19 and older) or garbage = 1.
- **The server keeps what each loaded document needs** (`apps/server/src/docSchema.ts`): a walk of the
  document when it loads, then an `afterTransaction` handler that raises it in the transaction that adds an
  element holding a newer node. It looks only at element children inserted in that transaction (a subtree
  inserted whole, as a rewrite's new blockGroup, is walked) and skips text changes at once. It is lowered only
  by a new walk, which every older client's authentication does.
- **Older client, page that needs more**:
  - at authentication (`onAuthenticate`): the connection is read-only. The scope goes out before the document
    is loaded, so the need comes from the live document or, when it is not loaded, from `page_docs.state`.
    Only older clients pay that walk;
  - while connected: the observer sets `readOnly` on the older connections of that document synchronously,
    in the transaction that added the node, so the deletion their editor answers with arrives at a read-only
    connection and Hocuspocus drops it (SyncStatus false). Their socket is then closed with code 4000 (an
    ordinary close, not 4401/4403), the provider reconnects and authenticates again as read-only;
  - before every message (`beforeHandleMessage`): the same check against the remembered need, for a
    connection authorised just before the node arrived. Current clients return at the first comparison.
- **Telling the user**: the server sends `{t:'schema', needs}` to such a connection. 0.20 shows "This page has
  content that only a newer version of the app can edit. Reload to update." with a Reload button, makes the
  editor read-only and does not show the lock banner. 0.19 ignores the message.
- **Device copies**: a copy records the lowest schema among the apps whose unsent edits it holds (`schema` on
  the record; copies written by 0.19 have none and count as 1). `GET /pages/:id/sync-check?schema=N` with N
  below the server's answers `needs` as well, and `decide()` keeps such edits as a recovery item (reason
  `outdated`) instead of merging them when `needs` is above the copy's schema.
- **Row template bodies** are the other place a browser sends Yjs updates (REST, `LocalDocEditor`): the
  PATCH carries `schema`; an update without it (or older) on a body that needs more answers 409
  `SCHEMA_OUTDATED` and changes nothing.
- MCP and REST writes go through the server's own schema (DirectConnection, `md/serverSchema.ts`), which
  knows every node: not affected.

## What a 0.19 tab shows (Chrome, after the guard)
- Page without columns: edits as before and saves.
- Page with columns: the body without the group, not editable, under the lock line "Locked · Editable by:
  workspace owners and admins · You can read and comment, but not edit" (0.19 reads a read-only connection as
  a lock); the update notice "A new version is available. Reload" at the bottom (the server's build differs).
  Typing does nothing; the connection dot stays green and nothing else is shown. After the reload (0.20) the
  page shows the group and is editable.
- Group added while the tab is open: within a moment the same read-only view, without the group; typing
  after that does nothing, and anything it sent between the group's arrival and the reconnect is dropped.

## Alternatives considered
- **Refuse older clients on such pages** (authentication failure): the tab shows the page as inaccessible and
  stops syncing, also for pages it could only read; read-only keeps reading and comments.
- **Read-only in place without closing the socket**: the server drops the edits, but the 0.19 tab does not
  learn the scope and keeps accepting typing that is never saved.
- **Bump the page's document generation (ADR 2201) when an older client's write is dropped**: covers device
  copies without a new field, but a 0.19 tab that reconnects learns the new generation and its copy would then
  merge; it also turns every other device's unsent edits on that page into recovery items.
- **Version in the Auth token** instead of the URL: per document, but the token callback is the offline sync
  gate (ADR 2201); the URL covers every provider of the tab with one change.
- **A deep observer** (`observeDeep` with `event.changes.added`) for the raise: simpler, but it builds an event
  for every changed type, 10× the cost of a keystroke transaction (above).
- **Only the service worker / UPDATE_MODE=force**: a reload does fix the tab, but not before its first render
  has deleted the group.

## Consequences
- A tab of 0.19 or older cannot edit pages with columns until it reloads; pages without columns are
  unchanged for it. After a group is removed again, the next authentication of that tab walks the page and
  gives it a read-write connection.
- Cost (`docSchema.ts` in a loop, Node 22, Apple-silicon MacBook Air, medians of interleaved rounds): a
  keystroke transaction on a 2,000-block page 3.0 µs without the handler, 2.6 µs with it (noise); a new block
  in a 2,000-block group 2.7 → 50.4 µs (the group's children are looked at once); nothing once the page holds a
  group. Per authentication of an older client: a walk of the live page (0.65 ms at 2,000 blocks) or a decode
  of the stored state (12.4 ms for 570 KB, 2,000 blocks), only while such clients exist; one stateless message
  per such connection. A deep observer was tried first and cost 3.1 → 30.9 µs per keystroke (rejected).
- The 0.19 tab's own document keeps the deletion it made (unsent, never applied); with offline copies on it
  becomes a recovery item after the reload, with "Made by an older version of the app".
- Checks: `docSchema.test.ts`, `docSchemaGuard.db.test.ts` (real providers over sockets),
  `lib/offline/store.test.ts` (copy schema, decide), and the Chrome check of a 0.19.1 build against the
  0.20 server (before the guard: the group deleted on open and on arrival; after: 10/10).
