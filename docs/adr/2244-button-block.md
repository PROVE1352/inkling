# 2244. A button block runs its actions as the person who presses it

- Status: Accepted
- Date: 2026-11-10

## Context
Notion-style buttons: a block in a document with a label, a color and a list of actions (add a row to a
database from a template with defaults such as "today", "me", "this page"; set values of the row the page
is; open a page or a URL; send to a registered webhook). The page is read by many people, shown on public
links, printed, exported, synced to a vault and read by agents.

## Decision
- **Block**: custom type `button` (shared `buttonBlockConfig`): `label`, `color` (BlockNote's color
  names), `actions` (canonical JSON of `ButtonAction[]`, at most 5, validated by `parseButtonActions`).
  Registered in the web schema map, the page-embed viewer and the server schema (serverSchema.ts).
- **Running**: in the presser's browser (lib/buttonRun.ts), action after action, through the REST routes
  that person may use anyway — POST /pages/:id/collection/rows, PATCH /pages/:id/props, navigation. The
  button adds no right. A webhook has no such route, so POST /pages/:id/button-webhook (members, 10 per
  minute) sends only when the page's stored document has that block with that hook — a client cannot pick
  another hook, and a button saved seconds ago may need the collab store's next write.
- **While running**: the button shows progress and ignores further presses; on failure it says which
  action (number and kind) stopped and the server's message. No undo.
- **Where it shows**: the editor (editable or read-only: the press is checked by the server); public pages
  (an inert `<button aria-disabled>` with the label: `publicBlocks` drops the actions before the server
  renders, so no ids reach public HTML); print (hidden, `data-print-hide`); agent Markdown and the
  download (`<!-- inkling:button {"actions":[…],"color":"…","label":"…"} -->`, round-trips like the 0.17
  block tokens); plain Markdown (`**[label]**`); vault sync (the token, ADR 2169); search and chunks (the
  label).
- **Older clients**: a 0.17 editor does not know `button` and y-prosemirror drops it when that client
  edits the page (CHART-2, ADR 1600); the rest of the document stays. Recorded as a known issue; the
  service worker updates clients on reload.

## Alternatives considered
- **A prop on an existing block** (as 0.17 did with `pageEmbed.viewId`, ADR 2120): old clients would keep
  it, but would show a page card or a plugin box that does something else when clicked; the contract fixed
  the type name `button`.
- **Run actions on the server** (as automations do): the server would need to act as the presser anyway;
  the browser already holds that session and gets the same checks through REST.

## Consequences
- packages/shared automations.ts / blocks.ts; server md/notation.ts, md/serverSchema.ts, md/convert.ts,
  md/textIndex.ts, context/chunker.ts, md/syncMd.ts, routes/automations.ts; web
  components/blocks/ButtonBlock.tsx, lib/buttonRun.ts.
- Tests: notationRoundTrip.test.ts (button element), ButtonCompat.test.ts (an old schema loses only the
  button), automations.db.test.ts (button webhook), buttonRun.test.ts.
