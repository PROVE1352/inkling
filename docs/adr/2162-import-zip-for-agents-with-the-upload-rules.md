# 2162. import_zip: an agent's zip becomes a page tree under the upload rules

- Status: Accepted
- Date: 2026-11-10

## Context
The web app imports a `.md` or a `.zip` (folders become folder pages, `.md` documents, `.canvas`
canvases, `assets/` attachments) and a Notion export. MCP had only `import_folder`, which takes Markdown
text: an agent holding a vault or an exported folder had to unpack it and resend every file, and could not
bring the attachments at all. Meanwhile a bearer `POST /workspaces/:id/import` with a zip was not covered
by the 0.16 upload rules (ADR 2044, 2045, 2065): its attachments were stored with no switch, no type
check, no per-file cap, no budget and no `uploaded_via`.

## Decision
- **Tool `import_zip(base64, workspaceId?, parentId?, source?)`** in the hidden group `files` (with
  import_folder and upload_file), so the core profile's tool list does not grow. It checks the size before
  decoding and the zip signature, then sends the bytes to the web app's own route
  (`POST /api/workspaces/:id/import`) through `call()`, so membership, `visibleTo`, the edit lock and
  agent locks on the parent (`assertPlacement`), the connection's range (top level refused for a subtree
  connection), read-only tokens (`wrapWrite`) and suggest-only connections (`requireMembership`'s write
  guard) are the web app's checks. Its answer lists the pages (wrapped as untrusted), the attachments
  stored once and the ones not stored with the reason, and how to undo.
- **The route applies the connection rules to any bearer zip** (MCP or an API token):
  - the zip is an upload: at most `AGENT_UPLOAD_MAX_MB` (and at most `IMPORT_MAX_UPLOAD_MB`);
  - its Markdown is what import_folder sends, so a zip without attachments imports even when uploads by
    agents are off;
  - its attachments are uploads: before the first one the switch (`AGENT_UPLOADS` and the workspace
    setting, 403 `AGENT_UPLOADS_OFF`) and the daily budget (429 `UPLOAD_BUDGET`) are checked, before any
    page is created; each attachment is typed by name and bytes like upload_file and must fit the per-file
    cap; refused ones are skipped and listed (`skippedAttachments`) while the pages import; stored ones
    carry the connection in `files.uploaded_via`, so they count toward the budget.
  - The same per-attachment rules apply to a bearer `import-folder` (the MCP import_folder sends only
    Markdown, so it is unaffected).
- **The MCP body**: `isUploadCall` admits `import_zip` like `upload_file` (directly or through
  `more_tools`), so the body limit derived from `AGENT_UPLOAD_MAX_MB` (ADR 2065) covers it; every other
  call keeps 12 MB.
- **Notion exports are refused through a connection** (415 `NOTION_IMPORT_IN_APP`, with
  `source=markdown` to import the files as plain Markdown instead). The Notion importer builds databases
  and stores attachments on its own path; carrying the upload rules and the type check through it is a
  change to that importer, left for later. The web path also now labels Notion-imported pages with
  `markCreatedVia` (a no-op in the browser).
- **Feed and undo**: the pages carry `created_via` and their `page_added` change-log rows carry the client
  name (as every import did), so `changes_since`, `catch_up` and the activity view show the import. The
  revert routes treat page events as unsupported (ADR 1620–1624), so the undo of an import is trashing its
  top page(s): the subtree goes with it and comes back from the trash. The tool says so.

## Cost
tools/list, full profile, measured with `npx tsx scripts/mcp-tools-list-cost.ts`: HEAD bd30a54 47 tools
~12,410 tok → with import_zip alone 48 tools ~12,591 tok (+181: description ~54, schema ~108). Core
profile: 32 tools ~7,437 tok before and after (+0). The full-list guard in toolSurface.test.ts moves from
12,500 to 12,700.

## Alternatives considered
- **Put import_zip in core**: every core session would pay ~181 tok for a rare flow. Rejected.
- **A tool-only check of the upload rules**: an API token could still post the same zip to the route.
  The rules live in the route, keyed on `req.authVia === 'bearer'`.
- **Refuse the whole zip when one attachment is refused**: a vault with one video would not import at
  all; skipping and reporting keeps the pages and tells the agent what to tell the person.
- **Gate every bearer zip with the switch**: a Markdown-only zip is import_folder in another envelope,
  and import_folder was never gated.
- **Accept Notion exports through the connection now**: needs the rules inside the Notion importer (and it
  writes databases); left for a later release.
- **Make revert undo page creation**: a revert that trashes pages is a different action from restoring
  text and needs its own rules (pages edited by people since); out of scope here.

## References
- apps/server/src/mcpTools/historyInkFileTools.ts (import_zip), apps/server/src/agentImport.ts,
  apps/server/src/routes/exportImport.ts, apps/server/src/md/importer.ts (`AgentImportRules`),
  apps/server/src/agentUploads.ts (`assertDailyUploadBudget`, moved from routes/files.ts),
  apps/server/src/mcpBody.ts, apps/server/src/mcpTools/profiles.ts
- apps/server/src/mcpTools/importZip.db.test.ts, apps/server/src/md/zipSafety.test.ts
- ADR 2000 (profiles), 2040 (suggest-only), 2044, 2045, 2065 (uploads), 1202 (ranges), 0970 (locks), 2163
