# Changelog

All notable changes to Inkling. Versions follow [Semantic Versioning](https://semver.org/); while the
version is `0.x`, minor releases may change APIs, MCP tools and the database schema (migrations run
automatically on boot). Design decisions are in [`docs/adr/`](docs/adr/README.md); open problems in
[`docs/KNOWN-ISSUES.md`](docs/KNOWN-ISSUES.md).

## [Unreleased]

## [0.13.0] - 2026-11-10

No database migration. The `chart` view type and the `accepted_partial` suggestion status are new values of existing
text columns (no CHECK constraint). The section text an agent read before a `replace` suggestion is kept in
`plugin_storage` (plugin id `inkling:suggestion_base`, up to 512 KB per suggestion) and dropped once the suggestion is
decided, withdrawn or replaced (housekeeping removes leftovers). New web dependency `ztd-charts` 0.5.0 (MIT, no runtime
dependencies), loaded only when a chart is on screen. Upgrade matrix adds v0.12.0: CI also tests the upgrade from it
with data (`.github/workflows/upgrade.yml`, docs/adr/1052-*).

### Added
- **Charts.** Type `/chart` in a page to draw a bar, horizontal bar, stacked bar, line, area, donut or pie chart (and
  ten more kinds under "More") from a database, optionally through one of its views' filters, or from a query block
  query. Group by select, multi-select, person, date (day / week / month), checkbox, relation, text, URL, number or
  title; count rows or sum / average / min / max a number. Charts follow light and dark mode, the app language and
  reduced motion, work with the keyboard and screen readers, and redraw when the data changes. Nothing is stored but
  the settings: everyone sees the numbers of the rows they can see, and a chart whose database you cannot see says so
  (docs/adr/1600-*, 1601-*).
- **Chart view** for databases, next to table, board, calendar, gallery and timeline; the view's filters choose the
  rows (docs/adr/1603-*).
- `POST /api/workspaces/:id/charts/aggregate`: group and measure a collection (or a query) for the caller, with the
  collection query's access rules; read-only tokens may call it (docs/adr/1602-*).
- `create_chart` and `create_view` MCP tools. Agents add charts and views by property name; charts go through the
  same write path as `patch_section`, so suggestions, edit policies and auto-accept rules apply (`suggest=true` needs
  a `section`). `read_page` shows a chart as `<!-- inkling:chart {…} -->` with a data line under it
  (docs/adr/1604-*, 1606-*).
- Markdown export turns charts into tables of their numbers; public folder links show a table for databases inside
  the link and leave other charts out (docs/adr/1605-*).
- **Suggested edits can be accepted in part.** The review shows a `replace` suggestion as changes (one per block)
  with a checkbox each; a change that overlaps what someone wrote after the agent read the section is marked, shows
  the text there now, and starts unchecked. "Apply selected" merges the chosen changes into the section as it is now,
  keeping everyone's edits (3-way merge). The suggestion's status is `accepted_partial`, shown as "n of m changes" to
  the agent and in the history (docs/adr/1621-*, 1622-*).
- **Revert agent edits.** Activity and the page's right panel (History › Recent changes) offer "Revert" on changes
  made through an agent: only that change, everything that agent changed on the page, or (owners and admins) in the
  workspace, today / 24 h / 7 days / 30 days. A preview lists what will be reverted, what stays because someone edited
  it afterwards, and what cannot be reverted here; each page is changed all at once after a "Before revert" version.
  Later edits are kept; removed text comes back with its formatting from the page versions. A revert is your own
  change in the history and can be undone. People only, there is no MCP tool for it. REST: `GET /pages/:id/changes`,
  `POST /changes/:seq/revert`, `POST /pages/:id/revert`, `POST /workspaces/:id/revert` (all with `dryRun`)
  (docs/adr/1620-*, 1623-*, 1624-*).
- **Tables can be typed.** On an empty line, type a row like `| Name | Role | Due |` and press Enter: it becomes a
  table with those cells as the header row and one empty row, the caret in the empty row. `\|` puts a pipe in a cell;
  a single cell (`|a|`), code blocks, inline code and an Enter that ends Korean/Japanese input are left alone; one ⌘Z
  gives the typed row back. In the `/` menu, `/table 3x4` (also `/표 3x4`, `3*4`) inserts an empty table of 3 columns
  × 4 rows. A Markdown table pasted as text already became a table and still does; it is now covered by the editor
  typing check. "Insert table" is in the command palette (no default key) (docs/adr/1642-*).

### Changed
- The page tree always keeps 40 % of the sidebar height (200–280 px). Menus that do not fit above it fold under
  "More (k)", which shows a dot when a folded menu has a badge and remembers per device whether it is open; below
  720 px of height the footer (trash, shortcuts, settings, account) is one row of icons. On a Galaxy Tab S10 in
  landscape with every menu on, the tree went from 71 px (Chrome, ~700 px) and 8 px (in-app browser, ~480 px) to
  283 px and 223 px. The "New page ▾" menu opens upward or scrolls when there is no room below; the workspace menu and
  the tree's context menu stay within the window (docs/adr/1640-*).
- New sidebar default: Search, Later, Due and Calendar. Threads, Graph, Tags, Web shares, Activity and Today are off
  for anyone who never changed the sidebar or reset it, and can be switched on in Settings › Sidebar. A sidebar
  someone arranged keeps every menu it showed (docs/adr/1641-*).
- Typing in the editor is attributed in the change log to the person who typed when only one person typed since the
  last index pass (was: nobody). An agent's (or any API) write first logs typing that was not indexed yet, so the
  write's change holds only the write (CF-2, docs/adr/1625-*).
- `list_suggestions`, `GET /api/suggestions` and `GET /api/pages/:id/suggestions` take `status`: `open` (default),
  `decided`, `all`, or one status. Without a page, the list no longer includes decided suggestions unless asked
  (docs/adr/1626-*).
- `POST /api/pages/:id/collection/views` accepts an optional `config` (same shape as PATCH). View types include
  `chart`; the view config has an optional `chart` object (docs/adr/1603-*).
- Row property changes are logged as a new change kind, `page_props` (the changed field names); the activity filter
  `kind=page` includes it, `kind=edit` does not. `PATCH /api/pages/:id/collection/rows/batch` runs in one transaction
  also without person cells and logs title changes and `page_props` (docs/adr/1650-*).
- New routes and fields are in [docs/API.md](docs/API.md), "v0.13.0 additions".

### Fixed
- `changes_since` and `catch_up` now report collections and rows. A collection made with `create_collection` or in the
  web app, and rows made with `create_row`, the web app's "New row" / board / calendar "+", a paste or an import were
  never logged (only a page's first indexed body was), so an agent keeping a local copy with the feed missed them.
  They show as `collection added:` / `row added:`; ten or more rows of one collection in one answer are one line
  `rows added: N to collection "…" <id>` pointing at `query_rows`. Row property changes (`update_row`, cell edits,
  paste) show as `properties: Status, Due`; a body typed into an empty row later shows as added sections
  (docs/adr/1650-*, 1651-*).
- `changes_since`: a page trashed and restored between two cursors printed nothing; it now says `trashed, then
  restored` (`catch_up` uses the same words) (docs/adr/1652-*).
- `catch_up`: one edit nobody could be credited with (live typing with several typists) no longer moves a page you and
  your agents changed into "Pages changed by others". "By others" means another identified person; such edits are
  shown as `unattributed edits N` (docs/adr/1653-*).
- `read_page` shows section claims on the full read (last header line `- claims: §a claimed by … until …Z`) and next
  to an `unchanged` answer for `known=`, not only on section reads as 0.12 said (docs/adr/1654-*).
- Error hints name what was not found: a missing section says so and lists the current anchors instead of
  "page/workspace not found"; `read_file`, comment threads, rows, collections and versions get their own hint and next
  tool. `claim_section` follows a renamed heading like `read_page(section=…)` (docs/adr/1655-*).
- `withdraw_suggestion` on a suggestion that was replaced, decided or already withdrawn answered "the content changed
  since you read it; re-read it and retry". It now says which state, by whom, and for a replaced one the id of the
  newer suggestion (docs/adr/1626-*).
- `list_suggestions(pageId)` showed withdrawn suggestions while `list_suggestions()` did not, and superseded
  suggestions appeared in neither (docs/adr/1626-*).
- Accepting a suggestion whose section changed meanwhile no longer overwrites people's edits when the changes are
  chosen in the review (accepting whole through the API without `hunks` keeps the old behaviour) (docs/adr/1621-*).

### Performance
- Initial JS +9.1 KB raw for chart schemas and strings (+0.9 %); the chart library is a lazy 48.1 KB gzip chunk
  loaded when a chart is first on screen. Drawing through the library's spec renderer instead was measured and
  rejected (98.5 KB gzip, +52 %).
- Chart aggregate of 10,000 rows: cold median 26.3–26.5 ms, cached 6.9–8.8 ms; 2,000 rows 8.6–10.5 ms cold.
- Numbers and methods: [docs/PERFORMANCE.md](docs/PERFORMANCE.md).

### Security
- `query_rows describe=true` prints the collection title, field names, option labels and row templates inside
  `<untrusted_content>`, like the rows; before, member-written names there reached the model unmarked
  (docs/adr/1656-*).

## [0.12.0] - 2026-11-10

Two database migrations. `0040_v012_agent_ink_setting` adds `workspaces.agent_ink_read` (off by default; one
`ADD COLUMN` with a constant default, no table rewrite). `0041_v012_suggestions_leases` adds `section_suggestions`,
`section_leases`, `agent_edit_policies` and `catch_up_markers`, and moves `catch_up` markers out of `plugin_storage`
(plugin id `inkling:catch_up`) into `catch_up_markers`. Only development builds of 0.12 wrote such rows, so an upgrade
from a release moves nothing; `scripts/upgrade-test/run.sh` allows `plugin_storage` to shrink by exactly those rows.
The section index moves to version 4: on first boot, pages with callouts, mentions or embeds are re-indexed by the
background backfill, the others keep their index. Upgrade matrix adds v0.11.0: CI also tests the upgrade from it with
data (`.github/workflows/upgrade.yml`, docs/adr/1052-*).

### Added
- **Suggested edits from agents.** `patch_section` and `patch_sections` take `suggest: true`: nothing is written,
  the change is kept as a suggestion for its section (a batch makes all its suggestions together or none). The page
  shows "N suggested edits from agents" and a "✎ N suggested" marker next to each section heading; **Review** shows
  each suggestion as a diff against the section as it is now. People who can edit the page accept or reject it; if the
  section changed after the agent read it, the dialog says so and asks once more ("Accept anyway"). A new suggestion
  from the same connection for the same section replaces the open one. Agents list theirs with `list_suggestions` and
  take one back with `withdraw_suggestion`; accepting and rejecting are for people only, there is no tool for them
  (docs/adr/1530-*, 1531-*, 1533-*, 1538-*).
- **How agents edit**, a workspace default in Workspace settings › Connected agents (owners and admins): **Edit
  directly** (as before), **Accept by rules** or **Review everything**. Under the last two, agent body edits
  (`patch_section`, `patch_sections`, `update_page`) become suggestions. The lock dialog's agents setting now offers
  Workspace default, Edit directly, Accept by rules, Suggestions only, Comment only and Read only, so a locked page or
  folder can choose differently; under "Suggestions only" other agent writes are refused. People are not affected,
  and an agent can only suggest where its person may edit. `can:` lines read `suggest` (review, suggestions only) or
  `suggest,auto` (accept by rules) (docs/adr/1532-*, 1544-*).
- **Auto-accept rules** for "Accept by rules": a suggestion is accepted without a person when its section is still
  exactly as the agent read it (always), the kind of edit is allowed (add to the end of a section, new section after
  one, add under a heading by default; replace and remove optional), the connection is allowed (all by default) and
  the change is within the size limit. An optional wait in minutes lets people reject first; a section that changes
  during the wait goes to a person. Whole-page edits always wait for a person. Auto-accepted edits show "Accepted by
  rule" in the suggestions history and "<client> · auto-accepted" in page history and activity; rule changes are in
  the audit log (`agent_policy.changed`). The agent's answer says "auto-accepted under the workspace rule …", "will be
  auto-accepted at … unless a person rejects it" or "kept as suggestion … needs review: <reason>"
  (docs/adr/1545-*).
- **Approval notifications.** A new suggestion sends `approval_request` to the page's owner (else its creator);
  accepting or rejecting sends `approval_result` to the person whose agent suggested it, which their agents read with
  `inbox` (docs/adr/1534-*).
- **Section claims.** `claim_section(pageId, section, minutes)` (default 5, max 30) and `release_section`: while a
  connection holds a claim, other agents' `patch_section` / `patch_sections` on that section (and `update_page`
  replace of the page) are refused with `SECTION_CLAIMED`; suggestions still work and people are never blocked.
  `read_page` prints `claimed by <client> until <time>Z`; the web app shows "<client> is working on this section"
  (docs/adr/1535-*, 1536-*).
- `patch_sections(pageId, edits)`: up to 20 section edits on one page in one call, applied together or not at all. A
  stale `baseVersion`, an unknown section, a section claimed by another agent or a section named twice writes nothing,
  and the answer lists every problem with the current text (docs/adr/1542-*).
- Re-reads cost one line when nothing changed: `read_page` shows the page `version`, and `read_page(pageId,
  known=<version>)` answers an unchanged page with `unchanged (page … v=…; can: …)`; with `section=…`, `known` is the
  section version. `read_page(pageId, knownSections={anchor: version})` returns only the sections that changed or are
  new and names the removed ones. `read_pages(ids, known={id: version})` lists unchanged pages in one line each,
  without spending budget on them. A page that was trashed, made private or moved out of the connection's range is
  reported as before, never as unchanged, and `can:` always shows the current rights (docs/adr/1540-*).
- `list_pages` and `search` take `format: "compact"`: 8-character page ids, and runs of numbered or dated pages in one
  line (`Weekly sync 2026-11-{03,10,17} ids: …`). `read_page`, `read_pages`, `patch_sections` and
  `list_pages(parentId)` accept the short ids; an ambiguous one returns the candidates (docs/adr/1541-*).
- `catch_up` MCP tool: "what happened while I was away" in one call, most important first: mentions, replies and
  assignments for the agent's person, tasks due within 7 days and overdue, due Later reminders, new comment threads
  and replies, then pages changed by others (who, via which client, how many edits, section diffs; new, trashed and
  moved pages included), then the person's own changes. Without `since` it continues from the connection's last
  catch_up (else the person's last one, else the last 24 hours); `since` also takes a `changes_since` cursor or a
  time. Output fits a token budget (default 4,000, max 12,000) and ends with `next since:`. It acknowledges nothing;
  `inbox`/`ack` and `changes_since` keep their roles. REST: `GET /api/catch-up` (docs/adr/1520-*, 1521-*, 1537-*).
- `changes_since` takes `wait` (seconds, up to 25, with a cursor): when nothing changed yet, the call waits and returns
  as soon as something changes in the agent's workspaces, or empty at the end. Agents that follow a workspace no
  longer need to poll (docs/adr/1551-*).
- Usage per connection: Admin › Server status lists agent connections and API tokens with calls, estimated tokens
  returned, errors, find_context cache hits, average and p95 latency and last use since the server started; Workspace
  settings › Connected agents shows the same numbers for the calls that reached that workspace. Numbers only, kept in
  memory, reset on restart (docs/adr/1552-*).
- `create_collection` and `update_fields` MCP tools: agents make a collection with its properties in one call and
  add, rename, retype, reorder or remove properties and select options, by name. They write through the same route as
  the web app, so relation targets, the hidden-target rule, two-way pairing and the edit lock apply; a refused spec
  writes nothing (docs/adr/1523-*).
- `read_ink` MCP tool: a page's handwriting (pen and highlighter strokes) as PNG images, drawn with the same stroke
  shapes as the web ink layer. Tall pages come in up to three images per call with a `top=` to continue; `top`,
  `height` and `scale` pick a range and size. Off by default: the workspace setting "Agents can read handwriting"
  (Workspace settings › Connected agents, owners and admins) turns it on. While it is off the tool says so and names
  the setting, and pages do not mention handwriting to agents; when it is on, `read_page` and `find_context` add one
  line, `ink: N strokes (read_ink to view)`, to pages that have handwriting, never the handwriting itself
  (docs/adr/1510-*, 1511-*, 1512-*).
- Version history for agents: `list_versions` (saved versions with time, label, who and via which client),
  `diff_versions` (Markdown line diff between two versions or a version and the current page) and `restore_version`
  (undoable: the page as it was is saved first as a "Before restore" version, and the answer gives its id). Trash for
  agents: `list_trash` (what is in a workspace's trash, when each page is deleted for good, its former parent) and
  `restore_page` (back to its old place with its trashed subpages, or to the top level when the parent is gone), with
  the same rules as the trash in the app. There is still no permanent-delete tool (docs/adr/1513-*).
- `read_file` MCP tool: an attachment by id or by the `/files/<id>` link `read_page` shows. PNG, JPEG, WebP and GIF up
  to 3 MB come back as images, text files as text (marked as member-written data), PDFs and other types as metadata
  only. REST: `GET /api/files/:id/meta` (docs/adr/1514-*).
- Agents see and keep everything in a page: `read_page`, `read_pages`, section reads and conflict bodies show callouts
  as `> [!type] text`, mentions as `@[Name](user:<id>)`, and page/link embeds, plugin blocks, file and audio blocks as
  one-line `<!-- inkling:… -->` tokens. `patch_section`, `patch_sections` and `update_page` turn them back into the
  same nodes: left as they are, unchanged; deleted, removed; edited, changed accordingly (a new callout or embed can
  be written the same way). Agents can keep, move or delete mention chips but not create new ones (an unknown
  `@[Name](user:…)` stays `@Name` text) (docs/adr/1500-*).
- An old section anchor still works after its heading (or a parent heading) is renamed: `read_page(section=…)`,
  `patch_section` and `patch_sections` serve the section under its new anchor and say `moved_to: §new`. An old name
  that now leads to several sections returns `SECTION_AMBIGUOUS` with the candidates (docs/adr/1501-*).

### Changed
- `update_page mode=replace` edits the document minimally instead of rebuilding it: blocks sent back unchanged keep
  their ids (comment anchors), colors, toggles, image widths, table cell colors and concurrent typing. In
  `patch_section`, a block the agent retypes (paragraph → list item, …) keeps its id, colors, underline and color
  marks and mention chips (docs/adr/1500-*).
- The server's editor schema now includes callout, page embed, link embed, plugin block and mention (configs shared
  from `@inkling/shared`), so server reads (export, search index, history, MCP) keep them. Markdown exports (page and
  zip export, vault sync, templates, history preview) now contain callouts as `> [!type] text` and mention chips as
  `@Name`; Obsidian/GitHub `> [!note]` callouts import as callouts. Embeds and plugin blocks are still left out of
  exports. Public share pages show callouts and mention names (no ids). Search finds callout text (docs/adr/1500-*).
- `read_page` has one more header line (`- version: …`) and each `read_pages` page line a `v=…` field. `read_pages`
  shows folder pages in the agent notation, as it already did for documents, so both tools print the same page
  version (docs/adr/1540-*).
- `catch_up`: the header no longer carries today's date; the due window is the line `due window: up to <date>` right
  before `next since:`, so the start of the output stays the same from day to day while nothing happens (prompt
  caches, docs/adr/1543-*).
- `find_context` answers a repeated question from a server-side cache per person. Any edit (after its reindex),
  permission change, agent block, two-step rule, trash or privacy change in the searched workspaces makes the next
  call search again; results are never shared between people (docs/adr/1550-*).
- `create_row` writes relation links in the same transaction as the row. `POST /api/pages/:id/collection/rows` now
  stores relation values in `props` (visible rows of the target only; two-way targets must be editable, otherwise
  nothing is created) instead of dropping them (docs/adr/1524-*).
- Restoring a version (in the app or through `restore_version`) is recorded in the change feed and activity with
  who restored it, and an agent's restore is labelled with its client (docs/adr/1513-*).
- The workspace list (`GET /api/workspaces`, MCP `list_workspaces`, the workspace order of `search`) breaks ties in
  creation time by id, so the order no longer flips between calls (docs/adr/1543-*).
- The `inbox` tool lists `approval_result` (it was reserved).
- Edit lock: the agents value `same` now means "follow the workspace default" (labelled "Workspace default"); with
  the default "Edit directly" it behaves as before.
- `import_folder` says "about 12 MB per call" (the old "50 MB" was the multipart route's limit, not the MCP
  request's).
- The web ink layer's stroke geometry moved to `@inkling/shared` so the server draws the same shapes; strokes look
  exactly as before.
- For MCP and API clients: JSON-output tools (`list_workspaces`, `list_pages`, `search`, `list_templates`,
  `create_page`, `import_folder`, `rename_page`, `move_page`, `create_from_template`) clean member-written strings and
  mark them as data (see Security). `list_workspaces` and `list_templates` answer with two text blocks, the first being
  the same JSON array as before, so clients that join all text blocks before `JSON.parse` must read the first one;
  objects gain trailing `untrusted` (and sometimes `applies`) keys; `list_pages` with `format: "lines"` is wrapped in
  `<untrusted_content>`. Requests to `/mcp` without a valid token get 401 even when the body is not valid JSON (it was
  400). New routes and fields are in [docs/API.md](docs/API.md), "v0.12.0 additions".

### Fixed
- Server-side writes that read the open document (`update_page`, vault sync) could drop callouts, page and link
  embeds, plugin blocks and mention chips from the whole page, and `update_page replace` lost them even when the agent
  sent them back: the server's editor schema did not know these nodes (docs/adr/1500-*).
- A `patch_section` over a section containing a file block turned the file block into a link paragraph and a caption
  paragraph, even when the agent sent the section back unchanged.
- The read-only page embed viewer could delete callouts, mentions, link embeds and plugin blocks from the embedded
  page's live document (its editor schema did not know them). The embed schema is now built from the same list as the
  main editor (docs/adr/1539-*).
- `create_row` could leave a row without its relation links when setting the links failed.
- `pnpm test` (`scripts/run-tests.mjs`) exited 0 when a test file failed to import under the tsx loader, so such
  files dropped out of CI unnoticed; a top-level `✖` line or a non-zero fail count now fails the run.

### Performance
- Re-reads with `known`, 2,000-page workspace, three agents × 8 questions, each reading the pages find_context names:
  pages that did not change 39,231 → 759 tokens (−98.1%); after a person edited one page per question 39,495 → 27,273
  (−30.9%); the whole question flow 134,301 → 83,607 (−37.7%). `read_page` time is unchanged (the page is still read
  to compare versions).
- `list_pages` with `compact`: the whole 2,000-page tree 25,256 → 10,821 tokens (−57.2%); a folder of 100 weekly
  meeting notes 1,564 → 543; 365 daily notes 4,577 → 970. `search` compact 324 → 247 tokens.
- Three section edits with `patch_sections` instead of three `patch_section` calls: 3 round trips → 1, p50 76–155 →
  34–66 ms.
- `patch_section` replace: p50 small section 7.3–7.6 → 4.1–4.2 ms, 100-block section 54–62 → 23–26 ms (an old block
  equal to a new one skips the Markdown round trip).
- `find_context`, three agents asking the same ten questions: p50 113.3 → 20.4 ms, 93.3% answered from the cache.
- `changes_since`, three agents watching with `wait=25` instead of polling every 2 s: 75% fewer calls, 56% fewer
  database transactions, a change seen after p50 57 ms instead of 695 ms.
- `catch_up` on 2,500 pages with 6,000 changes in the window: median 100 ms at the default budget.
- `POST /mcp`: a 12.4 MB body of many small values stalled the event loop for 70.1 ms while it was parsed (also
  without a token); it is now refused after 2.3 ms. String-heavy bodies (folder imports) are unchanged (about 3 ms per
  MB). A parser in a worker thread and a 4 MB body limit were measured and rejected (docs/adr/1526-*).
- Printing 8-character page ids in `find_context` was measured and rejected: −5.6% tokens, but every tool that takes
  its ids would need short ids.
- Regressions: `update_page replace` is 1.5–2.0× slower (p50 small page 4.6–5.1 → 7.8–8.5 ms, 100-block section
  30.3–31.2 → 46.9–49.2 ms, 1.4 MB page 353.0–581.8 → 702.3–1,146.8 ms), accepted for keeping block ids, formatting,
  callouts, embeds, chips and concurrent typing (docs/adr/1500-*). The ink marker costs +0.3–0.4 ms per `read_page` /
  `find_context`, +2.5 ms on a page with about 2 MB of ink while the setting is on (docs/adr/1512-*). `read_ink`
  renders on the event loop: about 30 ms for a typical page, 0.2 s near the 8 MiB ink limit (docs/adr/1511-*).
- Numbers and methods: [docs/PERFORMANCE.md](docs/PERFORMANCE.md).

### Security
- JSON-output MCP tools clean member-written strings like the text tools (our markers escaped, bidi and tag characters
  removed, zero-width characters shown as `\uXXXX`) and say that they are data: objects end with an `untrusted` key
  (and `applies` when agent instructions apply to the page), arrays are followed by a second text block. Before,
  titles there reached the model unmarked (docs/adr/1525-*).
- `POST /mcp` looks up the bearer token before reading the body (no token: 401 without parsing) and refuses bodies with
  more than 20,000 JSON values with 413 `TOO_MANY_VALUES`, so an anonymous or value-heavy request can no longer hold
  the event loop while it is parsed (docs/adr/1526-*).
- Version restore (`POST /api/pages/:id/snapshots/:sid/restore`) and `PUT /api/pages/:id/collection/fields` run under
  the workspace write gate: an edit lock, agent block, role change or member removal committed while they run is
  re-checked in the transaction and the page is left untouched (docs/adr/1071-*, 1513-*, 1523-*).

## [0.11.0] - 2026-11-09

Database migration `0039_v011_later_threads` adds `later_items`, `thread_follows` and two columns on
`user_notification_settings` (`thread_auto_follow`, `thread_replies`, both on by default). It backfills
`thread_follows`: everyone who wrote in an existing comment thread follows it, so replies reach the same people as
before the upgrade. Upgrade matrix adds v0.10.0: CI also tests the upgrade from it with data
(`.github/workflows/upgrade.yml`, docs/adr/1052-*).

### Added
- Keyboard shortcuts people know from Notion and Obsidian: ⌘⇧D duplicates the block, ⌘Enter checks or unchecks a
  to-do, ⌘⌥S adds the open page to favorites or removes it, ⌘⌥\ opens and closes the right panel, ⌘⌥P turns pen mode
  on and off (Ctrl instead of ⌘ on Windows and Linux). Moving blocks (⌘⇧↑/↓), headings and text (⌘⌥0–3), lists
  (⌘⇧6–9), indent (Tab), underline, strikethrough and inline code were already there through the editor and are now
  listed (docs/adr/1401-*).
- The command palette (⌘P) lists every command that can run on the current screen with its key, including editor
  commands, and searches English and Korean names together, Korean initial consonants (ㄱㄹㅍ finds 그래프) and
  half-typed syllables. The commands you ran last come first. It works with the keyboard alone and is announced as a
  combobox with a list to screen readers (docs/adr/1402-*).
- The `?` shortcut window has a search box and groups keys by where they work: everywhere, on a page, in the editor,
  in the sidebar tree, in a database table, in pen mode (docs/adr/1403-*).
- Menu items with a key show it: pen mode in the page ⋯ menu, rename (F2) and delete in the tree's row menu, search
  and graph in the sidebar; tooltips of the favorite star, the right-panel and sidebar buttons and back/forward carry
  the key (docs/adr/1403-*).
- Change shortcut keys in Settings → Keyboard shortcuts: click a command's key and press the new one. Inkling refuses
  keys that would be typed as text or that the system or the browser never hands to a page (⌘W, ⌘Q, developer tools)
  and ⌘A/⌘C/⌘X/⌘V; it names the command that already uses a key and asks before moving it; it warns about keys a
  browser tab keeps (⌘N) and browser functions (⌘F, ⌘R) and lets you use them anyway. Commands without a key (Today's
  daily note, New database, Later, Threads …) can get one. A new key works at once, in open pages and editors too, and
  the `?` window, the palette and the menus show it. Default / Reset all put keys back; Export and Import move them to
  another device as a JSON file. Keys are saved per browser. Keys built into the editor (bold, headings, lists, moving
  blocks, undo) stay fixed (docs/adr/1404-*, 1405-*, 1406-*).
- Database tables work from the keyboard: arrows, Tab / ⇧Tab and Home / End move between cells; Enter or F2 edits (or
  opens the select list, or ticks the checkbox); in a text cell Enter saves and moves down and Esc cancels; Space ticks
  a checkbox; ⌫ / Del clears the selected cells; ⇧+arrows extend the selection for copy and paste; ⌘Enter adds a row
  and opens its title; ⌘⇧Enter opens the row as a page. Screen readers get a grid with row and column numbers, and the
  table is one Tab stop. These keys are in the shortcut list and can be changed (docs/adr/1407-*).
- **Later**: save a page (⋯ menu, or "Save this page for later" in the palette), a comment thread (clock button on
  its card) or a notification (clock button in the bell) to come back to it; the Later screen in the sidebar has Open
  and Done tabs. Reminders: in 20 minutes, this evening, tomorrow 9:00, next Monday 9:00 or a picked date and time, in
  the device's time zone; when it comes due you get a bell item and, with "Email right away", a mail. The sidebar
  shows how many reminders are due. An item whose page you can no longer open (made private, workspace left, two-step
  requirement) stays without its title and its reminder is not sent (docs/adr/1410-*, 1411-*).
- **Threads**: follow any comment thread (Follow thread on its card); threads you start or reply in are followed
  automatically. The Threads screen in the sidebar lists followed threads with new replies, newest first, with the
  number of new replies and the last one; opening a thread marks it read there and in the bell (docs/adr/1412-*).
- Settings → Notifications: "Follow threads I start or reply in" and "Notify me about replies in threads I follow".
- Palette commands for Later, Threads and "Save this page for later", without a default key (a key can be set in
  Settings). The registry also has "Follow / unfollow the thread" for the focused thread card, without a key and
  outside the palette (docs/adr/1410-*).
- MCP: read-only `later` tool lists the person's Later list with reminders (docs/adr/1413-*).

### Changed
- All shortcuts are defined in one registry and go through one set of rules (docs/adr/1400-*): ⌘ on a Mac and Ctrl
  elsewhere, never both; modifiers must match exactly; nothing fires while an input method is composing a character;
  on Windows a Ctrl+Alt combination that types a character on your layout (AltGr) types it; bare keys such as `?` and
  F2 never fire from a text field. Because modifiers match exactly, on Windows Ctrl+Alt+P no longer opens the palette
  (it is pen mode now), and Shift+arrow keys in the sidebar tree no longer move the selection (plain arrows do).
- ⌘L, ⌘D, ⌘. and ⌘⇧E are now handled inside the editor (Inkling's editor extension) instead of the window; ⌘L, ⌘D,
  ⌘Enter, ⌘⇧D and ⌘⇧E also work in the body of a database row. These editor commands look up their key on each key
  press instead of a keymap built when the page opens, so a changed key works without reopening the page
  (docs/adr/1406-*).
- The palette's "Open search" and "New document" are listed in the `?` window as "Search" and "New page".
- A reply in a comment thread now notifies the thread's followers instead of everyone who wrote in it. After the
  upgrade the two are the same people (backfill); unfollowing a thread or turning off reply notifications stops them.
  Mentions are unchanged. The agent inbox `reply` kind follows the same rule (docs/adr/1412-*).
- Later reminders (`later_reminder`) pass a page's or workspace's mute and the hourly notification caps, since you set
  them yourself; they are mailed at once with "Email right away" and are not agent inbox items (docs/adr/1411-*).
- Opening a single comment, reply or mention notification in the bell marks its thread read in the Threads screen
  ("Mark all read" does not).
- Sidebar: Later and Threads are new menus after Search; a saved menu order keeps them in their default place, and
  they can be hidden like the others. `SIDEBAR_MENU_IDS` adds `later` and `threads`.
- For API clients: new `/api/later` and `/api/threads` routes, `threadAutoFollow` / `threadReplies` in notification
  settings, `NotificationType` `later_reminder` ([docs/API.md](docs/API.md), "v0.11.0 additions").

### Fixed
- ⌘F (open every fold before the browser's find) took either ⌘ or Ctrl on every platform; it now follows the platform
  modifier like the other keys.
- In a database table, Enter that finishes a Korean (or other IME) syllable in a text or title cell no longer saves
  and closes the cell halfway through the word.

### Removed
- Unused interface texts left over from the old hand-written shortcut list and palette.

### Performance
- Later reminders, idle tick (nothing due): due rows are claimed through a partial index on `later_items(remind_at)`;
  p50 0.81–0.91 ms instead of 3.41–3.62 ms with a scan of 25,000 rows (4.0–4.2×).
- 10,000 reminders due at once (for example after a long downtime): claimed in 20 sweeps of 500 (444–460 ms) and
  written by the notification consumer in 3.2–3.3 s, 3.6–3.7 s in total; other notification events wait behind them.
- Reminders as future-dated outbox rows were measured and rejected: every notification pass would pay +1.3–1.5 ms p50
  for reminders not due yet (docs/adr/1411-*).
- The comment POST now also writes the author's `thread_follows` row in the same statement: at 1 client p50
  4.07–4.36 ms instead of 3.47–3.91 ms (+0.4–0.9 ms, slower in every round); at 16 clients p50 16.2–17.4 ms
  against 16.1–22.8 ms, within the spread; commits per request unchanged (6.16 / 5.17). Measured against v0.10.0
  with `apps/server/scripts/comment-post-bench.ts`, 4 interleaved rounds (docs/KNOWN-ISSUES.md, THREADS-2).
- Numbers and methods: [docs/PERFORMANCE.md](docs/PERFORMANCE.md).

## [0.10.0] - 2026-11-09

No database migration. Upgrade matrix adds v0.8.0 and v0.9.0: CI also tests the upgrades from them with data
(`.github/workflows/upgrade.yml`, docs/adr/1052-*).

### Added
- The sidebar can be resized: drag its right edge (200–480 px), double-click the edge for the default 260 px, or focus
  the edge and use ←/→ (Shift for bigger steps). The width is kept per device, like the line width; the phone drawer is
  unchanged (docs/adr/1350-*).
- Collection table: drag the right edge of a column header to set its width; the width is saved on the view for
  everyone who opens it. Double-click the edge to go back to the automatic width; ←/→ on a focused edge also works.
  People who cannot edit the collection can resize on their own screen only. `ViewConfig` adds `columnWidths` and
  `titleWidth` (docs/adr/1351-*).

### Changed
- Query blocks show a collection's person fields as the member's name and relation fields as links to the linked rows,
  instead of ids; linked rows you cannot see are left out and their ids are no longer sent (docs/adr/1320-*). `WHERE`
  and `SORT` compare the same: a person field by the member's name, a relation field by the titles of the linked rows
  you can see. `SORT Owner` follows the names in the column and `WHERE Owner = "Priya Nair"` or
  ``WHERE `Blocked by` = "Search ranking v2"`` match. Queries written with ids (`Owner = "<user id>"`,
  ``contains(`Blocked by`, "<row id>")``) keep working for members and visible rows. Matching is exact and
  case-sensitive, like select labels (docs/adr/1352-*). For API clients, person cells of `POST
  /api/workspaces/:id/query` are names (or `null`) and relation cells are `{ ref: 'page', pageId, title }` lists.
- Page routes, `PATCH /api/pages/:id/props` and `GET /files/:id` answer 404 instead of 403 to accounts outside the
  workspace (docs/adr/1301-*).
- A public page that shows an image uploaded to a page outside its link (for example a duplicated page shared on its
  own) no longer shows that image; upload it again on the shared page (docs/adr/1302-*).
- The unused `ReleaseNotice` component and its `pwa.releaseAvailable` / `pwa.releaseNotes` strings are removed (nothing
  rendered it; the admin status summary reports new releases).

### Fixed
- Data loss in pen mode: turning pen mode off (Done, Esc) or changing pages could leave the ink layer and its toolbar on
  screen. The leftover layer covered the page, so clicks on the text saved its old stroke list again, and when it had
  been closed before the ink loaded, those saves were empty and erased the page's ink with ordinary 200 answers. Each
  page now has exactly one layer and pen mode always closes; the word count, margin outline and heading folds no longer
  share a key with it either (docs/adr/1340-*). Ink erased this way cannot be brought back (there is no ink history).
- Pen mode: a stroke drawn right after turning pen mode on could vanish when the page's ink arrived, or replace all of
  it when the ink was slow or failed to load. Nothing is saved now until the ink is loaded; strokes drawn meanwhile are
  kept and saved after the load, and a failed load says so (docs/adr/1340-*).
- Pen mode: "Clear" asks once more ("Clear all?") before it erases the page's ink. Ctrl/Cmd+Z and Esc typed in a text
  field no longer undo strokes or close pen mode.
- Ink API: a `PUT /api/pages/:id/ink` without `expectedUpdatedAt` can no longer replace existing strokes with an empty
  list; it answers `412 INK_CONFLICT` with the current ink. This also stops the wipe from older bundles the service
  worker still serves until they update.
- Collection pages: the board and the table scroll from edge to edge of the page, so the fourth and later board columns
  (and table fields) are no longer cut at the page column. The page's "Full width" setting and the "Line width: Full"
  preference now apply to collection pages, and the page's menu in the sidebar offers "Full width" for collections
  (docs/adr/1321-*).
- Collection table: one long text value no longer makes every column as wide as that value; columns start at fixed
  minimums (title 240 px, fields 150 px) and share the remaining width, long text is cut with an ellipsis and shown in
  full on hover. The header row stays at the top while the page scrolls (docs/adr/1322-*).
- A member could not change a shared collection's properties (400 "Relation target collection not found") once another
  member had added a relation from it to their own private collection. Fields that are sent back unchanged now pass;
  only a new, re-targeted or newly two-way relation needs a target you can see, and a target you cannot see answers the
  same as one that does not exist (docs/adr/1353-*).
- Collection toolbar on phones: Sort & filter, Properties, New row and the ⋯ menu ran off the right edge of a 375 px
  screen. The actions now wrap onto their own line under the view tabs, and the Sort & filter panel opens across the
  screen (docs/adr/1354-*).

### Performance
- Query block display pass (names and links after LIMIT, at most 3 statements): +1.0 ms for 50 rows, +3.0 ms for 500
  rows over a 2,000-row collection. A lookup per row was measured at 320 ms for 500 rows and rejected.
- Query block `WHERE` / `SORT` on a person field: +0.4–1.5 ms per 2,000 candidate rows. Queries that compare no property
  run the same SQL as before.
- Regressions: `WHERE` / `SORT` on a relation field costs about 19–24 µs per candidate row (2,000 rows: `SORT` 11.3 →
  48.7 ms, `WHERE` 10.8 → 59.2 ms); on other collection fields +1.8 ms per 2,000 candidate rows (docs/adr/1352-*).
- Numbers and methods: [docs/PERFORMANCE.md](docs/PERFORMANCE.md).

### Security
- A workspace that requires two-step verification is now also left out of the cross-workspace reads of a member it
  blocks: `changes_since` and the agent inbox without `workspaceId`, `find_context` without `workspaceId`, `read_pages`
  (such pages are listed under `missing`), and notification mail (instant and digest; blocked items are dropped from
  mail and stay in the app). The same applies to MCP page facts (`GET /api/pages/agent-context`), workspace-level
  notifications such as AI summaries, member candidates found through the blocked workspace and the subscription list
  in notification settings. A blocked owner can no longer delete or restore the workspace (403 `TWO_FACTOR_REQUIRED`).
  A "you were added" notice of such a workspace shows up once two-step verification is on (docs/adr/1300-*).
- Someone outside a workspace now gets the same 404 for its pages, comments, change rows (`/api/changes/:seq/diff`),
  templates (`DELETE /api/templates/:id`), row properties (`PATCH /api/pages/:id/props`) and files (`GET /files/:id`) as
  for an id that does not exist. Before, an existing id answered 403, and a page in a workspace that requires two-step
  verification answered 403 `TWO_FACTOR_REQUIRED` with its workspace id. The same holds for webhooks
  (`/api/webhooks/:id`), trash restore and purge, vault sync write and delete, and moving a page under a page of another
  workspace (now the same 400 "Parent page is invalid" as a missing parent). MCP `reply_comment` answers "Thread not
  found" for a thread the caller cannot see (docs/adr/1301-*).
- Deleting a comment now needs the comment right on the page, like posting and editing one: an agent under a lock with
  "agents: read only" and a person with a view-only level can no longer delete threads (docs/adr/0970-*, 0971-*,
  1251-*).
- Public links serve only attachments of pages inside what they share. Before, a shared page could publish an
  attachment of any other shared page in the workspace by embedding its `/files/<id>` URL (docs/adr/1302-*).
- Query blocks: a filter or sort on a relation no longer tells whether a row links to a row that is private to someone
  else (hidden links compare as no links; their ids no longer match) (docs/adr/1352-*).

## [0.9.0] - 2026-11-08

Database migration 0038 adds `page_grants`, `page_invites` and `workspaces.guest_invite_policy`. It only adds; existing
members and pages behave as before until someone shares a page with a person.

### Added
- Guests: share a page tree with someone outside the workspace from the page's Share dialog by email, as Can view, Can
  comment or Can edit. Existing accounts get access at once; other addresses get an invitation (mailed, or a link to
  copy) that only an account with that address can accept. Guests see only the pages shared with them; workspace-wide
  screens, search, members and settings stay member-only (docs/adr/1250-*, 1252-*).
- Page levels for members: a member's own level on a page tree (view, comment, edit, or full, which manages people
  there) replaces the default edit; owners and admins always have full access. Enforced with the edit lock on every
  write path, the collaboration socket and MCP (`can:`, new error `PAGE_ACCESS`) (docs/adr/1251-*).
- Workspace settings: "Who can invite guests" (nobody / owners / owners and admins, the default / members who can edit
  the page) and a guest list with bulk removal. Audit actions `page.access_granted`, `page.access_changed`,
  `page.access_removed`, `page.guest_invited`, `guests.removed`.
- API tokens and MCP connections never reach workspaces where their owner is a guest; a workspace's two-step
  requirement applies to guests (docs/adr/1253-*).
- Heading folds from the keyboard (⌘. / Ctrl+.); on touch screens a tap on a heading shows its fold arrow; folded
  headings show "…" (docs/adr/1271-*).

### Changed
- Softer look: one corner scale (7, 10, 14, 18 px) for buttons, menus, cards and modals; rounded tables, images and code
  blocks; lighter shadows with an edge on the dark theme; drawn checkboxes (docs/adr/1280-*).
- Motion: menus, popovers and the slash menu scale in from their trigger; modals fade and scale (rise on phones); toasts
  slide up; menus, dialogs, toasts and tree folders animate out; tree folders open with a height reveal and a turning
  arrow. Everything is instant with reduced motion (docs/adr/1281-*).
- After inserting a divider, image, video, audio, file or plugin block from the `/` menu, the cursor goes to an empty
  line below it instead of the end of the next block (docs/adr/1270-*).
- "Share to web" is now "Share"; the dialog holds people and the web link. `WorkspaceDTO.role` can be `guest`;
  `PageLockDTO` adds `level` and `guest`.

### Fixed
- Text typed right after inserting a callout from the `/` menu landed in the block before or after it, and the math
  block and inline math lost their first keystrokes the same way (docs/adr/1270-*).
- Exporting a single canvas no longer resolves page nodes to titles of pages in other workspaces.

### Performance
- Members without page rows: no change (one EXISTS in the user lookup, visibility SQL unchanged). Accounts with rows:
  +0.3–0.5 ms per request. A guest opening a page: about 10 ms.
- Motion: scroll and typing on a 2,000-block page within noise; collapsing an open 1,024-row tree 59–81 → 27–39 ms.
- Numbers and methods: [docs/PERFORMANCE.md](docs/PERFORMANCE.md).

## [0.8.0] - 2026-11-08

No database migration.

### Added
- Outline in the right margin: short lines per heading on documents with three or more headings; hover or focus to
  list them and jump. Settings → Editor → Outline in the margin, per device (docs/adr/1220-*).
- Heading folds: hover a top-level heading and click the arrow to fold its section. Kept per device and page; the
  document is not changed and nothing is sent to other editors. A fold opens when the cursor enters it, on jumps from
  the outline, comments or `?block=` links, and on ⌘F (docs/adr/1221-*).
- Admin status summary: cards at the top of Admin (backups, storage, app, security settings, updates) and, when
  something needs attention, a one-line banner for admins that shows the same problem at most once a day.
  `GET /api/admin/status` (admin, browser session only). See docs/OPERATIONS.md "Reading the status summary"
  (docs/adr/1230-*…1233-*).
- Heavy-job cap: imports (Markdown, zip, Notion, folder), zip exports and page duplicates share `HEAVY_JOBS_MAX` slots
  (default 2) with a fair queue per person. Over the limit: 503 `HEAVY_JOBS_BUSY` or 429 `HEAVY_JOBS_PER_USER` with
  `Retry-After`. New env `HEAVY_JOBS_MAX`, `HEAVY_JOBS_QUEUE_MAX`, `HEAVY_JOBS_WAIT_MS`, `HEAVY_JOBS_PER_USER`
  (docs/adr/1240-*).

### Changed
- Callouts (no side stripe, radius 10, light tint), quotes (bar in text colour, text not greyed), dividers (lighter
  line), code blocks (light box with light colours on the light theme), toggle arrow, and the empty-block hint
  (upright, new wording) follow Notion more closely (docs/adr/1222-*).
- Opening a page: "Connecting…" shows only after 400 ms, the page fades without sliding, block handles fade in.
- The release check (`UPDATE_CHECK=github`) lists the last 20 releases in its one daily request and reports whether a
  newer release has a Security section; `GET /api/version/latest` adds `securityFix` (docs/adr/1232-*).
- `/workspaces/:id/import` writes the upload to disk before reading it.

### Fixed
- An aborted zip download no longer leaves an open file, its temp folder or its slot behind (docs/adr/1241-*).
- A workspace two-step requirement with 0 grace days now blocks at once even when the app clock runs ahead of the
  database clock (docs/adr/1242-*).
- Intermittent `[db]` test failures: one clock bug, the rest tests that assumed a database of their own; such files now
  run alone (`// run-tests: db-exclusive`) (docs/adr/1243-*).

### Performance
- Eight concurrent zip imports: memory growth +198–206 MB → +104–142 MB with 2 slots (total time 2.4–3.0 → 3.9–4.0 s).
  20 aborted exports: open files +18 → 0. Targeted flaky tests under load: 15 of 24 runs failing → 0 of 36.
- Admin status: 0.6 ms from cache, about 30 ms when recomputed (20,000 pages).
- Margin outline and folds on a 2,000-block page: scroll p95 17.6–18.5 → 18.2–18.6 ms, typing p50 within noise.
- Numbers and methods: [docs/PERFORMANCE.md](docs/PERFORMANCE.md).

## [0.7.0] - 2026-11-07

Database migration 0037 (row templates, webhook deliveries and secrets, API tokens and connection ranges) only adds
tables and columns. Existing MCP connections keep seeing everything; a connection's range only narrows access.

### Added
- Database row templates: up to 20 per database with a title pattern, property values (relative dates such as
  `today+7`, "whoever adds the row") and a body edited in the page editor; one can be the default. "New row ▾" picks a
  template or an empty row, and the board column and calendar day "+" use the default. Templates are not pages, so they
  never appear in search, links, the graph or MCP page lists. They travel with Duplicate, Save as template and template
  files. MCP `create_row` takes `template` and `inputs` (docs/adr/1180-*…1184-*).
- Generic webhooks: signed JSON (`X-Inkling-Signature: t=…,v1=…`, HMAC-SHA256) to any public https endpoint such as
  n8n or Zapier, with ids, names, titles and links only. The secret is shown once; a new secret keeps the old one valid
  for 24 h. Recent deliveries, Resend and Send test event in the settings; receiving guide in
  [docs/WEBHOOKS.md](docs/WEBHOOKS.md) (docs/adr/1190-*…1192-*).
- Connection ranges: an MCP connection or API token sees everything, chosen workspaces, or one page and the pages under
  it. Chosen on the consent screen and changeable in Settings → Connections; enforced at the permission boundary and
  tested route by route (docs/adr/1200-*, 1202-*).
- Personal API tokens for the REST API (`Authorization: Bearer ink_pat_…`): expiry, read-only or read-write, range;
  shown once, stored hashed, last use and IP listed, revoked with a password change; admins can revoke a user's tokens.
  `inklingctl login --token` and `INKLING_TOKEN` (docs/adr/1201-*, 1203-*). Browser-only routes refuse bearer tokens,
  listed in one table (docs/adr/1204-*).
- Retrieval evaluation for `find_context` with dev/test questions (MRR, recall@5, nDCG@5) and the scripts
  `context-tune.ts` and `context-explain.ts` (docs/adr/1213-*).

### Changed
- `find_context` ranking weighs words by how rare they are in the searched workspaces (BM25-style idf), counts query
  words that stand next to each other, and treats Korean particles and verb endings as one word (docs/adr/1210-*). A page
  shows at most two sections, the second only when it is nearly as good (docs/adr/1211-*). Results print the last
  heading and a short anchor (`§우리-팀-체크리스트`) instead of the whole heading path twice, "Also relevant" is one line
  per page, and the budget counts the real header size (a 1,500 budget used to print about 2,500 tokens).
  `read_page` and `patch_section` accept the short anchor (docs/adr/1212-*).
- All new-row paths (web, board, calendar, MCP `create_row`) use `POST /api/pages/:id/collection/rows`; a board or
  calendar row is one request instead of two. MCP `create_row` now sends the `page_created` webhook.
- A generic webhook is turned off after five failed events spanning at least 24 hours; Slack and Discord keep five
  failed events. The settings tab is called "Webhooks".
- Setting or resetting a password also revokes API tokens. `GET /workspaces` returns no invite codes to tokens.
- Easier-to-read pages: more space above headings than below (H1 32 px, H2 24 px, H3 16 px; was 14 px for all), so
  sections read as blocks; headings at weight 600 instead of 700; body text on dark one step brighter (#f0efed);
  Korean lines wrap between words instead of mid-word. Public pages follow the same rules. Measured against a Notion
  page with the same 16/24 px body text, where only these differed.

### Performance
- `find_context` on 15,693 chunks: dev MRR 0.848 → 0.897, recall@5 0.897 → 0.920; held-out test MRR 0.806 → 0.944,
  recall@5 0.861 → 0.926. On a copy of real data the field query that failed now shows one of its two answer sections
  (5th); the other still misses, because its key word is common there (docs/adr/1210-*, 1214-*).
- Board and calendar rows 1.6–1.9× faster (one request). Webhook consumer: 6.5 → 5.6 statements per delivery.
- Regression: `find_context` p50 26.6 → 35.3 ms, p95 63.3 → 88.7 ms (per-word flags). A subtree range adds 0.5–0.8 ms to
  `read_page`; lists and search under a range are faster because they return less.
- Numbers and methods: [docs/PERFORMANCE.md](docs/PERFORMANCE.md).

## [0.6.0] - 2026-11-07

Database migration 0036 (sign-in identities, log rotation, public-link expiry and passwords) only adds tables and
columns. Take a backup before upgrading as usual. If you never set `POSTGRES_PASSWORD`, read the first Security item
before you pull the new `compose.yaml`.

### Added
- Sign-in with an OpenID Connect provider (Google Workspace, Microsoft Entra ID, Keycloak, Authentik, …): "Sign in
  with <OIDC_NAME>" on the login screen. Authorization Code + PKCE, the id_token is checked against the provider's keys
  (fixed algorithm, iss/aud/azp/exp/nonce), no new dependency. Set `OIDC_ISSUER`, `OIDC_CLIENT_ID`,
  `OIDC_CLIENT_SECRET` and register `<PUBLIC_URL>/api/auth/oidc/callback` (deploy/DEPLOY.md "3-G"). Accounts are
  matched by issuer and subject; an existing account is linked by email only with `OIDC_LINK_EXISTING=1` and a
  provider-verified email, never for admins. Settings → Account lists connected sign-ins and can connect the provider
  to a local account. `OIDC_REQUIRE_MFA` refuses sign-ins that show no second factor (`amr`/`acr`). Accounts created
  by the provider count as verified for workspaces that require two-step verification (docs/adr/1160-*, 1161-*, 1162-*).
- Split a long page into subpages at its headings: page ⋯ → "Split into subpages…", MCP `split_page` (`dry_run`
  first). Block ids, comment threads and links into the page keep working, people with the page open see it change in
  place, and the version before the split stays in history. `[[Page#Heading]]` now links to the subpage made from that
  section, else to the page (docs/adr/1140-*, 1142-*).
- "New entries" setting for logs: appends through MCP `update_page` go to one subpage per month or to a new subpage
  past a size, and the tool says where it wrote. The owner of a large page gets one notification when something keeps
  appending to it (docs/adr/1141-*).
- Public links can expire (1/7/30 days or a date, by the server clock) and can have a password. Expired links answer
  "This link has expired" on every public route including folder subpages and files; owners can extend or remove the
  expiry. A password is asked once per link (12-hour cookie for that link only); changing it signs every visitor out;
  wrong guesses are slowed per link and ban the guessing IP, and every answer takes the same time. Protected and
  expired links show nothing in link previews and are marked noindex (docs/adr/1170-*, 1171-*).
- Workspace settings → Public links: a default expiry for new links and "Require a password on public links"
  (existing links are not changed) (docs/adr/1172-*). Audit log: `share.expiry_changed`, `share.password_set`,
  `share.password_changed`, `share.password_removed`.

### Changed
- Notification, webhook and change-feed events of comments, page create/rename/move/trash/restore/duplicate, row
  assignees and owner changes are written in the same transaction as the change. If the event cannot be written the
  change fails too, so nothing is saved without its event (docs/adr/1150-*).

### Fixed
- Comment create/edit, `update_page` and `patch_section` that start while a lock change, an agent block or a member
  removal is in progress wait for it and are judged by the result. A page edit by a member being removed that waited
  at the gate no longer gets through (docs/adr/1151-*).

### Performance
- 16 concurrent comment posts: p50 20.6–24.2 → 17.0–17.8 ms, 605–741 → 839–885 req/s; notifications are processed in
  batches and the queue drains 296–358 → 43–47 ms after the last request (docs/adr/1150-*).
- Splitting the 4.5 MB log leaves a 105 KB page (−97.7%) in 0.5–0.7 s. Appending to a monthly log instead of the large
  page: p50 538–611 → 29–39 ms, event-loop stall 354 → 8–15 ms.
- Regressions: `update_page` append +3–4% (write gate transaction and the rotation lookup, +3–4 ms).
- Numbers and methods: [docs/PERFORMANCE.md](docs/PERFORMANCE.md).

### Security
- `POSTGRES_PASSWORD` no longer falls back to `nodian`: `compose.yaml` refuses to start without it. If you never set
  it, put `POSTGRES_PASSWORD=nodian` in `.env` to keep the existing volume working, then change the role's password
  (`ALTER ROLE nodian PASSWORD '…'`) and `.env` together. `pnpm db:up` for development still uses `nodian`.

## [0.5.0] - 2026-11-07

Database migration 0035 is applied on first boot. Take a backup before upgrading ([docs/BACKUP.md](docs/BACKUP.md)).
At start-up share links, invite codes and signup keys are converted to hashes (they keep working), and pages are
stored in the Yjs V2 format from their next save. Going back to 0.4.x is only safe by restoring the pre-upgrade
backup; if you must keep newer edits, stop the server and run `apps/server/scripts/states-to-v1.ts` first, and expect
share links, invite codes and signup keys to stop working (docs/adr/1101-*, 1110-*).

### Security
- Share-link tokens, invite codes and signup keys are stored as SHA-256 only; the copy used for "Copy link" is
  encrypted with `APP_SECRET_KEY`. Used signup keys are no longer shown again. Existing links and keys are converted at
  first boot and keep working (docs/adr/1110-*).
- Slack/Discord webhook URLs and sheet-sync URLs are encrypted with `APP_SECRET_KEY`; without the key they stay
  plaintext and the server logs a warning at boot (docs/adr/1111-*).

### Added
- Workspace settings → Security → "Require two-step verification" (owners and admins, grace period 0–30 days, 7 by
  default). After the grace period members without two-step verification, and their agents, get 403
  `TWO_FACTOR_REQUIRED` and are sent to the setup screen. Accounts that sign in through another service count as
  verified. Changes are in the audit log (docs/adr/1112-*).
- `[[Old name]]` still opens a page after it was renamed (docs/adr/1121-*).
- Graph: colour by link island, "Show only this island", and a list of pages with no links;
  `GET /api/workspaces/:id/graph/islands` (docs/adr/1123-*).
- Large pages: a one-line notice at the top of a large page, and a "Large pages" list in workspace settings for owners
  and admins with page and version-history sizes (docs/adr/1103-*).
- Settings → About: version, links to the user guide and the GitHub repository.

### Changed
- Settings is split into sections listed on the left (Account, Security, Notifications, Editor, Sidebar, Files &
  links, Appearance, Connections, Keyboard shortcuts, About). On a phone the list opens first and the header's back
  button returns to it. Sections have their own links (`/w/<id>/settings#sidebar`). Rows are separated by thin lines
  instead of boxes, and settings kept in this browser only are tagged "This device" (docs/adr/1130-*).
- Settings → Editor: "Full" line width is its own toggle; line width and zoom reset from a small icon next to the value
  (the zoom −/+ buttons are gone, the slider takes arrow keys). "Confirm before deleting" moved from Trash to Files &
  links. Settings → Keyboard shortcuts uses the same list as the `?` dialog, with a search box. Settings → Sidebar: the
  ↑/↓ buttons appear on hover or keyboard focus (always on touch screens).
- Accounts that sign in through another service no longer see the password fields.
- Dropdowns use one quiet look with a thin chevron instead of the OS control. In Chromium-based browsers with a mouse
  the opened list follows the app theme too (customizable select); touch screens keep the OS picker.
- Imports store identical attachments once and merge Notion pages that share a Notion id. The Notion report gains
  `merged: { pages, attachments }` and `attachments` counts files actually stored; zip and folder imports return
  `duplicateAttachments` (docs/adr/1122-*).
- `SnapshotDTO.bytes` is the stored size, so versions saved as a diff show a few KB. Preview, compare and restore answer
  409 `SNAPSHOT_UNAVAILABLE` when a version cannot be rebuilt.

### Performance
- Version history is stored as Yjs diffs against the previous version, with a full state every 10th version and on any
  doubt. 50 versions of a 4.5 MB page: 107 MB → 9.3 MB raw, 33.7 MB → 2.16 MB on disk (docs/adr/1100-*). The first
  version after the upgrade is a full one.
- Page state is stored in Yjs V2: −29 to −32% raw, −48% on disk. Old rows are read as they are and rewritten on the
  next save without side effects (docs/adr/1101-*).
- A save encodes the document once instead of twice (2.1–4.0× faster); `update_page` append p50 −10%, `patch_section`
  p50 −10 to −16% on a 4.5 MB page (docs/adr/1102-*).
- Shared union-find module for link islands; `[[title]]` lookup with 1,000 former titles stays at ~10 ms p50 on 5,000
  pages (docs/adr/1120-*).
- Measured and not adopted: SIEVE and S3-FIFO instead of LRU for the section, ACL and formula caches (−6.5 to +0.6 pp
  hit rate at the sizes in use, docs/adr/1124-*); rendering only the visible part of the editor (docs/adr/1104-*).
- Regressions: on a 4.5 MB page at the 50-version limit an automatic version takes 55–88 ms instead of ~5 ms (event loop
  stall up to 42–75 ms, once per 10 minutes of editing); other requests' p95 during `patch_section` 304 → 426–473 ms.
- Numbers and methods: [docs/PERFORMANCE.md](docs/PERFORMANCE.md).

## [0.4.0] - 2026-11-07

Database migration 0034 (two-step verification, outbox, workspace access versions) is applied on first boot. Take a
backup before upgrading ([docs/BACKUP.md](docs/BACKUP.md)) and stop the old server before starting the new one against
the same database (docs/adr/1080-*). Session tokens are converted to hashes at start-up, so going back to 0.3.x signs
everyone out. Set `APP_SECRET_KEY` (32+ characters) if members should be able to turn on two-step verification.

### Security
- Session tokens are stored as SHA-256; existing sessions are converted at start-up and nobody is signed out
  (docs/adr/1060-*).
- State-changing API requests and the collaboration socket are refused (403 `CROSS_SITE_REQUEST`) when the browser
  Origin is not `PUBLIC_URL`/`APP_URL`. Requests with an `Authorization` header (MCP, CLI) are not affected
  (docs/adr/1062-*).

### Added
- Two-step verification with an authenticator app (TOTP) and 10 single-use recovery codes, in Settings; admins can turn
  it off for a member who lost their phone. Requires `APP_SECRET_KEY` (docs/adr/1061-*).
- Settings shows the running version and build at the bottom, and the server's when they differ.
- Settings → Editor → Line width: a 600–1200 px slider or "Full" per device, 700 px by default (replaces "Readable line
  length": on → 700 px, off → Full). A page's "Full width" still wins.
- User guide for invited users ([docs/GUIDE.md](docs/GUIDE.md), [한국어](docs/GUIDE.ko.md)); README.ko.md rewritten;
  SECURITY.md covers supported versions, private vulnerability reporting and scope.

### Large pages
- The section index now covers the whole page (it stopped at 200 KB), so the newest entries of a long log are found by
  `find_context`; page_texts keeps the first and last 100 KB, so `search` finds them too. The first boot re-indexes only
  pages that may have been cut (docs/adr/1040-*).
- `read_page` outline/section answer from the section index while it reflects the document: on a 4.5 MB page outline
  150 → 7 ms and a repeated section 165 → 7 ms. `update_page` append 1.6 s → 0.55 s; `patch_section` append −20–35%.
  Stores of an unchanged document no longer write, snapshot, re-index or bump `updated_at` (docs/adr/1041-*, 1042-*).
- MCP tools print a "large page" line (state ≥ 1 MiB or ≥ 50k tokens) asking agents to read by section and write new
  entries to child pages (docs/adr/1043-*).

### Performance
- MCP page tools compute the agent context in process instead of a second REST call (docs/adr/1070-*): `read_page`
  2 → 1 internal request, 14.4 → 10.4 statements, p50 10.8 → 9.0 ms; `update_page` 39.6 → 33.6 statements, p50
  30.3 → 27.3 ms.
- Workspace access version and write gate (docs/adr/1071-*): writes in a workspace without locks skip the lock walk;
  with locks it runs once per page and version. Agent blocks and instruction pages are cached by that version, so a block
  or a lock change applies to the very next call. Lock, block, move and owner changes wait for writes in progress.
- Change feed, notifications and webhooks go through a transactional outbox (docs/adr/1080-*, 1081-*). Writes no longer
  queue behind each other's change-log writes (title PATCH at 16 concurrent clients p50 −14%, a write in another
  workspace during a burst −37%), and change-feed order also holds with more than one server process. Notifications
  survive a crash or restart and are written exactly once; webhooks are delivered at least once with a stable
  `X-Inkling-Delivery` header, retried with capped backoff. The activity screen may trail a write by up to 1 s. Comment
  POST at 16 concurrent clients is slower (+38% p50).
- Review score of one page 117 → 4.3 ms; audit-log cleanup with nothing to delete 28–34 → 0.4 ms (new index).
- Numbers and methods: [docs/PERFORMANCE.md](docs/PERFORMANCE.md).

### Changed
- Quieter document screen (docs/adr/1090-*): the top bar keeps bookmark, share, who is online, the right panel and the
  notification bell; pen mode, edit lock, page notifications, PDF export and theme moved to the ⋯ menu (a dot on ⋯ and
  a check on the item show a lock or a followed page).
- Editor look: no lighter box behind the body in dark mode, table borders in the theme line colour, body headings one
  step smaller than the page title (H1 1.75em, H2 1.4em, H3 1.2em). Cover, icon and title start on the same line as the
  body text.
- Pages without a chosen icon show a muted line icon in the sidebar and lists instead of 📄/📁, and no default icon above
  the title.
- Markdown, zip and Notion imports drop a first `# Heading` that repeats the page title. Existing pages are unchanged.
- Korean UI wording: 코멘트 (not 댓글), 데이터베이스 (not 컬렉션), 버전 히스토리.

### Deployment
- Prebuilt images: every release is published as a multi-arch image (linux/amd64, linux/arm64),
  `ghcr.io/prove1352/inkling:X.Y.Z` (also `X.Y` and `latest`). Pin a release with `INKLING_VERSION` in `.env`
  (docs/adr/1050-*).
- `compose.yaml` runs that image by default: upgrade with backup → `git pull` → `docker compose pull app` →
  `docker compose up -d app` ([docs/OPERATIONS.md](docs/OPERATIONS.md)). `docker compose up -d --build` still builds
  from source; to keep source builds apart from releases, add `compose.build.yaml` (docs/adr/1051-*).
- CI tests the upgrade from every earlier release with data before an image is published (docs/adr/1052-*).
- `deploy/cli-token.sh` stores session tokens hashed; revoke by the printed hash prefix.

## [0.3.1] - 2026-11-07

Database migration 0033 (adds `users.sidebar_prefs`) is applied on first boot. Take a backup before upgrading.

- Sidebar menus (docs/adr/1020-*): choose which of Search, Graph, Tags, Web shares, Due, Calendar, Activity and Today
  appear at the top of the sidebar and in what order, in Settings → Sidebar (toggle, drag or ↑/↓, "Reset to
  default"), or right-click / long-press a menu → "Hide from sidebar". Saved to your account, so all your devices
  match; hidden menus still open from the ⌘P palette (which gains Calendar and Activity) and their shortcuts.

## [0.3.0] - 2026-11-07

Database migrations 0031 (notifications) and 0032 (drops the unused `pages.is_template` column) are applied on
first boot. Pages still flagged as legacy templates, if any, become normal pages (docs/adr/0920-*). Take a backup
before upgrading ([docs/BACKUP.md](docs/BACKUP.md)).

- Notifications (docs/adr/1000–1004): body @mentions now notify (people's right away; mentions an agent writes
  arrive quietly and in the digest), plus replies in your threads, document owner and person-cell assignment, and
  edits of pages you follow. Repeats collapse into one item per page or thread; hourly caps; only people who can see
  the page are notified.
- Subscriptions per page or subtree: all / mentions (default) / nothing / mute, "Follow", and a daily summary when AI
  edits under a page. Mute also silences mentions; only approval requests addressed to you will pass it.
- Mail: instant mail for mentions, replies and assignments (cancelled when read in the app first) and a daily or
  weekly digest, with per-user settings in Settings → Notifications (en/ko). Servers without SMTP keep everything in
  the app. Webhooks gain `assigned` and a daily `agent_digest`.
- Activity screen: people's and AI changes newest first with filters (people/AI/client/member/subtree/kind/AI-created
  pages) and a diff per change; version history can compare a snapshot with the current page; pages show "Written by
  AI · last AI edit".
- MCP: `inbox` / `ack` (agent inbox with a cursor), `list_comments`, `reply_comment`, `resolve_comment`, and
  `add_comment(section)`. Agents can resolve only threads their person started. `create_page`, `import_folder` and
  `create_from_template` now record the client (`via`) on the created pages.
- Locked pages: canvas nodes, collection cells and the properties panel are read-only in the UI too.
- OAuth client names: a client named like a member is refused only in the workspaces where that member is (exact
  match), and common app names such as Claude only get a warning on the consent screen (docs/adr/1007-*).

- Math (KaTeX, docs/adr/0995–0999): display equations ("Math block") and inline equations. Click one to edit its
  LaTeX with a live preview; create them from the slash menu ("Math"/"수식"), with ⌘/Ctrl+Shift+E, or by typing
  `$x^2$` (prices like `$5 and $10` stay text). Errors show the source and KaTeX's message; links, images, HTML
  and macro definitions are refused. Rendered in the browser only (cached, time-sliced, paced per frame), in both
  themes, on phones, on public share pages and in PDF/print. KaTeX and its fonts load only on pages with math.
- Markdown and MCP: math is `$$ … $$` (block) and `$…$` (inline) in export, `read_page`/`find_context` output and
  `update_page`/`patch_section`/import input ([docs/MCP.md](docs/MCP.md)); the server keeps math nodes when it reads
  a document. Notion import now brings equations (and LaTeX code blocks) in as math instead of code. Existing
  ```` ```latex ```` code blocks are not converted.
- Jumping to a block (from the calendar, comments or `?block=`) now stays on the block while the page above it is
  still rendering, instead of landing far away on long pages (docs/adr/0998-*).
- Docs: performance log ([docs/PERFORMANCE.md](docs/PERFORMANCE.md)).

### Fixed
- Security: the prompt-injection URL rules backtracked on crafted text (cubic time). 20 KB of text such as
  `http://?` repeated took up to 19.5 s to index and blocked the server meanwhile; it now takes under 1 ms
  (180 KB: about 3 ms). Detection is unchanged ([docs/PERFORMANCE.md](docs/PERFORMANCE.md)).

## [0.2.0] - 2026-11-07

Database migrations 0028–0030 are applied on first boot. Take a backup before upgrading
([docs/BACKUP.md](docs/BACKUP.md)).

### Agents (MCP)
- `find_context`: section-level retrieval that packs the most relevant sections into a token budget,
  instead of searching and reading whole pages. On a 5,000-page benchmark: about 72% fewer tokens per
  question, one call instead of ~3.7, and the expected answer was in the returned context for 93% of
  questions (the old search-then-read flow: 75%).
  Benchmark script: `apps/server/scripts/context-bench.ts`.
- `read_page` gained `outline`, `section` and `maxChars`; new `read_pages` for batch reads.
- `changes_since`: cursor-based change feed with line diffs, so an agent can update its own notes
  incrementally.
- `patch_section`: edit one section with a version check. It applies a minimal edit (block alignment
  and character diff), so a person typing in the same section at the same time keeps their text.
- Collection tools: `query_rows` (filters, sort, fields, paging), `create_row`, `update_row`.
- `get_instructions` and agent instruction pages (always / path match / manual). Only locked pages can
  be instruction pages.
- OAuth `read` / `write` scopes; read-only connections cannot write.
- Writes made through an agent are recorded as "via <client>" in history, comments and the change feed.
- Tool output is deterministic and ordered for prompt caching.
- User-written content in tool output is wrapped as untrusted data, invisible characters are removed,
  and injection-like text is flagged. This is a mitigation, not a security boundary.
- `AGENTS.md`, `llms.txt` and [docs/MCP.md](docs/MCP.md) describe how agents should use the server.

### Collaboration
- Edit lock for a page and everything under it: choose who can edit, and separately whether agents can
  edit, comment or only read. Enforced on every write path, including live editing.
- Workspace settings screen: general, members, public links, connected agents, audit log, review,
  Slack & Discord, danger zone. New `admin` role.
- Connected agents per workspace, with workspace-level blocking.
- Append-only audit log for admin actions, written in the same transaction as the action.
- Member-add policy (default: owners and admins) and an invite-link switch.
- Workspace-wide switch to disable public web pages, with bulk unpublish.
- Export policy and configurable trash retention.
- Page owners, review dates and a daily review priority (reads x probability of being stale), with
  living-document and archive-candidate lists and a `review_due` webhook digest.

### Import
- Notion "Markdown & CSV" export zips, including nested part zips: hierarchy without hash suffixes,
  internal links, attachments, CSV databases with typed columns and relations, and an import report.
- Import size limits are configurable with environment variables.

### Updates
- The server sends its build id on every API response; open tabs show a "new version" banner on every
  screen. `UPDATE_MODE=force` reloads automatically once edits are synced.
- Optional check for newer GitHub releases on the admin page (`UPDATE_CHECK=github`, off by default).

### Fixed
- Reading a live document on the server deleted blocks the server schema does not know (callouts,
  page embeds, @mentions). Affected quick task add, MCP `update_page` append and vault-sync snapshots.
  `update_page` append now only adds blocks at the end.
- The "new version" prompt could disappear without updating when a newer deploy arrived first, and was
  not shown outside the main layout.
- Any member could change a page's owner.
- Agent client names that imitate the product, an admin or a workspace member are rejected.

## [0.1.0] - 2026-11-07

First public release.
