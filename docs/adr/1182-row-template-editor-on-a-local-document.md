# 1182. The row template editor: the page editor on a local Yjs document

- Status: Accepted
- Date: 2026-11-07

## Context
Templates should be edited like a page (Notion opens a database template as a page). Row
templates are not pages (ADR 1180), so the collaboration server (Hocuspocus, which authorizes and
stores by page id) cannot host them. Converting the body to blocks on the server and back
(`stateToBlocks` / `blocksToStateBuffer`) would drop what the server schema does not know:
callouts, page mentions, page embeds, plugin blocks (the loss ADR 0920 removed from "Save as
template").

## Decision
- `LocalDocEditor` (`apps/web/src/components/CollabEditor.tsx`) is the page editor without a
  provider: the same BlockNote schema, slash, wikilink and mention menus, query blocks, URL paste
  and upload handler, bound to `doc.getXmlFragment('document')` of a local `Y.Doc` (BlockNote's
  collaboration extension accepts a provider without awareness). Uploads attach to the collection
  page, so `/files/:id` follows the database's visibility.
- `RowTemplateEditor` loads `GET /collection-row-templates/:id` (body as a base64 V1 update),
  applies it, remembers the state vector and then sends only `Y.encodeStateAsUpdate(doc, lastSaved)`
  800 ms after the last change (`PATCH { update }`). The server applies the update to the stored
  body (`mergeBody`: decode, apply, re-encode, 2 MiB cap; a damaged update is 400). Updates from two
  editors open at once merge like any Yjs updates; neither overwrites the other. Title pattern,
  values, name, icon and default save as fields 500 ms after a change (last write wins, like view
  settings). Closing flushes both.
- The editor shows the template like a page: a banner saying what is edited, the icon, the title
  pattern in the title style, the property values (relative date and person choices), then the
  body.

## Alternatives considered
- **A Hocuspocus document per template** (a second document namespace with its own auth and store):
  live co-editing and presence, at the cost of a second authorization path in `collab.ts`; not worth
  it for something edited rarely and briefly.
- **Markdown body**: simple to store and diff; loses the blocks above; rejected.
- **Full state on every save** (PUT the whole document): last writer wins between two editors;
  rejected for the diff-and-merge above, which costs nothing more.

## Trade-offs
- No presence or live view of another person's edits; a second editor sees them after reopening.
- Deleted content stays as Yjs tombstones in the stored body (bounded by the 2 MiB cap).

## Consequences
- A change to the page editor's schema or menus reaches templates automatically.
- Verified in a browser (Playwright, production build): typed text in the template editor was
  autosaved and present in the stored body; a callout placed in a template body reached the new
  row unchanged (`rowTemplates.db.test.ts`).
