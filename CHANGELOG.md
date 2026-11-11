# Changelog

All notable changes to Inkling. Versions follow [Semantic Versioning](https://semver.org/); while the
version is `0.x`, minor releases may change APIs, MCP tools and the database schema (migrations run
automatically on boot). Design decisions are in [`docs/adr/`](docs/adr/README.md); open problems in
[`docs/KNOWN-ISSUES.md`](docs/KNOWN-ISSUES.md).

## [Unreleased]

## [0.20.0] - 2026-11-11

> **Reload open tabs after the upgrade.** A tab that still runs 0.19 or older cannot show columns, and its editor
> would delete a group of columns with everything inside it. 0.20 lets such a tab read pages with columns but not
> edit them, until it is reloaded (below and docs/adr/2425-*).

A minor release with columns, charts on public links and better `find_context` answers for Korean questions. Blocks can sit side by side in
two to four columns (`/2단`, `/3단`); agents, Markdown downloads, zip export and vault sync carry them as comment
markers. A tab of an older release can no longer delete them: each client tells the server which document schema it
knows, and the server takes edits only from clients that know every node on the page. `find_context` counts the
shorter form of a long Korean word in titles and headings, prefers sections with the question's rarest word and
gives title words their real weight. A public link can now show the page's charts, drawn as charts from labels and
numbers, once an owner or admin turns it on for that link; public pages also draw callouts (icon, then text) and
text and background colours as the editor does. One database migration, additive: `0061_share_include_charts` (three
columns on `pages`; a 0.19 database goes from 61 to 62 applied migrations, and every existing link keeps charts off).
No new dependency, two optional settings (`EMBEDDING_QUERY_PREFIX`, `EMBEDDING_PASSAGE_PREFIX`). The MCP tool list is unchanged (48 tools,
32 in core; same descriptions and sizes). Upgrade matrix adds v0.19.0 and v0.19.1.

Checked in Chrome only (desktop and a 390 px window): the columns check (31 steps), a 0.19.1 build against the 0.20
server (10 steps), public charts (27 steps), public callouts and colours (16 steps) and the 0.19 browser checks passed; none of it was tried in Safari, Firefox or on a touch device
(docs/KNOWN-ISSUES.md, "Added in 0.20.0").

### Upgrade notes
- **Tabs left open over the upgrade** (docs/adr/2425-*). Pages without columns: nothing changes, a 0.19 tab edits
  them as before. Pages with columns: a 0.19 tab gets a read-only connection. It shows the page without the group,
  under its lock line ("Locked · … You can read and comment, but not edit": 0.19 reads a read-only connection as a
  lock), next to its own "A new version is available. Reload" notice; typing does nothing and nothing it does
  reaches the page. When someone adds columns to a page a 0.19 tab has open, that tab turns read-only the same way
  within a moment; what it sent in that moment is dropped. After Reload the tab runs 0.20 and edits normally. A 0.19
  tab with offline copies on (the installed app) keeps its editor's deletion of the group as an unsent edit; 0.20
  keeps that edit as a recovery item ("Made by an older version of the app") instead of sending it. A row template
  body with columns refuses saves from a 0.19 tab (409 `SCHEMA_OUTDATED`).
- **Proxies**: the collaboration socket URL now carries a query string (`/collab?schema=2`). Path rules such as
  Caddy's or nginx's `location /collab` need nothing; a rule that compares the whole request URI must allow it. A
  proxy that strips the query makes every 0.20 tab look like 0.19: read-only on pages with columns.
- **Migration 0061** (the only one) adds `pages.share_include_charts` (boolean, default false), `pages.share_charts_by`
  (uuid, references users, on delete set null) and `pages.share_chart_sources` (jsonb, the approved chart sources).
  Additive; every existing link keeps its behaviour (charts off) until a manager turns them on in the share dialog.
  Chart numbers on public pages can be up to 10 minutes old (the public render cache); the switch and the person's
  membership apply at once.
- No re-index: the new `find_context` rules work at query time. Answers to Korean questions can be ordered
  differently from 0.19; answers cached in memory are dropped by the restart.
- **Going back to 0.19.1** should need no database restore: 0.19 does not read the three new columns (0061 stays
  applied); starting 0.19.1 on a database with 0061 was not tried. But
  0.19 does not know columns and has no guard: its editor deletes a group with its content as soon as someone opens
  the page; do not go back once columns are in use. A page whose link showed charts, published again while 0.19
  runs, keeps the chart setting on for its new link once 0.20 runs again (KNOWN-ISSUES SHARE-9). Not checked beyond
  that.
- **Semantic search**: `EMBEDDING_QUERY_PREFIX` and `EMBEDDING_PASSAGE_PREFIX` are empty by default, so nothing
  changes. Setting, changing or removing one re-embeds every section at `EMBEDDING_REQUESTS_PER_MINUTE`; until that
  finishes, sections without a new vector are found by their words only (docs/OPERATIONS.md).
- API: `GET /api/pages/:id/sync-check?schema=N` (new query) answers `needs` when N is below the server's document
  schema; `PATCH /api/collection-row-templates/:id` takes `schema` (409 `SCHEMA_OUTDATED`); page bodies with columns
  carry `<!-- inkling:columns -->` marker lines in every Markdown format; `PATCH /api/pages/:id/share` takes
  `includeCharts` and `approveChartSources`, `ShareStatusDTO` and `PublicPageDTO` gain chart fields (docs/API.md,
  "v0.20.0 additions").

### Added
- **Columns** (docs/adr/2420-* .. 2424-*). Put blocks side by side: `/2단` or `/3단` in the slash menu (English "2
  columns", "3 columns"; `/columns` and `/단` find them too) turns an empty line into a group of empty columns with
  the caret in the first one (on a line with text the group goes below it). Any ordinary block goes in a column:
  text, headings, lists, to-dos, images, code, callouts, toggles, tables, embeds. Drag the boundary between two
  columns to change their widths (each keeps at least 15%), double-click it to make them equal. The block menu (⋮⋮)
  of a block in a column adds **Add column** (up to four), **Delete this column** (its blocks move to the column on
  its left) and **Unwrap columns** (everything back as ordinary blocks, in order). Nothing tidies a group on its
  own: an empty column stays until you delete it; Backspace in a group whose columns are all empty removes it.
  Below 640 px of width (phones, a side peek) the columns stack in order. Public links, presentation mode, PDF and
  print, page embeds and the offline copy show the columns, and the image viewer opens on images inside them;
  agents, Markdown downloads, zip export/import and vault sync write them as `<!-- inkling:columns -->` /
  `<!-- inkling:column -->` / `<!-- /inkling:columns -->` lines. A heading inside a column is not a section.
  Written against @blocknote/core's public API; BlockNote's GPL multi-column package is not used. No new
  dependency.
- **Charts on public links** (docs/adr/2440-* .. 2444-*). A public link can now show the page's charts: the share
  dialog says "N charts on this page do not show on the public link" and offers **Show charts on the public page**
  (owners and admins; off by default, per link, audited). When it is on, each chart's labels and numbers are
  published — worked out with the access of the person who turned it on, while they are a member of the workspace,
  and only for the databases and queries the charts used when it was turned on (a chart added later over another
  database waits: "N newly added charts are not public yet", **Publish these charts too**) — never the rows behind
  them, the database's or view's name, or any id or query text. Public pages draw charts with the app's own chart
  component (also in presentation mode, print and "Save as PDF"; scaled to the paper), with the table underneath for
  screen readers, readers without scripts and the Markdown download. A chart inside a column stands in that column
  (its title and table too). The chart code loads only on pages that have a chart. Without the switch, a folder
  link's charts of its own databases are now drawn as charts instead of tables; everything else is as before.
- **Document schema version** (docs/adr/2425-*). Every client says on its collaboration socket which document
  schema it knows (0.20 = 2; none = 0.19 and older = 1). On a page that holds a node type the client does not
  know, its connection is read-only, from the start or from the moment such a node arrives, so an older editor
  never deletes what it cannot show. 0.20 shows "This page has content that only a newer version of the app can
  edit. Reload to update." when that happens to it in a later release.
- **Role prefixes for embedding models**: `EMBEDDING_QUERY_PREFIX` and `EMBEDDING_PASSAGE_PREFIX` (optional, empty
  by default) for models that expect them, such as the e5 family (`"query: "`, `"passage: "`). Changing either one
  re-embeds every section, as a model change does (docs/adr/2404-*).
- Developers: a recall evaluation set for `find_context` (32 questions written the way people remember pages, over
  three workspaces) with page@1, page@3 and page MRR in `apps/server/scripts/context-bench.ts` and
  `context-tune.ts` (docs/adr/2400-*).
- **Korean deployment, operations and backup guides**: `deploy/DEPLOY.ko.md`, `docs/OPERATIONS.ko.md` and
  `docs/BACKUP.ko.md`, with the same sections, anchors and code blocks as the English files. The Korean README and
  user guide link to them; each English file links to its Korean one.
<!-- w20b:annotations-changelog -->

### Changed
- **find_context finds pages people describe with a longer word than the page uses** (docs/adr/2401-* .. 2403-*):
  a Korean query word of three or more syllables also counts, with a discount, when its shorter form (the word
  without the last syllable, e.g. 택배함 → 택배, 회의록 → 회의) is in a page title or heading. Sections that miss the
  question's clearly rarest word rank a little lower (×0.75), and words that appear only in titles now carry their
  real weight instead of the "unknown word" minimum. Query time only: no migration, no re-index. On the new recall
  evaluation (32 questions over three workspaces): tuning (dev) questions page@3 0.875 → 1.000 (own workspaces) and
  0.813 → 0.938 (with a 5,000-page workspace); held-out (test) questions page@3 unchanged at 0.938 in both, page@1
  0.750 → 0.813 and page MRR 0.844 → 0.885 with the large workspace, unchanged on own workspaces. Existing questions
  unchanged or better except one test question that loses its second relevant section; latency unchanged.
- **patch_section on a section that holds columns** keeps the group: sent back unchanged it stays as it is (same
  block ids), with any change inside it is replaced whole (the blocks in it get new ids); it is never merged with
  an ordinary block. `update_page` replace of a page with columns keeps the blocks around the group instead of
  rewriting the page (docs/adr/2424-*).
- **find_context's section text writes columns with read_page's marker lines**, without indenting the blocks
  inside, so a section copied from find_context into patch_section keeps its group (docs/adr/2424-*).
<!-- w20b:site-changelog -->

### Fixed
- Public links: a callout shows as in the editor, its type's icon and then the text, with line breaks, inline code,
  bold and links flowing inside the tinted box. Since 0.12.0 the text took the icon's place and stood in narrow
  side-by-side columns that ran out of the box (and widened the page on phones) (docs/adr/2387-*).
- Public links: each callout type has its own tint again (note, tip, warning, danger, info), not the note blue for
  all (docs/adr/2387-*).
- Public links: text colour and background colour, on words, whole blocks and table cells, show as in the editor in
  the light and dark themes; printed or saved as PDF they use the light colours (docs/adr/2387-*).
- A section patch that the server refuses no longer shows up as an unhandled promise rejection in the server log
  (`gatedTransact`, docs/adr/2424-*).
- Documentation: deploy/DEPLOY.md gives the language menu as Settings › Appearance › Language and the sign-in link
  as "Forgot your password?", writes every menu path with ›, says plainly why plain HTTP (3-A) is for testing only,
  and ties `deploy/local.sh`'s missing setup link to an image older than 0.17 instead of an unpublished one.
  docs/BACKUP.md names `SHA256SUMS` as the file a tamperer would have to rewrite. docs/OPERATIONS.md points at the
  BACKUP.md sections that exist, gives `effective_cache_size` as at most `PG_MEM_LIMIT` minus `shared_buffers` (as
  both example columns already were), says that edits made offline are kept on the device when offline copies are
  on, that it is a new VAPID key (not `APP_SECRET_KEY`) that voids push subscriptions, who a "manager" of public
  charts is (a workspace owner or admin), and that `deploy/local.sh` makes a hex `POSTGRES_PASSWORD` and a base64
  `APP_SECRET_KEY`. The user guide and docs/MCP.md say what the untrusted-content marking does not do: it helps an
  agent tell notes from instructions but does not stop an injection by itself; read-only connections, ranges, edit
  locks, suggestions and version history are what limit an agent. The Korean files carry the same fixes.

### Performance
- Web bundle against 0.19.1 (365b664), both built from `git archive` and measured back to back: entry `index-*.js`
  447,198 → 449,412 B (122,995 → 123,356 B gzip); entry plus modulepreload 1,374,102 → 1,381,039 B (404,604 →
  406,213 B gzip); entry CSS 19,717 → 20,944 B gzip (column, public callout and colour styles); the column code sits
  in the editor chunk (CollabEditor, 126,070 → 130,001 B gzip, after the chart adapter left it); precache 107 → 109
  entries, +36,890 B ([docs/PERFORMANCE.md](docs/PERFORMANCE.md)).
- Public charts (docs/adr/2442-*): a public page with charts loads `PublicChartMount` (1,392 B gzip) and its CSS
  (226 B), the chart adapter (961 B) and `ChartRender` (50,822 B, the app's chart chunk) only when the page has a
  chart; a page without charts requests none of them. The share dialog's chart count of a folder link with 300 large
  pages that all hold a chart takes about 0.36 s (26 ms with one chart page) ([docs/PERFORMANCE.md](docs/PERFORMANCE.md)).
- `find_context` latency with the new word rules is unchanged (p50 36.2 → 34.6 ms, p95 102.2 → 90.8 ms on 15.8k
  sections, interleaved runs). The document schema guard costs current clients one comparison per message; on the
  server a keystroke costs nothing measurable and a new block in a 2,000-block group about 50 µs
  ([docs/PERFORMANCE.md](docs/PERFORMANCE.md)).
- Measured and not adopted: semantic search with `multilingual-e5-small` and the role prefixes above, fused by the
  0.20 code as it is. With 5,000 extra pages, page@1 on the held-out questions went 0.848 → 0.939 but on the tuning
  questions 0.867 → 0.844; on the private check 0.944 → 0.917 (page@3 0.972 → 1.000). Answers took 1.7× (private) to
  7.5× (benchmark) the tokens, and each question 33–40 ms more at p50. Nothing changes in the code or the defaults
  (docs/PERFORMANCE.md, "Rejected / no effect").

## [0.19.1] - 2026-11-11

A patch release in two parts. The onboarding intro, redone after it was seen in production, is drawn with real
content, a camera and ink wipes, ends on a screen of next steps (sample page, New page, Connect an AI agent) instead
of closing, and no longer says "open source". Pictures in a page and on public links open large in a new image
viewer. Web app only: no database migration, no new environment variable, no new dependency, no API change; the
stored image block, its HTML export and the server schema are unchanged.

### Added
- **Image viewer** (docs/adr/2386-*). Pictures in a page open large over a dark backdrop: double-click an image in
  the editor or press the magnifier button in its corner (always shown on touch screens); on a page that is
  read-only for you and on public links one click opens it (on a public link an image inside a link follows the
  link). Zoom with the wheel, a trackpad or a two-finger pinch (about the pointer), `+`/`-`, `0` to fit and a
  double-click for 100% (a small image is never enlarged past 100% to fit); drag to move. ←/→ and the side buttons
  go through the page's images ("2 / 5"); the top bar shows the caption or file name, the zoom and "Open original"
  (new tab). Esc, a click on the backdrop or the close button returns to where you were; the browser's Back leaves
  the page as before and closes the viewer with it, so it never stays over another screen. Keys
  typed while it is open never reach the page (⌘/Ctrl/Alt combinations stay the browser's). A one-click open in the
  editor was left out on purpose: a click still selects the image block for its toolbar, resize handles and drag.
  The shortcut help (`?`) lists the viewer's keys in a new group, Image viewer. There is no keyboard way to open it
  (KNOWN-ISSUES ZOOM-3).

### Changed
- **The intro shows the real thing and moves like it** (docs/adr/2385-*). The four scenes are now drawn with real
  content instead of grey bars: two people writing on a "Weekly sync" page with named cursors, a `[[link]]` to a second
  page with its backlink, and the database view inside the page turning from a table into a board; an AI agent asking
  `find_context` and getting back just the two sections it needs (cited as `Page › Heading`); the agent suggesting a
  section change that a person reviews and accepts (the "Before AI edit" point and Revert), then `update_row` moving a
  board card; your own
  server syncing a laptop and a phone, going offline and back. A camera pushes in on what matters and pulls back out,
  scenes change with an ink wipe from where the drop lands, and the drop has eyes, hops, squashes and leaves a short
  tail. The picture takes about two thirds of the dialog; on a phone the camera shows a close part of each scene so
  the words in it stay readable. Still 26 seconds, still pictures with reduced motion.
- **The intro ends on next steps instead of closing.** After the last scene (or the last still) it stops on the logo
  with "Ready to write?" and buttons: open or make the sample page (new accounts), New page, Connect an AI agent
  (Settings › Connections), Close. Accounts shown the intro with `ONBOARDING_EXISTING_USERS=once` are not offered the
  sample. A button closes the intro (it counts as seen) and then does what it says; → stays, ← goes back to the last
  scene, Esc closes.
- **The intro no longer says "open source"**; scene 4 now reads "It runs on your own server. Turn on offline copies and
  pages keep opening without a connection."

### Performance
- The intro's lazy chunk is 34.94 kB (13.57 kB gzip) instead of 20.63 kB (7.51 kB gzip), still loaded only when it
  plays and not precached. Entry `index-*.js` 447,094 → 447,032 B (122,916 → 122,962 B gzip); entry plus modulepreload
  1,368,719 → 1,371,693 B (403,057 → 403,152 B gzip, the longer intro copy in the i18n chunk); precache 104 entries,
  +2,295 B ([docs/PERFORMANCE.md](docs/PERFORMANCE.md)).
- The image viewer is a separate chunk loaded on its first open, 9,655 B (3,550 B gzip) plus 448 B of CSS; the entry
  script is unchanged in size (447,123 → 447,131 B against 958a9b4), the strings and shortcut rows add about 0.5 kB
  gzip to the preloaded i18n chunk. No new dependency ([docs/PERFORMANCE.md](docs/PERFORMANCE.md)).

## [0.19.0] - 2026-11-11

> **Before you upgrade a server that ran 0.18 or older: add one line to `.env`.**
> 0.19 renames the compose project, volumes, database role and database from the old project name `nodian` to
> `inkling`, and takes the names from a new required setting, `INKLING_DATA_NAME`. Put
> `INKLING_DATA_NAME=nodian` in `.env` **before** `docker compose up` (for example
> `printf '\nINKLING_DATA_NAME=nodian\n' >> .env`) and nothing else changes: the same containers, volumes and
> data. Without the line compose refuses to start (and leaves the running stack alone); do **not** answer that by
> setting `inkling` on an existing server, which starts an empty instance next to your data. Moving to the new
> names is optional and can wait: `./deploy/rename-from-nodian.sh --dry-run`, then without `--dry-run` (copies the
> volumes, keeps the old ones, `--rollback` at any point). Local trials started with `./deploy/local.sh` need
> nothing. Details: [docs/OPERATIONS.md](docs/OPERATIONS.md#upgrading-to-019-the-nodian--inkling-names).

A minor release that moves the data plumbing from the project's old name to `inkling`, gives public links a toolbar
(wide view, Save as PDF and a Markdown download the link's owner can turn on), fixes the app's PDF export and the
sidebar's "More", shows a notice with a Reload button where a screen used to stay white, and greets new accounts
with a short intro, a Getting started card and a sample page. Two database migrations, both additive:
`0059_share_allow_download` (`pages.share_allow_download`) and `0060_onboarding` (`user_onboarding`, one row per
existing account). A 0.18 database goes from 59 to 61 applied migrations. No new dependency. One new setting,
`INKLING_DATA_NAME`, required and without a default (see above); two optional ones, `ONBOARDING` and
`ONBOARDING_EXISTING_USERS`. The MCP tool list is unchanged (48 tools, 32 in core). Upgrade matrix adds v0.18.0,
and a new `rename` job upgrades and renames installs from v0.17.1 and v0.18.0 (`.github/workflows/upgrade.yml`).

Checked in Chrome only (desktop and a 390 px window): the public page toolbar, its PDF, the app's PDF export, the
sidebar, the start-up notices, the intro and the Getting started card were not tried in Safari, Firefox or on a touch device. The `rename` job has not
run on GitHub Actions yet; the same script passed locally from v0.17.1 and from v0.18.0 (docs/KNOWN-ISSUES.md,
"Added in 0.19.0").

### Upgrade notes
- **The order on a server from 0.18 or older**: the upgrade first, on the old names; the rename later, if at all,
  after the upgrade is checked, so a migration and a rename never happen in one go.

  ```bash
  ./deploy/backup.sh
  printf '\nINKLING_DATA_NAME=nodian\n' >> .env     # 1. keep the old names
  git pull && docker compose pull app && docker compose up -d
  ./deploy/rename-from-nodian.sh --dry-run       # 2. optional, later: plan, sizes, free disk, downtime
  ./deploy/rename-from-nodian.sh                 #    the rename (asks once; --rollback at any point)
  ```

  Without the line every compose command stops with "required variable INKLING_DATA_NAME is missing a value";
  nothing was created or stopped. New installs copy `.env.example` (`inkling`). Keeping the old names is supported
  at least until 1.0 (docs/adr/2340-*, 2341-*).
- **Set `inkling` on an old server by mistake**: compose starts an empty `inkling` project next to the untouched old
  volumes. Put `INKLING_DATA_NAME=nodian` back, `docker compose -p inkling down`, `docker compose up -d`, and delete
  the empty `inkling_inkling-*` volumes.
- **Servers that run Docker through sudo**: run the rename script the way you run compose,
  `sudo ./deploy/rename-from-nodian.sh --dry-run`. It writes `.env` in place (owner and mode kept) and its state
  under `./backups/rename-nodian-to-inkling/` (root-owned when run with sudo).
- An override that names old volume keys (`nodian-data:/…`) must use the new keys (`data`, `db`, `backups`,
  `backup-ctl`, `rclone-bin`); compose reports "undefined volume" until then.
- After the rename, containers are `inkling-app-1`, `inkling-db-1`, `inkling-backup-1`: cron lines that name
  `nodian-*` containers need the new names. `POSTGRES_USER`/`POSTGRES_DB` lines in `.env` are not read (they never
  were); delete them.
- **Migration 0059** adds `pages.share_allow_download boolean not null default false` (a constant default:
  metadata-only, no backfill, milliseconds). Existing links keep the download off. Going back to 0.18.0 after the
  upgrade needed no restore in a check before onboarding was merged: the v0.18.0 image started on a database
  migrated to 60 rows (0059 only), served a new share link and logged no error (a near-empty database, not a copy of
  production). With 0060's `user_onboarding` table this was not checked again (KNOWN-ISSUES ONBOARD-5). A link that allowed downloads,
  unpublished and published again while 0.18.0 runs, keeps the setting and offers the download again once 0.19 runs
  (KNOWN-ISSUES SHARE-5).
- **Migration 0060** adds `user_onboarding` and gives every existing account a row `{"legacy": true}` (one
  INSERT…SELECT over `users`): people who already use Inkling are not shown the intro or the checklist after the
  upgrade. They can open both from Settings › About (docs/adr/2380-*).
- **New optional variables** `ONBOARDING` (empty = on, `off` = no intro, card or sample page for anyone) and
  `ONBOARDING_EXISTING_USERS` (`once` = accounts from before the upgrade also see the intro once, on their next app
  load; closing or skipping it is stored per person, so it does not come back after restarts, and unsetting the
  variable later changes nothing for those who saw it; their checklist stays off and no sample page is made for
  them). Accounts first seen while `ONBOARDING=off` count as existing accounts if it is turned on later. Both are
  passed through by `compose.yaml`; recreate the container after changing them (docs/adr/2383-*), then check that
  the value arrived: `docker compose exec app printenv ONBOARDING_EXISTING_USERS` prints `once` (an empty line means
  unset). With `once`, an existing account that closes the tab while the intro is still playing (without Skip, Esc
  or reaching the end) sees it again on its next app load; it counts as seen only once it is closed or finished.
  Guests never get the intro.
- **Templates with a database and an inline view of it**: a custom template that contains a database **and** an
  inline view (page embed) of that database now gives each new copy a view of its own copy; before, the view pointed
  at the original database. This applies to "Start from template" in the app and to `POST /api/pages/from-template`
  (the MCP `create_from_template` tool uses it); embeds of pages outside the template are kept as before
  (docs/adr/2381-*).
- Markdown downloads of public pages link images and files with `PUBLIC_URL` (`APP_URL` as fallback). Set it in
  production; without it the request host is used, as for OAuth metadata.
- `PATCH /api/pages/:id/share` accepts `allowDownload: boolean`; `POST /api/pages/:id/share` does not (strict body:
  400 if sent). New audit action `share.download_changed` (before/after `{ allowDownload }`).
- Developers: the dev database moves to `inkling-db-1` on the same port 55432; stop an old `nodian-db-1` first and
  drop a `nodian` `DATABASE_URL` from your `.env` (CONTRIBUTING.md).

### Added
- **`deploy/rename-from-nodian.sh`** (`--dry-run`, `--yes`, `--rollback`) moves an install to the new names:
  pre-rename backup (sidecar, or `pg_dump` when there is none), row counts, a **copy** of every volume whose name
  changes (the old ones are only read and never deleted), the role and database renamed inside the copy (the
  password set again from `.env`, which covers MD5), `.env` switched, then health, counts, files and a backup
  checked under the new names. It continues where an interrupted run stopped, and `--rollback` starts the old
  names again from any point. Downtime about a minute for a small server; needs free disk for a copy of the
  volumes (docs/adr/2341-*).
- **Rename test**: `scripts/upgrade-test/rename.sh` and a `rename` job in `.github/workflows/upgrade.yml` (from
  v0.17.1 and v0.18.0, by commit): an old release installed like a server, the upgrade refused without the new
  line, the new release on the old names with its migrations (the journal may only grow), the rename (also
  killed after the copy and after the role rename, and rolled back) leaving the journal as it was, and a new
  install with no old name anywhere (docs/adr/2342-*).
- **Public links: Wide view.** Pages follow their own "Full width" setting by default; a visitor's choice is
  remembered in their browser. Tables, code, diagrams and the tables of charts, database views and query results
  use the whole window; running text stops at a readable width (docs/adr/2360-*).
- **Public links: Save as PDF** opens the browser's print dialog with the page title as the file name. The
  printout is the article alone, always in the light palette, with wide tables wrapped to the paper, code wrapped,
  toggles open, diagrams, formulas, images and checkboxes, without buttons or the folder list; the browser's own
  Print command gives the same result (docs/adr/2361-*).
- **Public links: Download Markdown**, per link and off by default. People who manage links turn it on in the
  share dialog ("Let visitors download it as Markdown"); the file holds only what the public page shows
  (docs/adr/2362-*). Changes are in the audit log as "Public link download changed".
- Public page actions fold into one "⋯" menu on narrow screens, with keyboard support (docs/adr/2363-*).
- **Onboarding for new accounts** (docs/adr/2380-* .. 2382-*). A new account sees a 26-second intro once (notes and
  `[[links]]`, databases and views, AI agents over MCP with suggestions and undo, your own server and offline), drawn
  in code, skippable, pausable, keyboard and screen-reader friendly, still pictures with reduced motion. A
  **Getting started** card on the empty workspace screen and, folded, at the bottom of the sidebar lists first steps
  that tick themselves as you do them (first page, `/` menu, `[[` link, database, inviting or sharing, connecting an
  AI agent, installing or offline; invited members get "look around the team workspace" and "leave a comment"
  instead of the database and invite items). Each item takes you where it is done and points at the button. The
  first admin of a new server gets a **sample page** in their private pages, in their language; anyone can make one
  from the card. Settings › About: "Watch the intro again" and a switch for the checklist. `ONBOARDING=off` turns it
  all off; `ONBOARDING_EXISTING_USERS=once` shows the intro once to accounts from before the upgrade
  (docs/adr/2383-*). While a sample page is being made, its own pages do not tick "first page", "database" or
  "link". In the sidebar the card opens only within the sidebar's height and scrolls inside when its list is
  longer, so the menus, the page tree and the footer stay reachable (docs/adr/2384-*). The intro does not open by
  itself over the "could not show this screen" notice; it waits for the next screen.

### Changed
- **The data plumbing is called `inkling`, from one required setting.** Up to 0.18 the compose project, the
  volumes (`nodian-db`, `nodian-data`, `nodian-backups`, `nodian-backup-ctl`, `nodian-rclone-bin`), the database
  role and the database were named `nodian`, the project's old name. They now follow `INKLING_DATA_NAME` in
  `.env`: `inkling` gives project `inkling`, volumes `inkling_inkling-db`, `-data`, `-backups`, `-backup-ctl`,
  `-rclone-bin`, role and database `inkling`; `nodian` gives exactly the 0.18 names. The setting has no default,
  so an install that upgrades without reading this cannot come up on new, empty volumes: compose refuses before it
  creates or stops anything and says which line to add. `.env.example` sets `inkling` (docs/adr/2340-*).
- `deploy/signup-key.sh`, `deploy/reset-password.sh` and `deploy/cli-token.sh` read the role and database from
  the db container instead of assuming `nodian`, so they work on old-name and new-name installs alike. The db
  container now sets `PGUSER`/`PGDATABASE`: `docker compose exec db psql` needs no `-U`/`-d`.
- Development: `pnpm db:up` starts `inkling-db-1` with role, password and database `inkling`; the default
  `DATABASE_URL` (server, drizzle-kit, benches) is `postgres://inkling:inkling@localhost:55432/inkling`.
- `deploy/local.sh` writes `INKLING_DATA_NAME=inkling` for new trials and adds `INKLING_DATA_NAME=nodian` to the
  `.env` of a trial started before 0.19, so it keeps its data.
- `ShareStatusDTO.allowDownload` and `PublicPageDTO.fullWidth` / `.download` are new, additive fields; two new
  public routes, `GET /api/public/:token/export.md` and `GET /api/public/:token/p/:ref/export.md`
  ([docs/API.md](docs/API.md), "v0.19.0 additions").
- Templates: an inline database view (page embed) of a database inside the same template now points at the new copy
  when the template is used (docs/adr/2381-*).
- REST: `GET/PATCH /api/me/onboarding`, `POST /api/me/onboarding/sample`, browser session only
  ([docs/API.md](docs/API.md), "v0.19.0 additions"). Agents never see onboarding.
- Not changed: MCP tool descriptions, the tool list and the server instructions (full 48 tools ~12,777 tokens, core
  32 ~7,533).

### Fixed
- **A screen that cannot be drawn says so instead of going white.** It shows "This screen could not be shown" with
  a Reload button (and the error under Details) instead of a blank white tab. A page that fails keeps the sidebar,
  and moving to another page tries again. A route chunk that still fails after the one automatic reload (server
  restarting, flaky connection) ends there too, and a start whose script never ran shows a reload notice after 12 s
  (docs/adr/2324-*).
- **`deploy/signup-key.sh new` makes a key that works at once.** Since 0.5 the server compares signup keys by their
  SHA-256 (docs/adr/1110-*), but the script still stored the key in plain text, so a key from the script was refused
  ("invalid or expired") until the next app restart hashed it. The script now stores the hash and the last four
  characters like the admin screen does; `list` shows `…ABCD` for such keys, `revoke` takes the full key for both
  kinds. Found by the rename test's new-install step.
- **"More (n)" in the sidebar opens all n menus.** On a window that is not full-screen the sidebar folds the menus
  that do not fit under "More (n)"; opening it showed about one more row, and the rest scrolled inside a small box
  with nothing that said so ("More (3)" opened one). The page tree now gives way while "More" is open (down to
  120 px, with its own scroll), so every folded menu shows. On a very short window where even that is not enough,
  the list scrolls in whole rows above a "k more below" row that scrolls it (docs/adr/1643-*).
- **Export as PDF prints wide tables, closed toggles and the dark theme properly.** In the app's PDF export a
  table with many columns lost its right-hand columns; the columns now share the page width (smaller type from
  7 columns). Closed toggles and toggle headings print their contents. In the dark theme the body text printed
  almost white on the white page; it prints in the light palette now (docs/adr/0308-*).
- PDF export (app and public pages): a heading no longer ends up alone at the bottom of a page.
- Public pages: drawn Mermaid diagrams and formulas no longer turn back into source text when the page re-renders
  (closing a presentation, the new width toggle).
- Public pages: code blocks were white text on a light grey box; they follow the page palette now.
- Public pages: a table wider than the column scrolls inside its own box instead of running past the column (and
  making phones scroll sideways).
- **Offline copies: a page no longer waits on "Connecting…" for a browser storage that never answers.** When
  `indexedDB.open` gave neither success nor error, a page waiting for its device copy stayed on "Connecting…"; after
  5 s the device store now counts as unavailable and the page opens from the server. That tab then works without
  device copies for the rest of its session, and Settings › Offline says the device storage is unavailable;
  reloading the tab tries again. Turning offline copies off waits for `indexedDB.deleteDatabase`, which has no time
  limit and was not tried on a stuck browser (KNOWN-ISSUES OFFLINE-11).

### Performance
- Public page bundle (11d0707 → the share branch, before the other 0.19 changes): +822 B on the entry (i18n strings) and +6,278 B JS, +5,827 B CSS on the public page (≈ +3.4 KB
  gzip in total) for the toolbar, the print styles shared with the app's PDF export and the view CSS
  ([docs/PERFORMANCE.md](docs/PERFORMANCE.md)).
- Screen notices and the IndexedDB open limit (dd933e5 → 5ee9f3a): entry `index-*.js` +1,872 B (+553 B gzip), entry
  plus modulepreload +2,852 B (+914 B gzip), precache +3,729 B (102 entries either way).
- Onboarding (5ee9f3a → c6634d0): entry `index-*.js` +3,223 B (+1,248 B gzip, most of it the en and ko strings),
  entry plus modulepreload 26 → 27 files, +14,107 B (+5,619 B gzip), precache 102 → 104 entries, +25,262 B; the
  intro is a lazy chunk (20.63 kB, 7.60 kB gzip, not precached) loaded only when it plays. Measured on the merged
  tree with gzip -9 ([docs/PERFORMANCE.md](docs/PERFORMANCE.md)).

### Database
- Migration 0059: `pages.share_allow_download boolean not null default false` (docs/adr/2362-*).
- Migration 0060: `user_onboarding` (one row per account, deleted with the account) and a `{"legacy": true}` row for
  every existing account (docs/adr/2380-*).

## [0.18.0] - 2026-11-10

A minor release about writing from anywhere: offline copies of the pages you open, web push notifications to your
devices, a button block and database automations, a web clipper with an Android share target, workspace groups and
an archive of your own, and OAuth Client ID Metadata Documents for MCP clients (off by default, `OAUTH_CIMD=1`). Five
database migrations, all additive: `0054_w18_web_push` (push subscriptions, settings and the VAPID key),
`0055_w18_automations` (rules and their runs), `0056_offline_doc_gen` (`pages.doc_gen`), `0057_workspace_listings`
(each person's workspace groups and archive) and `0058_row_number_tid` (a new body for the row-number trigger
function). A 0.17 database goes from 54 to 59 applied migrations. No new dependency: web push encryption (RFC 8291)
and VAPID (RFC 8292) use `node:crypto`. New optional variables `WEB_PUSH`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`,
`VAPID_SUBJECT`, `WEB_PUSH_ALLOWED_HOSTS`, `OAUTH_CIMD` and `OAUTH_CIMD_ALLOWED_HOSTS`, passed through by
`compose.yaml`. The MCP tool list is unchanged (48 tools, 32 in core). Upgrade matrix adds v0.17.0 and v0.17.1
(`.github/workflows/upgrade.yml`).

### Upgrade notes
- **Reload every tab and installed app before anyone uses a button block.** A 0.17 client (an old tab, or an
  installed app that has not reloaded since the deploy) that edits a page with a button deletes the button: the
  0.17 editor does not know the block (as CHART-2 did for charts in 0.12). KNOWN-ISSUES AUTO-1.
- **Offline copies are on by default in the installed app and off in a browser tab.** The installed app keeps
  every page opened after the update in the browser (IndexedDB `inkling-offline`); a browser tab keeps nothing until
  the person turns on Settings › Offline › "Keep offline copies on this device". Logging out, an expired or revoked
  session (any `401 UNAUTHORIZED`) and another account signing in delete every copy on the device. Copies are not
  encrypted: on a shared computer leave the setting off (docs/adr/2203-*). After restoring the database from a backup
  (`deploy/restore.sh`), devices that hold unsent edits newer than the backup keep them as recovery items
  (Settings › Offline › Recovery) instead of merging them (docs/adr/2201-*).
- **Web push needs HTTPS and outbound HTTPS from the server.** Browsers allow push only on `https://` origins (and
  `http://localhost`). The server sends pushes to the browsers' push services on port 443 (`fcm.googleapis.com`,
  `*.push.services.mozilla.com`, `*.push.apple.com`, `*.notify.windows.com`; docs/OPERATIONS.md section 12); an
  egress firewall must allow them. Nothing to configure otherwise: the server makes its VAPID key on first use and
  keeps it in the database (`push_vapid_keys`) unless `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` are set. Another
  key (a different database, such as another instance's or a fresh one; a deleted row; a changed env pair) voids
  every device's subscription; devices subscribe again when the person next opens the app. Set `APP_SECRET_KEY` so
  subscription endpoints and the generated private key are sealed at rest: a database restored under another
  `APP_SECRET_KEY` cannot read its key, and push stops until the original secret (kept off the server, outside the
  backups) is put back or the row is deleted, which makes a new key. For iPhone and iPad set `VAPID_SUBJECT=mailto:…` or an https
  `PUBLIC_URL`. `WEB_PUSH=off` switches push off server-wide (docs/adr/2220-*).
- **`/push-sw.js` is sent with `Cache-Control: no-cache`** like `/sw.js` (the service worker imports it, and imports
  go through the HTTP cache on worker updates). A proxy or CDN must not override it.
- **Push subscriptions belong to the login session that made them.** Logging out, a password change, an admin's
  revoke of sessions and the 30-day session expiry delete that device's subscription; the device is silent until the
  person opens the app and signs in there again (docs/adr/2221-*).
- **Automations run as the person who last saved (or turned on) the rule**, capped by whoever triggered the run;
  their writes read `<author> via automation: <rule>`. Clients that read `via` as "an agent" meet these values in
  the feed, catch_up, webhooks and `edited_via`; they are not agent writes. `page_props` change-log events now carry
  `keys` (the changed property ids, at most 100); `page_changes` is unchanged. A 15-minute timer per server process
  queues "date reached" rules in the server's time zone (docs/adr/2240-* .. 2243-*).
- **OAuth client names that fold to a word starting with "automation" are refused** at registration, at consent
  and for new agent connection tokens (`CLIENT_NAME_RESERVED`), like "public form", so no app can write as
  `automation: …`. Existing connections are not renamed.
- **The web clipper's "Article text" makes the server fetch the page** (outbound HTTP(S) GET, ports 80/443, public
  addresses only, through the SSRF guard). On a server that blocks outbound traffic every article save becomes a
  link save with `fallback: fetch_failed`; the page is created either way. Bearer tokens may call `POST /api/clip`
  with `mode: 'link'` only (`403 CLIP_ARTICLE_SESSION_ONLY`). Images in a clipped article stay on the original site.
- **Archived workspaces leave agents' default searches.** find_context, search and catch_up without `workspaceId`
  skip the workspaces the person archived and end with one line naming them (`Not searched: …` / `Not included: …`);
  `workspaceId` (an id or the name) reaches one. Nobody has archived anything right after the upgrade, so every
  answer is the same until someone does (docs/adr/2303-*, 2304-*).
- **Presentation mode splits slides differently.** Slides now start at the shallowest heading level used two or more
  times, and at every heading above it. A page with one H1 at the top and H2 sections gets a slide per section
  instead of two slides in all; a page with several H1s splits as before (docs/adr/2323-*).
- **Menus at the caret open upwards** (`/`, `[[`, `![[`, `@`) when there are less than 300 px below the line and more
  room above, even for a short menu, and fit the visible part of the window (docs/adr/2322-*).
- **OAuth Client ID Metadata Documents are off.** Nothing changes unless `OAUTH_CIMD=1` is set; the authorization
  server metadata is identical while it is off. Turned on, Claude clients prefer it over dynamic registration for
  new connections; existing connections keep working. Turned off again, connections made through it stop at their
  next token refresh (within an hour) (docs/adr/2280-*).
- **Migration 0058 replaces the body of `inkling_row_number()`** (the trigger function of 0051); no table, index or
  trigger definition changes. A row inserted while another transaction adds an ID property to its database may
  still stay without a number, as in 0.17 (KNOWN-ISSUES ROWNUM-1, not fixed in 0.18; docs/adr/2320-*).

### Added
- **Offline copies on this device** (docs/adr/2200-* .. 2204-*). Pages you open are kept in the browser (IndexedDB)
  so they open and can be edited without a connection; the edits are uploaded through the normal live sync when the
  connection is back. The app also starts offline from the last user, workspace list, workspace groups and page tree
  the server sent, with a banner saying so; the page list is read-only offline, and a page never opened on the
  device says so instead of showing an empty editor. Settings › Offline: "Keep offline copies on this device" (on by
  default in the installed app, off in a browser tab), how much is stored, "Delete now", and recovery items.
- **Document generation** (`pages.doc_gen`, migration 0056): bumped after a version restore, an AI-edit revert, a
  split and a full-body rewrite. A device copy whose unsent edits are based on an older generation is not merged:
  the edits are kept as a recovery item (Settings › Offline › Recovery) and the page reopens from the server with a
  notice. The same happens when the page went to the trash or the edit right was lost while offline; with no access
  at all (member removed, page made private) the copy is deleted (docs/adr/2201-*).
- **Push notifications (web push)** (docs/adr/2220-* .. 2223-*). Turn them on per device in Settings › Notifications
  › Push notifications; mentions, assignments, replies, comments, approvals and reminders then arrive with the app
  closed (installed app or a browser tab; iPhone and iPad from the Home Screen app, iOS 16.4+). Choose which kinds
  push, pause push on all devices, hide the content on the lock screen, see and remove your devices, send a test.
  Pushes follow your notifications (same recipients, levels and page visibility, checked again when sent), one per
  page at a time; the page you are looking at is not pinged twice. Automation notices push as mentions.
- **Button block** (`/button`, docs/adr/2244-*): a label, a color and up to five actions run in order by whoever
  presses it: add a row to a database (template, values with `today`, `today+N`, `me`, `this` page, `{{today}}` /
  `{{me}}` / `{{page}}` in text), set values of the row the page is, open a page or an http(s) URL, send to a webhook
  a workspace owner registered. It shows progress, ignores a second press while running and says which action
  stopped and why. It runs through the REST routes the person may use anyway: a button adds no right. Public links
  and presentation mode show it disabled; print hides it; agents and downloads see `<!-- inkling:button {…} -->`;
  plain Markdown shows `**[label]**`; vault sync keeps the token.
- **Database automations** (database menu › Automations, docs/adr/2240-* .. 2243-*): rules with a trigger (row
  added; a property changed, optionally "to a value"; a date property N days ahead), an optional condition (the view
  filter with any / all groups and NOT) and up to five actions (set values, assign a person, notify people, send to a
  registered webhook — Slack, Discord or generic —, add a row to another database, hand the row to a person's AI
  connection). A rule runs after the write commits, as its author, capped by who triggered it; its writes read
  `<author> via automation: <rule>`. Recent runs (50 per rule) with the failed action and reason; five failures in a
  row turn a rule off and tell its author; runs refused by the trigger cap and rows with nothing to do are recorded as
  skipped and never count. At most 20 rules per database.
- MCP `query_rows describe=true` lists a database's enabled automations, one line each (docs/adr/2245-*).
- **Web clipper** (docs/adr/2260-* .. 2263-*): save what you see on the web as a page, nothing to install. The `/clip`
  screen ("Save to Inkling") is filled from `?title&text&url`; a bookmarklet in Settings › Connections › Web clipper;
  the installed app's share target on Android opens the same screen. Choose workspace and location (the last one is
  remembered, a default can be set), edit the title, add tags, save as "Link and note" or "Article text" (the server
  fetches the page and keeps its main text). An earlier clip of the same address is pointed out. Opening `/clip`
  never saves anything by itself. Not an MCP tool.
- `examples/web-clipper-extension/`: a minimal MV3 extension (load unpacked; not in any store) for sites whose
  security policy blocks the bookmarklet.
- **Workspace groups and archive, per person** (docs/adr/2300-* .. 2302-*, 2305-*). The workspace switcher can sort
  workspaces into named groups ("Contests", "Classes") that fold, and put finished ones under "Archived". Only for
  you: other members see nothing change, and archived workspaces stay open and editable. "Organize workspaces…" in
  the switcher, or Settings › Sidebar. Works for guests' shared workspaces too.
- **Agents stop searching archived workspaces by default** (docs/adr/2303-*, 2304-*): find_context, search and
  catch_up without `workspaceId` leave your archived workspaces out and end with one line naming them. Mentions,
  replies and assignments from them still arrive (inbox, catch_up "For you"); changes_since is not narrowed.
  Connections limited to some workspaces follow their range, not the archive. `list_workspaces` shows `group` and
  `archived` where set.
- **OAuth Client ID Metadata Documents** (CIMD; MCP authorization 2025-11-25, draft-ietf-oauth-client-id-metadata-document-03;
  docs/adr/2280-* .. 2282-*): an MCP client's `client_id` may be an https URL, and Inkling reads the app's name and
  redirect URIs from the JSON document there. This is claude.ai's "use Claude's published ID" and what Claude Code
  uses when a server offers it. **Off by default**: set `OAUTH_CIMD=1`; `OAUTH_CIMD_ALLOWED_HOSTS` limits the
  client_id hosts (e.g. `claude.ai`). Dynamic client registration is unchanged and stays on. The consent screen shows
  "Identified by <host>" under such an app's name (the name is the app's own claim) and warns when the sign-in
  returns to a program on this computer (localhost); the Connections list shows the host after the name.
- Admin › Server status: "Web push" (devices, failing devices, deliveries given up in 24 h) and "Database
  automations" (rules on, runs queued, failed in 24 h; a warning when due runs wait 15 minutes or more).
- REST: `GET /api/pages/:id/sync-check`; `/api/push/*`; `GET/POST /api/collections/:id/automations`,
  `PATCH/DELETE /api/collections/:id/automations/:ruleId`, `GET /api/collections/:id/automations/runs`,
  `GET /api/workspaces/:id/webhook-targets`, `POST /api/pages/:id/button-webhook`; `POST /api/clip`,
  `GET /api/clip/lookup`; `/api/me/workspace-groups…`, `PATCH /api/me/workspaces/:id/listing`,
  `PUT /api/me/workspace-order` ([docs/API.md](docs/API.md), "v0.18.0 additions").

### Changed
- Presentation mode splits slides at the shallowest heading level used two or more times (and at every heading
  above it); a slide longer than the screen scrolls with the wheel, touch and ↑ ↓ (←, →, Space, PageUp and PageDown
  still change slides). Buttons, selects and text areas in the slides are shown disabled, and a button block has no
  settings control there (docs/adr/2323-*).
- A request that gets no answer (offline, server unreachable) shows "No connection. Try again when you are back
  online." on button presses, clip saves, the automations screen and push settings, at once, instead of a browser
  error text or a spinner that never ends (a clip save used to wait as "Saving…" until the connection came back).
  Other screens keep the old behaviour: their changes wait while the browser reports offline and are sent when it is
  back (docs/adr/2321-*).
- "Not saved yet" is "Not uploaded yet" when the edits are stored on this device; the leave prompt asks only for
  edits that exist only in the tab (docs/adr/2204-*).
- Logging out asks first when pages have edits that are not uploaded yet, and deletes the device's offline copies
  (docs/adr/2203-*).
- `/clip` lists workspaces in your switcher order (groups, archived last) and does not pick an archived one by
  default; offline, the switcher keeps its groups.
- `GET /api/workspaces` adds an optional `listing` object per workspace for workspaces the caller arranged;
  `GET /api/search` and `GET /api/context` add `archived` when a default search left archived workspaces out.
- Webhook deliveries can have the event type `automation` (not subscribable; sent only to the hook a button or rule
  names; generic payload `type: "automation"`, `field` = the rule name or button label, `message`).
- `via` values starting with `automation: ` are not agent writes.
- Every authorization response to a metadata-document client (code or error) carries `iss` (RFC 9207); answers to
  registered clients are unchanged (docs/adr/2282-*).
- Link previews decode pages labelled `cp949`, `ms949`, `x-windows-949`, `uhc` or `x-euc-kr` as EUC-KR.
- Settings › Offline has its own icon; the installed app's share target declares its encoding (no Chrome manifest
  warning).
- Not changed: MCP tool descriptions, the tool list and the server instructions (full 48 tools ~12,777 tokens, core
  32 ~7,533, instructions ~492). No new MCP tool: agents cannot make automation rules, archive workspaces, register
  push endpoints or clip URLs.
- Routes and fields: [docs/API.md](docs/API.md), "v0.18.0 additions".

### Fixed
- The slash menu (and the `[[` / `![[` link and `@` mention menus) opened below a line near the bottom of the window
  and was cut off; it now opens above the caret when there is not enough room below, fits the visible part of the
  window (also with a phone keyboard up) and scrolls inside, with the chosen item kept in view (docs/adr/2322-*).
- Logging out after the connection dropped did nothing until the connection came back (the device's offline copies
  stayed); it now logs out at once, deletes the copies and also removes this browser's push subscription (the
  server could not be told; the session stays valid there until it expires or is revoked, KNOWN-ISSUES
  OFFLINE-LOGOUT) (docs/adr/2321-*).
- Inserting many rows into a database with an ID property in one go (sheet sync, large CSV or Notion imports,
  templates) no longer slows down with every row: each row's number bump walked every row version the transaction
  had left behind (docs/adr/2320-*).

### Security
- Push endpoints must be on an allowed push service (`WEB_PUSH_ALLOWED_HOSTS` adds more), resolve to public
  addresses and are called without redirects; endpoints, their keys and the generated VAPID private key are sealed
  with `APP_SECRET_KEY`. Subscriptions are browser-session only and belong to one session (docs/adr/2221-*).
- Clip article fetches are for browser sessions only and go through the SSRF guard (public addresses, every redirect
  checked again, at most 3 redirects, 10 s, 2 MiB), limited per person and per server (docs/adr/2262-*). The clipper
  is not an MCP tool, so an agent steered by injected text cannot make the server fetch a URL (docs/adr/2260-*).
- Automations act as their author through the REST routes, capped by whoever triggered them: a rule started by a
  guest, a public form answer or an agent connection cannot add rows to another database. A button adds no right
  (docs/adr/2241-*, 2244-*).
- CIMD documents are fetched only for a signed-in person's consent screen or a refresh token the server already
  knows: public addresses, no redirects, 5 KB, 5 s, cached, at most 60 fetches a minute. Only public clients
  (`none` + PKCE) are accepted; reserved names ("automation…", "public form") are refused in documents too
  (docs/adr/2281-*).
- Workspace groups and archive are a person's own list, written by the browser session only; they change no
  permission and no workspace for anyone else (docs/adr/2302-*).

### Performance
- Row numbers in bulk inserts (migration 0058): 50,000 rows into an ID database in one transaction (sheet sync's
  shape) 41.1 s → 3.7 s; statement 50 of 50: 1,460 → 92 ms. Single-row creates unchanged (insert p50 5–6 ms either
  way; the trigger's own time under an ID database ~10 µs higher).
- Archived workspaces out of the default scope: with 40 of 50 workspaces archived, find_context uncached 55.5 →
  32.7 ms p50 and search 59.4 → 43.1 ms p50; the scope statement costs ~0.3 ms more per default call.
- Database automations add no statement to writers; the change-log consumer pays one indexed rules lookup per batch
  with row events (+~5–6 ms per pass, off the request path).
- Web push adds one cached EXISTS and one INSERT…SELECT per notify pass when any subscription exists (within noise).
- Clip article extraction: a 1.6 MB page ~0.35 s instead of ~4.4 s; a 3,000-deep `<div>` nest is refused in 5 ms
  instead of a 53 s extraction.
- Opening a 1.8 MB page from its device copy: within the spread of opening it with the setting off.
- MCP fixed cost per session unchanged (tool list and server instructions).
- Several of these were measured on a shared, loaded machine; numbers, methods and load:
  [docs/PERFORMANCE.md](docs/PERFORMANCE.md).

### Database
- Migration 0054: `push_subscriptions`, `push_vapid_keys`, `push_settings` (docs/adr/2220-* .. 2222-*).
- Migration 0055: `collection_automations`, `automation_runs` (docs/adr/2240-*, 2243-*).
- Migration 0056: `pages.doc_gen integer not null default 0` (docs/adr/2201-*).
- Migration 0057: `workspace_list_groups`, `workspace_listings` (docs/adr/2301-*).
- Migration 0058: a new body for `inkling_row_number()` (hand-written, `drizzle-kit generate --custom`); no table,
  index or trigger definition changes (docs/adr/2320-*).

## [0.17.1] - 2026-11-10

A patch release with three fixes found by clicking through 0.17.0 in Chrome. Web app only: no database migration,
no new dependency, no configuration change.

### Fixed
- **A click on a page link in the editor no longer opens a second tab.** `[[Page]]` and `[[Page#Heading]]` links moved
  the current tab and also opened the same page in a new tab, because BlockNote's link handler opened every link
  with `window.open`; ⌘-click moved the current tab as well. A plain click now moves in the app only, ⌘/Ctrl-click and
  the middle button open one new tab and leave the current one where it is, and external links open one new tab as
  before. The same holds in the row-template editor, in a page embed's body and in a page that is read-only for you
  (docs/adr/2107-*).
- **Presentation mode draws Mermaid diagrams.** On a public link the slides showed the ```mermaid code; each slide now
  draws its diagrams with the public page's renderer (strict settings, an image), and in the app a diagram the
  editor had not drawn yet when the presentation opened is drawn on its slide too (docs/adr/2191-*). Code blocks on
  slides were white text on a light background and keep the editor's dark box now.
- **The view picker of a database view block works on the first click.** Picking a view with the mouse (or, in an
  empty block, a database and a view) node-selected the block and kept the old value until a second pick. The editor
  no longer takes a mouse press inside a select as a click on its block (docs/adr/2108-*).

## [0.17.0] - 2026-11-10

A minor release about Notion- and Obsidian-style use and feedback from people running Inkling every day: Mermaid
diagrams, `[[Page#Heading]]` links to a section, database views inside pages, new database properties (email,
phone, created and edited time and by, IDs like `TASK-12`), filters with OR and NOT, sub-items and a list view,
an agent task board template, guests who can open the databases shared with them, a one-command local trial, MCP
`import_zip`, a version per agent write, and a ranked `search`. Three database migrations, all additive:
`0051_v017_collection_rows` (row numbers and the last editor of a collection row), `0052_page_link_sections` (the
heading a page link points to) and `0053_v017_snapshot_steps` (AI steps in the version history). A 0.16.0 database
goes from 51 to 54 applied migrations. New dependency `mermaid` 12.3.0 (web only, loaded on the first diagram, not
precached). Two new optional compose variables, `INKLING_PORT` and `INKLING_DB_PORT`. Upgrade matrix adds v0.16.0
(`.github/workflows/upgrade.yml`).

### Upgrade notes
- **MCP `search` output and default count changed.** One call now ranks every workspace together (title, then
  heading, then body; whole words before parts of words), groups answers from several workspaces under
  `## <name> (<id>)`, prints `§anchor` for heading and body matches and returns **10 results by default** (before:
  20 per workspace, every workspace) with a closing line saying how many more matched and where. Pass `limit`
  (at most 50) or `workspaceId` for more. `format: "json"` keeps `results[].id`, `workspaceId`, `title`, `kind`,
  `section` and `snippet` and adds keys (docs/adr/2183-*, 2184-*).
- **Every agent write leaves a version ("AI step").** patch_section, patch_sections, update_page, restore_version
  and upload_file each store the page right after the write, labelled with the client, the sections and the lines
  changed; "Before AI edit" is stored only when the page changed since the newest version. Each client keeps its
  newest 20 steps per page and a page keeps at most 30 steps; the 50-version cap per page is unchanged and step rows
  are pruned first. A page an agent writes often keeps more rows than in 0.16 (docs/PERFORMANCE.md;
  docs/adr/2180-* .. 2182-*).
- **The Markdown download has snapshot markers.** "Export as Markdown" in the web app and every zip export
  (`format=zip`, `GET /api/workspaces/:id/export`) now use `notation=file`: a chart or database view is its
  `<!-- inkling:… -->` line followed by `<!-- inkling:snapshot -->`, a table of its numbers and
  `<!-- /inkling:snapshot -->`, and a query block is followed by its results. Importing the file restores the
  blocks and drops the tables. `notation=plain` gives the 0.16 output; `GET /api/pages/:id/export?format=md`
  without `notation` is still `plain` (docs/adr/2122-*).
- **Zip imports and bearer folder imports by a connection follow the upload rules.** A zip posted with a
  connection's token to `POST /api/workspaces/:id/import` is at most `AGENT_UPLOAD_MAX_MB` (default 5 MB), and its
  `assets/` attachments, like the attachments of a bearer `import-folder`, are checked as `upload_file` checks them
  (the upload switch, the daily budget, the per-file cap, the type by bytes) and counted as the connection's uploads;
  refused ones are skipped and listed in `skippedAttachments`. Before, a bearer zip import stored any attachment
  unchecked. Imports from the browser are unchanged (docs/adr/2162-*).
- **Zip imports refuse unsafe archives** (web and MCP): an entry with `..` (JSZip used to collapse it silently), a
  symbolic link, or an entry that inflates more than 200 times its packed size past 1 MB is answered with 400.
  Names are normalized (NFC, `\`, leading `/`, drive letters), and names that are not UTF-8 are read as CP949
  (zips made by Windows Explorer on Korean systems) (docs/adr/2163-*).
- **A new server with no account prints a setup link.** At boot, a server with no account writes a one-time
  `<PUBLIC_URL>/setup?code=…` link to its log; the account made with it is the administrator. The code is kept in
  memory only, works once and closes as soon as any account exists. Servers that already have accounts print
  nothing and behave as before; `deploy/signup-key.sh` keeps working. If container logs go to a service other
  people can read, create the first account right after the first start or use a signup key (docs/adr/2160-*).
- **`[[Page#Heading]]` now links to the heading.** Markdown import, MCP writes and vault sync turn
  `[[Page#Heading]]` and `[[Page#Heading|shown]]` into a section link when `Page` is a page you can see and no page
  or split subpage is titled `Page#Heading` (those stay page links). A link written before 0.17 stays a page link
  until its line is written again. `[[…]]` inside a fenced code block is now left as code on import
  (docs/adr/2100-*, 2104-*).
- **Vault sync (still experimental, `EXPERIMENTAL_FEATURES=vault-sync`) behaves differently in six ways**
  (docs/VAULT-SYNC.md):
  1. Page embeds, database views, link embeds, plugin blocks and charts are written to the note as one-line
     `<!-- inkling:… -->` block tokens, and the revision carries a format marker (`md2`). A note last synced by 0.16
     gets one 412 and a merge on its first upload; an edit on the line next to an embed then gives one conflict
     copy, and nothing is lost (docs/adr/2169-*).
  2. Deleting a folder in the vault trashes its folder page. This reverses ADR 0202's "folders are not deleted by
     sync" for folders that held notes at the last completed run; empty folders and the first run from a pre-0.17
     state file are exempt, so a git clone that drops empty folders deletes nothing (docs/adr/2167-*).
  3. A `PUT` with a stale revision answers 200 and writes nothing when the page already equals the note
     (docs/adr/2166-*).
  4. Creating a page takes a `clientKey`; a retry with the same key returns the same page with `replayed: true`
     (docs/adr/2166-*).
  5. A 403 on one note skips that note and lists it, and the run exits 0; a read-only token's run "succeeds" while
     writing nothing (docs/adr/2168-*).
  6. A folder `X/` next to `X.md` is X's sub-page folder (before: a separate folder page with the same name).
- **A database view is a page embed with a `viewId`.** A tab still running 0.16 keeps the block and shows a page
  card for the database; only if that tab moves or rewrites the block does it lose the view choice (docs/adr/2120-*).
  A view whose filter uses OR, NOT or groups shows unfiltered in a 0.16 tab; a plain AND filter is still saved in
  the 0.16 format (docs/adr/2142-*).
- `GET /api/pages/:id/backlinks` may carry a new `sections` field; clients that read only `pages` are unaffected
  (docs/adr/2101-*).

### Added
- **Mermaid diagrams** (docs/adr/2104-* .. 2106-*, 2191-*). A code block in language `mermaid` (or `mmd`) draws its
  diagram under the code: the code shows while you edit it (or always, with "Show code"), and a syntax error is one
  line in the block. Light and dark themes, narrow screens, presentation mode (diagram only), PDF export (waits for
  diagrams, prints them in the light palette) and public pages (`/s/…`, drawn in the reader's browser; if a diagram
  cannot be drawn its code stays). Mermaid runs with a strict configuration and is shown as an image. It is loaded
  only when a page has a diagram, and its source stays a ```mermaid fence for agents, vault sync and exports.
- **Section links `[[Page#Heading]]`** (docs/adr/2100-* .. 2102-*). Type `[[Page#` to pick one of the page's
  headings; the link opens the page at that heading (folded sections open). The link follows the heading when it is
  renamed or moved; when the heading is gone the page opens and says so. The backlinks panel shows which heading
  each linking page points to; the graph counts section links as page links. Markdown export, MCP reads, vault sync
  and Notion publishing write them as `[[Page#Heading]]` (`|shown` when the text differs).
- **check_notes** reports section links whose heading no longer exists: `[[Page#Heading]] heading not found in page
  <id>` (docs/adr/2103-*).
- **Database views in pages** (docs/adr/2120-*). Type `/database view` (`/데이터베이스 보기`) to show one view of a
  database (table, board, gallery, calendar, timeline, chart or list) inside a page. The block stores only which
  database and which view: everyone sees the rows they can see, and a database you cannot see shows "Database not
  available" without its name. Rows open their page and "Open database" goes to the full view; the block is
  read-only in this release. `![[Database]]` shows the database's first view.
- **Public pages show embeds, database views and query results** (docs/adr/2121-*, 2190-*): an embedded page that is
  part of the link shows its title and text, a database view a table of its view, a query block its results, a link
  embed a card. Only data from pages inside the link is shown; anything else is one line, "Embedded content that is
  not part of this link."
- **Markdown download keeps charts, database views and queries** with a snapshot of their numbers, and importing
  the file brings the blocks back (see Upgrade notes, docs/adr/2122-*). Database tables on public pages and in the
  download show 0.17's automatic properties (IDs as `TASK-12`, ISO times, people's names) and table and list views
  show sub-items under their parent (`↳`); public pages never show the connection an agent used (docs/adr/2190-*).
- Agents: `read_page` writes a database view as its page-embed line followed by `<!-- inkling:view-info database
  "…", view "…" (board); its rows: query_rows -->`; agents add a database view by writing the line
  (docs/adr/2123-*).
- **Database properties** (docs/adr/2140-*): email and phone (`mailto:` / `tel:` links), and automatic, read-only
  created time, last edited time, created by, last edited by and **ID** (`TASK-12`: a prefix per property and a
  number per database, handed out once by a database trigger, never reused, no duplicates under parallel creates;
  existing rows are numbered when the property is added). Automatic values work in sort, filter, group, charts,
  formulas (`prop("ID")` is the number) and CSV/XLSX export; forms never ask for them; writing them is ignored in
  the web app and refused with a clear error through MCP.
- **Last edited by** follows the change log: the person behind the newest property, title or body change, with
  "(via Client)" when an agent made it (docs/adr/2141-*).
- **Filters with OR groups and NOT** (docs/adr/2142-*): "Match all / any", a Not toggle per condition, and one
  level of groups with their own all/any and Not, in every view type, in charts and inline views — the same
  evaluator query_rows and the server's chart aggregate use.
- **Sub-items** (docs/adr/2144-*): turn them on from the database menu; each row gets one Parent item (a loop is
  refused with 400 `SUBITEM_CYCLE`). Table and list views show the tree with indentation and collapse ("Nested /
  Flat" in view settings); board, calendar, gallery and timeline stay flat. A trashed parent leaves its sub-items
  at the top level until it is restored.
- **List view** (docs/adr/2145-*).
- **Guests can open databases shared with them** (docs/adr/2146-*): read at view level, add rows and edit cells at
  edit level; links, rollups and people outside their shared pages stay hidden. Properties, views, bulk paste and
  import, charts and assigning people stay member-only. Database views in pages show guests the rows and people's
  names of a database shared with them.
- **Agent task board template** (Templates › Agent task board, `create_from_template template="agentBoard"`):
  tasks with sub-tasks, an assignee (a person or their agent connection), evidence and `TASK-n` IDs
  (docs/adr/2147-*, docs/RECIPES.md).
- MCP for databases: `query_rows` `under` and `depth` (the sub-items of a row), `create_row` `parent`, IDs (`TASK-3`)
  accepted wherever a parent row is named; `create_collection` and `update_fields` take the new types, `prefix` and
  `subItems` (docs/adr/2147-*).
- **One-command local trial** (docs/adr/2161-*): `./deploy/local.sh` writes a `.env` with generated secrets, picks a
  free port bound to 127.0.0.1, starts the stack under its own compose project (`compose.local.yaml`: no database
  host port, no backup sidecar) and prints the first-admin link and the MCP address. `--build` builds the checkout;
  `stop` and `destroy`. It never changes a `.env` it did not write (deploy/DEPLOY.md, "Local trial").
- **First-admin setup link** on a server with no account (see Upgrade notes, docs/adr/2160-*); the sign-up screen at
  `/setup?code=…`.
- **MCP `import_zip`** (hidden group `files`, docs/adr/2162-*): a zip of a folder becomes a page tree (folders,
  `.md`, `.canvas`, `assets/` attachments) through the web app's zip import, under the upload rules. Notion exports
  are left to the web app (or `source="markdown"`).
- **AI steps in the version history** (docs/adr/2180-* .. 2182-*): `list_versions` shows them as
  `AI step n | by <person> via <client> | patch_section replace §goals +1 −1 lines`, lists the newest 20 versions
  and folds runs of more than 4 steps; `all=true` lists every version (up to 50). The web history shows "AI edit ·
  step n" and what the step changed. `restore_version` by an agent is itself a step; when the page is still its
  previous step it stores no "Before restore" copy and names that step as the undo point.
- **Workspace arguments take a name** (docs/adr/2186-*): `workspaceId` in find_context, search, list_pages,
  create_page, import_folder, import_zip, get_instructions, catch_up, changes_since, later, list_templates,
  create_from_template, create_collection, list_trash and check_notes accepts the workspace's name
  (case-insensitive, or a unique start of 2+ characters) as well as an id or 8-character prefix. `inbox` still takes
  ids only.
- **find_context names the workspaces** when an answer has results from two or more (only without `workspaceId`):
  `{Workspace name}` before each title and one closing line with the ids and how to narrow. An answer from one
  workspace is unchanged, byte for byte (docs/adr/2185-*).
- `GET /api/search?q&workspaceId?&limit?`, the agent search route (the web app's workspace search is unchanged).
- `compose.yaml`: `INKLING_PORT` (the app's host port or ip:port, default 3000) and `INKLING_DB_PORT` (default
  55432).

### Changed
- The `search` tool description says when to use it: names and exact words; questions go to find_context
  (docs/adr/2184-*).
- The server instructions add one sentence: with several workspaces, pass workspaceId (an id or the name) to search
  one.
- Autosaves (every 10 minutes) ignore AI step rows when deciding whether one is due, and skip a state equal to the
  newest version.
- Printing and PDF export print database views and embedded pages whole instead of their scroll box.
- The boot warning "no accounts yet and signups need a key" is replaced by the setup link.
- Not changed: find_context still ranks across workspaces together. "Best workspace first" was measured on new
  several-workspace evaluation cases and not adopted (MRR and recall@5 lower, docs/adr/2188-*); a per-connection
  default search workspace was not built (docs/adr/2187-*).
- Routes and fields: [docs/API.md](docs/API.md), "v0.17.0 additions".

### Fixed
- Vault sync (experimental): editing a note in the vault no longer deletes page embeds, database views, link
  embeds, plugin blocks and charts; frontmatter Inkling cannot store stays in the note and is listed; inline images
  are kept, and two notes with the same picture no longer share one file (docs/adr/2168-*, 2169-*).
- Vault sync (experimental): a sync cut off part-way no longer duplicates pages or makes false conflict copies;
  deleting a page with its sub-pages folder, or a folder, in the vault no longer comes back; renaming a folder keeps
  its folder page; one refused attachment or locked page no longer stops the run; canvases are listed as not synced
  (docs/adr/2166-* .. 2168-*). Vault deletes are in the change feed.
- Vault sync wrote a `[[Page#Heading]]` link back as `[[Page|Page#Heading]]`.
- Vault sync: a link to a page whose title contains `#` ("C# notes", also `[[C# notes#Setup]]`) keeps its target
  when the note is edited in the vault; it used to move to a page "C" or become text.
- `[[Title]]` inside a fenced code block became a link on Markdown import.
- An agent's `update_page` replace right after its own `create_page` with Markdown could be refused as if a person
  had edited the page last (the change log had not labelled the new page with the client yet).
- `linkPreview.test.ts`'s ReDoS timing check measures the process's CPU time (best of three) instead of wall time,
  so a loaded machine no longer fails it. No product change.

### Security
- Zip imports refuse `..` entries, symbolic links and entries that inflate more than 200 times past 1 MB, and
  normalize entry names (see Upgrade notes, docs/adr/2163-*).
- Attachments in zip and folder imports by a connection are typed and counted like `upload_file` (docs/adr/2162-*).
- The first-admin setup code is in memory only, works once, counts wrong codes towards the IP ban and closes when
  any account exists; concurrent setups commit at most one account. "Requests from localhost need no key" was
  rejected as unsafe behind a proxy (docs/adr/2160-*).
- Mermaid diagrams render with `securityLevel: 'strict'`, locked directive keys and a cleaning pass, and are shown
  as an `<img>` with external references removed (docs/adr/2105-*). On public pages they are drawn the same way in
  the reader's browser (docs/adr/2191-*).
- Public pages show embedded data only from pages inside the link, never what the person who shared it can see
  (docs/adr/2121-*). Guests opening a shared database get no titles, rows or people from outside their shared
  pages (docs/adr/2146-*).

### Performance
- MCP fixed cost per session (tools/list + server instructions): full ~13,269 tokens (0.16: ~12,837, +3.4%; tools/list
  48 tools ~12,777, instructions ~492), core ~8,025 (0.16: ~7,904, +1.5%; 32 tools ~7,533). The growth is
  import_zip (181, hidden from core), the database parameters of create_collection, query_rows, create_row and
  update_fields, and list_versions' `all`.
- MCP search over several workspaces is one statement instead of 1 + W requests: p50 at 10 workspaces / 5,000 pages
  182.7 → 22.5 ms (common word), 29.8 → 3.1 ms (rare word). In one workspace a two-character term that matches every
  page is slower (50.6 → 72.2 ms; every match is graded).
- AI steps: +6–9 ms per agent write on a 12 KB page; 30 agent writes to that page keep 21 rows, 34.3 KB on disk.
- Mermaid adds nothing to the entry chunk; the library (about 246 kB gzip for the first flowchart) is fetched on the
  first diagram and not precached.
- query_rows on a database with automatic properties costs about the same as without them unless the filter or sort
  uses them (docs/adr/2192-*). Single page and row writes with the 0.17 ID trigger and last-editor update are within
  noise; a bulk insert of 20,000 rows under a parent is about 30% (≈ 20 µs a row) slower.
- Vault sync (experimental) of a 1,000-file vault: first upload 23.5 s (rate limiter off) / 120.1 s (on), a run with
  no changes 0.4 s.
- Numbers and methods: [docs/PERFORMANCE.md](docs/PERFORMANCE.md).

### Database
- Migration 0051: `pages.row_number`, `pages.edited_by`, `pages.edited_via`, `collections.row_seq`, a partial unique
  index on `(parent_id, row_number)`, and the triggers `pages_row_number_ins`, `pages_row_number_move` and
  `collections_row_number_backfill` that hand out ID numbers (docs/adr/2140-*, 2141-*).
- Migration 0052: `page_links.sections jsonb` (nullable; no section links existed before 0.17, so nothing is
  backfilled) (docs/adr/2101-*).
- Migration 0053: `page_snapshots.digest text` and `page_snapshots.step jsonb` (nullable, no data migration)
  (docs/adr/2180-*).

## [0.16.0] - 2026-11-10

A minor release about MCP and working with AI agents: a smaller tool list on request, pages as MCP resources and
three prompts, a memory check, agents that only suggest after reading suspicious text, file uploads and PDF text for
agents, agent connection tokens for apps that cannot sign in, and a connection settings generator. Three database
migrations, all additive: `0048_wave16_taint` (table `connection_taints` and the workspace setting
`agent_taint_demote`), `0049_wave16_agent_tokens` (columns `oauth_grants.kind` and `token_prefix` for agent
connection tokens) and `0050_wave16_agent_uploads` (`workspaces.agent_uploads`, `files.uploaded_via` and a partial
index on `files`). A 0.15.1 database goes from 48 to 51 applied migrations. New dependency `unpdf` 1.9.1 (pure
JavaScript, no native build; about 2.5 MB in the image). Three new environment variables, all optional:
`AGENT_UPLOADS`, `AGENT_UPLOAD_MAX_MB`, `AGENT_UPLOAD_DAILY_MB`. Upgrade matrix adds v0.15.1
(`.github/workflows/upgrade.yml`).

### Upgrade notes
- **Agents that read suspicious text only suggest for an hour, on by default.** When an MCP connection, an agent
  connection token or a personal API token is handed content the injection heuristics flag, its section and body
  edits become suggestions for a person and its other writes (new pages, renames, moves, trash, rows, uploads) are
  refused with `403 CONNECTION_SUGGEST_ONLY` for 60 minutes after the last such read. Comments, claims and withdrawing
  its own suggestions still work. Owners and admins can switch it off per workspace in Workspace settings › Connected
  agents › Suspicious content; the connection's owner (Settings › Connections) or a workspace admin (for that
  workspace's pages) can lift it early (docs/adr/2040-* .. 2043-*).
- **`GET /api/oauth/grants` returns OAuth connections only** (`kind = 'oauth'`). Agent connection tokens are stored
  as grants too and have their own list, `GET /api/agent-tokens`. `DELETE` and `PATCH /api/oauth/grants/:id` work for
  both (docs/adr/2060-*).
- **read_file scans the text it returns.** Attachment text and PDF text are checked for injection-like content when
  read_file returns them; a hit prints `suspicious: injection-like (…)` and makes the connection suggest-only, as a
  flagged page does (docs/adr/2046-*).
- `POST /api/files` with a bearer token (MCP, agent connection tokens, API tokens) now needs `pageId`, checks the
  page's edit lock for the connection, takes at most `AGENT_UPLOAD_MAX_MB` (default 5 MB) and types the file from its
  name and bytes (the Content-Type sent is ignored). Browser uploads are unchanged and have no budget, except that
  `text/csv`, `text/markdown` and `application/json` are now accepted (docs/adr/2044-*, 2045-*).
- **Uploads by AI agents can be turned off** (docs/adr/2065-*). `AGENT_UPLOADS=on` (default) / `off` / `never`, and
  each workspace can follow the server or turn them on or off (Workspace settings › Connected agents › File uploads).
  Nothing changes unless you set it: agent uploads are on with 5 MB per file and 200 MB per account per 24 hours,
  counted over uploads through connections only (`AGENT_UPLOAD_DAILY_MB=0` removes the budget).
- `AGENT_UPLOAD_MAX_MB` (default 5, at most 64) raises the per-file cap for agents. Above 8 MB the `/mcp` body limit
  grows for upload_file calls only (base64 of the file + 1 MB); every other MCP request keeps 12 MB. An upload in
  flight holds about four times the file in memory (docs/OPERATIONS.md section 10).
- `/mcp` now reads its query string (`?profile=core`). Connections without `profile` get the full list, as before;
  an unknown value is HTTP 400. A reverse proxy that drops the query string gives every connection the full list
  (docs/adr/2000-*).
- Personal API tokens still do not work at `/mcp` (docs/adr/1201-*); use an agent connection token there.

### Added
- **MCP tool profiles** (docs/adr/2000-*). The MCP URL takes `?profile=core` or `?profile=full`; without it a
  connection is `full`, as before. `core` lists 32 tools (the everyday flows: find and read, section writes,
  comments, inbox, catch_up, changes_since, section claims, suggestions, rows, read_file) including `more_tools`,
  which lists the other 16 tools, prints one tool's arguments and runs it with the tool's own checks. core's tool list
  is ~7,437 tokens against ~12,370 for full (0.15.1: ~11,923). The OAuth resource indicator
  `https://<host>/mcp?profile=core|full` is accepted as `/mcp`.
- **MCP resources**: pages as `inkling://page/<id>` (a resource template), and a short list for clients' `@` menus —
  your favorites, then the most recently changed pages, at most 50, with every access rule of the tools. Reading one
  returns the read_page answer (docs/adr/2001-*).
- **MCP prompts** `catch-up`, `meeting-notes` and `memory-review` (fixed server text, id arguments only)
  (docs/adr/2002-*).
- **MCP `check_notes`**: a read-only memory check of a workspace or subtree — broken `[[links]]` (and links to
  trashed pages), duplicate titles, pages with no links in or out, lapsed or much-changed verifications, large pages
  unchanged for 180 days; totals and top items within a token budget. REST: `GET /api/workspaces/:id/notes-check`
  (docs/adr/2003-*).
- **MCP `upload_file(pageId, name, text | base64, section?, attachOnly?)`**: attach a PNG, JPEG, GIF, WebP, PDF,
  txt/log/tsv, csv, md or json file to a page the connection may edit, linked at the end of the page or of a section
  through the page's own write path — so it is in the change feed, catch_up and revert, and becomes a suggestion where
  agent edits are reviewed. SVG, HTML, scripts and unknown types are refused (docs/adr/2044-*, 2045-*).
- **`read_file` reads PDFs**: the text layer by page range (`pages: "1-5"`, default 1–20, at most 50 per call, files
  up to 20 MB), wrapped as untrusted, with "pages A–B of N" and where to continue; scanned PDFs answer "no text" (no
  OCR), password-protected and damaged PDFs say so. Parsed in a worker thread with a 10 s limit (docs/adr/2047-*,
  2048-*).
- `read_file` reads more text files by extension (yaml, yml, xml, html, htm, svg as source, ini, toml, cfg, conf,
  sql, rst, tex, md, csv, tsv, log), also when an import stored them as `application/octet-stream` (docs/adr/2046-*).
- **Agent connection tokens** (Settings › Connections › Agent connection tokens, docs/adr/2060-* .. 2063-*): for AI
  apps that cannot sign in with OAuth — no dynamic client registration, a server on plain `http://` at a LAN
  address, a self-signed certificate. Name it (the name is its "via" label), pick read or read and write and a range
  as on the consent screen, and an expiry (7, 30, 90 by default, or 365 days; no "never"). The token (`ink_agt_…`) is
  shown once and works only at `/mcp`, as `Authorization: Bearer …`. It is an agent connection like a signed-in app:
  agent edit locks and instructions, the workspace's edit policy and suggestions, claims, usage, agent blocks and the
  two-step requirement, the Connected agents list, the team agents board, hand-offs and assignments, suggest-only
  after flagged content, tool profiles, resources and prompts all apply. At most 20 live tokens per account.
- **Connection settings generator** (Settings › Connections › Connect an AI app, docs/adr/2020-*): pick Claude Code,
  Claude Desktop / claude.ai, Cursor, VS Code or another app, and copy the command, the JSON for the app's file, or
  the URL. Choose all tools or the core tools (`/mcp?profile=core`), and sign-in or an agent connection token: while a
  token you just made is shown it is filled into the command or file; it is never stored. A short help covers local
  servers and certificates. Windsurf is not listed; its documentation no longer describes its format, so use the
  generic JSON.
- **Suggest-only connections in the app** (docs/adr/2040-* .. 2043-*): connection lists and the team agents board say
  "Suggestions only until HH:MM"; the owner can **Allow edits again**, workspace owners and admins can **Allow edits
  here** when the flagged content was in their workspace. Suggestions with origin `taint` show why they wait and are
  never auto-accepted. Release routes, the workspace switch, `suggestOnly` on the connection lists, audit events
  `agent.tainted` and `agent.taint_released`.
- **Long agent instructions** (docs/adr/2004-*, 2021-*): get_instructions ends with one note when the instructions it
  returned are longer than 200 lines or 25 KB; `GET /api/workspaces/:id/agent-instructions/length` gives the sizes,
  and the edit lock dialog and the page's lock line show a warning for a long instruction page.
- Workspace setting "Uploads by AI agents" (server default / on / off), owners and admins, audited as
  `settings.updated`; refusals are 403 `AGENT_UPLOADS_OFF` naming who can change it; under `AGENT_UPLOADS=never` the
  setting is shown disabled with the reason (docs/adr/2065-*).
- Admin › Status shows the agent upload mode, the per-file cap, the daily budget ("no daily budget" for 0) and the MCP
  body limit for upload_file calls; a mistyped value shows as a warning.
- An Inkling skill for Claude Code, `examples/claude-skill/inkling/SKILL.md`: the order to use the tools in
  (find_context first, outline then section, baseVersion, claims, suggestions, inbox and ack, catch_up, hand-offs,
  splitting logs, the memory check). Copy it to `~/.claude/skills/inkling/` (docs/adr/2022-*).
- docs/RECIPES: "Team memory: keeping it usable" (one page per item, short instructions as an index, periodic
  checks with check_notes, the source next to the fact).
- Audit actions `agent.token_created`, `agent.token_revoked` and `agent.token_range_changed`, written in each
  workspace the token's range reaches.

### Changed
- The claude.ai connector steps follow Claude's current menu: Customize › Connectors › + Add › Add custom connector
  (Team and Enterprise: Organization settings › Connectors).
- `can:` lines say `suggest` while the connection is suggest-only in that workspace.
- `oauth_grants.tainted_at` is still written but no longer the record of taint; `connection_taints` is.
- The `/mcp` 401 for an `ink_agt_` token reads "Invalid, expired or revoked agent connection token".
- Routes and fields: [docs/API.md](docs/API.md), "v0.16.0 additions".

### Fixed
- `agentVia.db.test.ts` "the daily AI summary names the agent page, never the form row" could find no
  `agent_digest` item when the database clock ran ahead of the test host (Docker's VM clock drifts after a laptop
  sleeps); the test now closes the window on the database clock. No product change.

### Security
- An agent that was handed injection-like content can no longer write unreviewed for an hour (see above). The
  heuristics are mitigations, not a boundary: they are evaded by paraphrase, other languages and split text
  (docs/KNOWN-ISSUES.md).
- Uploads through connections are typed by the server; SVG, HTML, scripts and other active or unknown types are
  refused.
- Guessing agent connection tokens at `/mcp` counts towards the IP ban (10 in 15 minutes); a banned IP gets 429 for
  `ink_agt_` tokens before any lookup. An expired token that exists is not counted, and OAuth access tokens are not
  counted (clients present expired ones before refreshing) (docs/adr/2062-*).
- Agent connection tokens are made, listed and revoked in a browser session only; a token never makes another.

### Performance
- MCP fixed cost per session (tools/list + server instructions): ~12,390 tokens in 0.15.1; 0.16 full ~12,837
  (+3.6%: upload_file 207, check_notes 201, read_file +38), core ~7,904 (−36.2%). The initialize result grew by 16
  tokens (resources and prompts capabilities).
- check_notes on 2,000 pages: p50 18.0 ms, p95 26.8 ms; default answer 552 tokens.
- PDF text (worker thread per call): a 3-page PDF in a median 73 ms, a 200-page one in 129 ms; the main thread's
  longest timer gap 2.6 ms.
- A write by a bearer connection runs one indexed statement per workspace for the suggest-only check; browser
  requests run none.
- Numbers and methods: [docs/PERFORMANCE.md](docs/PERFORMANCE.md).

### Database
- Migration 0048: table `connection_taints` (one row per connection and flagged source, pruned after 30 days),
  `workspaces.agent_taint_demote boolean not null default true` (docs/adr/2040-*, 2043-*).
- Migration 0049: `oauth_grants.kind text not null default 'oauth'` (existing rows become `oauth`),
  `oauth_grants.token_prefix text` (docs/adr/2061-*).
- Migration 0050: `workspaces.agent_uploads text` (NULL = server default), `files.uploaded_via text` and the partial
  index `files_agent_uploads_idx (created_by, created_at) WHERE uploaded_via IS NOT NULL` (docs/adr/2065-*).

## [0.15.1] - 2026-11-10

A patch release that follows an outside evaluation of the agent tools and reports from a production server. One
database migration, additive: `0047_v0151_index_stamp` (column `page_chunk_index.doc_updated_at`, filled from
`page_docs.updated_at` for existing rows, so the first boot re-indexes nothing). A 0.15 database goes from 47 to 48
applied migrations. Two new environment variables, both optional: `SINGLE_INSTANCE` and `SINGLE_INSTANCE_WAIT`. No
new dependency. Upgrade matrix adds v0.15.0 (`.github/workflows/upgrade.yml`). Several defaults of the MCP tools
changed; read the upgrade notes first.

### Upgrade notes
- The server refuses to start while another Inkling process uses the same database. A replacement waits up to
  `SINGLE_INSTANCE_WAIT` seconds (default 60) for the old one to stop, then exits; `SINGLE_INSTANCE=0` turns the guard
  off. `docker compose up -d` stops the old container first and is not affected (docs/adr/1925-*).
- MCP `list_pages` and `search` default to `format: "compact"`. Clients that parse their JSON must pass
  `format: "json"` (docs/adr/1944-*).
- MCP text outputs print 8-character ids (find_context, read_page header and outline, `unchanged` lines,
  list_comments thread ids, get_instructions); every tool accepts them. JSON outputs and urls keep full ids
  (docs/adr/1906-*, 1941-*, 1942-*).
- `read_page(outline=true)` lines are `- §<anchor> ~N tok v=…`, indented one space per level, without the repeated
  heading text; the owner's status, verified/stale and claims lines come after the page text (docs/adr/1942-*,
  1946-*).
- `update_page` with `mode: "replace"` takes `baseVersion` (read_page's `version:` line). Without it, a replace is
  refused when a person edited the page last; pages an agent wrote last are replaced as before (docs/adr/1947-*).
- find_context output: page ids as 8-character prefixes, `can:` once in the first line when every result has the
  same, `; truncated, section ~N tok` on a cut fragment, verification marks in one last `Verification:` line, and a
  last `Not in any result: …` line on a weak answer (docs/adr/1902-*, 1904-*, 1906-*, 1907-*).
- `queries=[…]` merge with RRF k = 10 instead of 60 (docs/adr/1905-*).
- Agents that write by a short anchor or heading text without `baseVersion` can get `SECTION_AMBIGUOUS` after a
  heading with the same name was added, moved or renamed (within the 30 days of change-log retention). Pass the
  `v=…` you read, or read the section and retry with its full anchor (docs/adr/1960-*).
- Vaults synced with an older server need no action: the first `inklingctl sync` after the upgrade re-reads pages
  changed since the last sync and merges notes edited locally once; nothing is overwritten or marked as a conflict
  (docs/adr/1920-*).

### Fixed
- **Vault sync no longer brings back text deleted on the server.** A pure deletion (an agent's `patch_section` with
  `mode: delete`, a deleted paragraph) did not change the page's sync revision, so `inklingctl sync` of a note edited
  elsewhere overwrote the page with the old text and the deleted section came back. The revision now includes the
  document's deletions. Server-only change. A note deleted locally before the upgrade is still trashed on the server
  (docs/adr/1920-*).
- **A vault write no longer erases typing that was on its way from a browser.** The note is applied as a minimal edit
  (the `update_page` replace path): blocks the note did not change keep their nodes, colours and ids, and typing
  that reaches the server just after the write merges into them (docs/adr/1920-*).
- **Edits are not lost when saving fails and the last person leaves the page.** A save that failed after its retries
  used to wait for the next edit; when the last editor left, the server dropped the document from memory without
  saving. Now a failed save retries in the background (5 s, doubling up to 60 s), and a page with unsaved changes is
  saved before it leaves memory or kept there until a save succeeds (docs/adr/1921-*).
- **`ack(cursor)` acknowledges only what the inbox listing showed.** After `inbox(workspaceId=A)` or
  `inbox(kinds=[…])`, `ack(cursor)` also acknowledged older items of other workspaces and kinds, and items the agent
  could not see. The listing and the acknowledgement now share one filter; the MCP cursor of a filtered listing
  carries its filters (`<seq>;ws=<id>;kinds=a,b`, unfiltered stays the plain number), and `POST /api/inbox/ack` takes
  `workspaceId` and `kinds` with `cursor` (docs/adr/1922-*).
- **Duplicating an open page copies its last seconds of typing**: open documents in the subtree are saved and indexed
  before the copy (docs/adr/1923-*).
- **Ownership transfer refreshes cached permissions**: it bumps the workspace access version like any role change
  (docs/adr/1923-*).
- **Search and find_context catch up after a crash.** A crash between a save and its queued index pass left the
  page's search text, sections, links, tags and tasks describing the old content until the next edit. At boot, pages
  whose stored content is newer than their index are re-indexed in the background, about ten a second
  (docs/adr/1924-*).
- **A section write no longer lands in a section that took over the name the agent had.** find_context prints short
  anchors (`decided` for `alpha/decided`); when a new `# Beta / ## Decided` was inserted above,
  `patch_section(section='decided', mode='append')` wrote into the new section. A name that fits several sections, or
  that another still-existing section answered to before (change log, or the section index while typing is not
  logged yet), now needs the `v=…` printed next to it as `baseVersion`; it picks the section with that version.
  Otherwise nothing is written and the error names the sections: `Section "decided" now names §beta/decided, but
  §beta/decided~2 answered to that name before … Read the one you mean with read_page(pageId, section=<anchor>) and
  retry with that anchor and its version as baseVersion`. Also patch_sections, claim_section and add_comment (these
  two take no version: they ask for the full anchor). The usual find_context → patch_section flow needs no extra call
  (docs/adr/1960-*).
- **find_context: the section that answers takes its page's slot** (docs/adr/1900-*). A section that is only a line
  of links (an `_intro` like `← [[previous]] · [record](https://…)`) or that matches the question only through the
  page title no longer holds the page's one result slot when another section of the same page matches by itself;
  such link lines also score like heading-only chunks. Field case: "<idea> 폐기 이유" now shows the ruling, not the
  link line above it.
- **find_context ignores link targets and bare URLs when matching words** (docs/adr/1901-*). A table whose links
  contain `…/solar-forecast/…` no longer outranks the short section that answers "solar forecast best submission
  score". Query time only; nothing is re-indexed.
- `catch_up(since=<time>)` started a few rows late when one batch of change-log rows straddled a power of ten in
  `seq`: the start row was picked by `seq::text … ORDER BY seq`, which sorts the text alias ("100" before "99"), so a
  page changed in that batch could be left out. It now orders by the column; the inbox start of catch_up and the
  audit record of a revert had the same pattern and are fixed too.

### Added
- **Single-instance guard** (docs/adr/1925-*). At boot, before migrations, the server takes a Postgres advisory lock
  on its own connection (`inkling-instance-lock` in `pg_stat_activity`) and keeps it until it exits; the log names
  the other process while it waits. `SINGLE_INSTANCE`, `SINGLE_INSTANCE_WAIT` in `compose.yaml` and `.env.example`.
- **"Not saved yet" in the editor** (docs/adr/1926-*). When edits have not reached the server (connection down), the
  connection dot turns amber with the words "Not saved yet", the browser asks before a reload or tab close, and
  leaving the page inside the app keeps the edits until the server has them.
- MCP `read_page(backlinks=true)`: the pages that link here, after the page (docs/adr/1948-*).
- MCP `create_page(kind="canvas"|"folder")` (docs/adr/1948-*).
- MCP: `workspaceId` can be left out of list_pages, create_page, import_folder, create_from_template,
  create_collection and get_instructions: it comes from `parentId`/`forPageId`, or from the only workspace of the
  connection; with several, the error lists them (docs/adr/1943-*).
- `read_page(outline=true, known=v)` answers one line when no section changed: the outline has its own version
  (docs/adr/1942-*).
- `scripts/mcp-tools-list-cost.ts` (tool list size per tool, no database) and `scripts/mcp-output-cost.ts`
  (outline, header and list sizes before and after, scratch database).

### Changed
- **find_context packing** (docs/adr/1902-*): a section larger than 40% of the budget is cut around its best
  matching lines (a table keeps its column row) so shorter relevant sections after it still fit; a cut fragment says
  the size of the whole section (`; truncated, section ~612 tok`). A small chunk counts as at least 80 tokens (was
  60) when packing by value per token. `queries=[…]` answers are packed the same way and cut around the words of the
  query that found the piece.
- **find_context matches more word forms** (docs/adr/1905-*): English plurals and -ed/-ing ("deploys", "approved",
  "answering") also find the base form; Korean words with two particles ("회의에서는") are stripped twice.
- **queries=[…] merge**: RRF k 60 → 10 (docs/adr/1905-*).
- **find_context output** (docs/adr/1906-*, 1907-*, 1908-*): page ids are printed as their 8-character prefix; `can:`
  is printed once in the first line when every result has the same; verification marks (`verified`, `stale:
  verification lapsed`) moved from each fragment header to one `Verification: [n] …` line at the end.
- **Notes in another language** (docs/adr/1904-*): the find_context description and the empty answer suggest
  `queries=[original, translation]`; an answer where more than half of the query's words (and at least two) are in
  no result ends with `Not in any result: … If the notes may be in another language, ask again with queries=[…]`.
  The MCP server instructions gained one sentence: "If the notes may be in another language than the question, pass
  queries=[question, translation]." (+24 tokens).
- **MCP tool list is 28% smaller** (docs/adr/1940-*, 1945-*): ~16,500 → ~11,900 estimated tokens (65,971 → 47,646
  characters) with no tool or argument removed. Id fields no longer carry a 190-character UUID pattern each (51
  fields), the SDK's default `execution` and `$schema` lines are left out, and update_fields / create_view point to
  the create_collection / create_chart specs instead of repeating them (checked by the same schemas in the handler).
- **Short ids everywhere** (docs/adr/1941-*). Every MCP id argument (page, parent, collection, row, workspace,
  comment thread, trashed page) accepts the first 8 or more hex characters as tools print them. Prefixes resolve
  only among what the connection can see; a page the agent cannot see never makes a prefix ambiguous and never
  shows in an error. Version and suggestion ids still need the full id.
- **read_page and outline print each id once** (docs/adr/1942-*): 8-character ids in the header, the outline, the
  `unchanged` line, list_comments and get_instructions; full ids only in the url. Outline lines drop the heading text
  that repeated the anchor and are indented by level. Outline 34% smaller, full-read header 16%.
- **list_pages and search default to `format: "compact"`** (docs/adr/1944-*); `lines` and `json` are unchanged.
- **Values that change without the page come after the body** (docs/adr/1946-*): the owner's status, verified/stale
  and live claims are printed after the page text in read_page (and after the list in outlines), so the header and
  body stay a stable prompt-cache prefix.
- **update_page replace names the version it read** (docs/adr/1947-*): `baseVersion`; a changed page is not
  overwritten (`PAGE_CONFLICT`). The MCP server instructions say so. patch_section keeps its own rule: `replace` and
  `delete` already require `baseVersion` in the MCP tool (docs/adr/1961-*).
- **Change feed: an anchor that passes from one heading to another is a rename** (docs/adr/1960-*). Inserting a
  heading above one with the same name (`## Decided` above `## Decided`) was logged as `modified decided` +
  `added decided~2`; it is now `renamed decided>decided~2` + `added decided` (the text reads `renamed decided →
  decided~2`). Deleting the first of two gives `removed decided` + `renamed decided~2>decided`. changes_since,
  catch_up, activity and revert see these kinds for that pattern. A heading retyped as a new block stays
  `modified`.
- README: "offline edits merge on reconnect" now says they merge while the tab stays open, and that the tab warns
  before closing with unsaved edits.
- Routes and fields: [docs/API.md](docs/API.md), "v0.15.1 additions".

### Performance
- find_context on 78 evaluation questions (16 new ones reproduce the field cases), padded corpus + 5,000 distractors:
  dev MRR 0.841 → 0.896, recall@5 0.881 → 0.948, answer in the returned text 0.889 → 0.956, tokens per question
  361.6 → 317.6 (−12.2%); held-out test MRR 0.879 → 0.909, recall@5 0.899 → 0.960, answer in text 0.909 → 0.970,
  tokens 399.1 → 290.2 (−27.3%) (docs/adr/1909-*).
- find_context latency regressed: p50 about +5.5 ms (+14%, +3.6 to +8.8 ms per interleaved pair), p95 +11 to +28 ms.
  The query forms return 9% more candidate rows; ranking and cutting add no measurable CPU.
- MCP fixed cost per session (tools/list + server instructions): ~16,938 → ~12,390 tokens (−26.9%). read_page outline
  −34.4% (a repeat with `known` −93.5%), full-read header −15.9%, list_pages without `format` −81.4%.
- A vault sync revision of a stored page costs 11.5 ms instead of 3.0 ms (1.17 MB state), only for pages changed since
  the sync cursor (docs/adr/1920-*).
- A section write by a short anchor or heading text runs two small indexed queries first (docs/adr/1960-*).
- Numbers and methods: [docs/PERFORMANCE.md](docs/PERFORMANCE.md).

### Database
- Migration 0047: `page_chunk_index.doc_updated_at` (timestamptz, NULL), set from `page_docs.updated_at` for existing
  rows and after every complete index pass. A boot pass re-indexes pages whose `page_docs.updated_at` is newer
  (docs/adr/1924-*).

## [0.15.0] - 2026-11-10

Four database migrations, all additive: `0043_v015_slack` (tables `slack_integrations`, `slack_user_links`,
`slack_link_codes`, `slack_request_nonces`), `0044_wave13_forms` (table `collection_form_links`),
`0045_wave13_verify_present_status` (column `pages.share_starts_at`, tables `page_verifications` and `user_statuses`)
and `0046_wave13_team_agents` (columns `notifications.connection` and `notifications.person_too` with a partial index,
`user_notification_settings.agent_handoff_copy`). Existing rows keep their meaning. A 0.14 database goes from 43 to 47
applied migrations. Formula fields and form views need no column (field definitions and view config are jsonb). No
new dependency. Upgrade matrix adds v0.14.0: CI also tests the upgrade from it with data
(`.github/workflows/upgrade.yml`, docs/adr/1052-*).

### Added
- **Slack app per workspace** (docs/adr/1800-* to 1806-*). Workspace owners connect their own Slack app under
  Workspace settings → Slack: bot token, signing secret, channel ID, and which updates to post. The settings page
  shows the request URLs, scopes and a filled-in app manifest.
- Slack channel posts for mentions, assignments, open agent suggestions, comment replies and a daily summary of
  changed shared pages, each switched on or off. Only pages shared with the whole workspace are ever named; private
  pages, trashed pages and other workspaces are dropped when the post is sent. Posts go through the outbox with
  retries, backoff and Slack's Retry-After; saving and editing never wait for Slack. A revoked token or a bot removed
  from the channel pauses posts until the settings are saved again or the Test button passes (docs/adr/1802-*).
- `/inkling <words>` in Slack answers with find_context results visible only to the person who typed it, as their own
  Inkling account. Accounts link automatically when the Slack and Inkling email addresses match, or with
  `/inkling link` (one-time link, 10 minutes). Unlinked people get only the instructions (docs/adr/1803-*).
- Inkling page links pasted in Slack unfurl with the title and first paragraph (shared pages only, docs/adr/1805-*).
- **Form views** (docs/adr/1820-*). A collection can have a "Form" view that adds a row per answer: choose the
  questions (title and text, number, select, multi-select, date, checkbox, URL, person), their order, "required" and a
  help text; set the form's title, description, button text and the message after sending. Members fill it in the app.
- **Public forms** (docs/adr/1821-*, 1822-*). Owners and admins can turn on a public link for a form view
  (`/f/<token>`): anyone with the link can send answers, which become rows; visitors never see rows or other answers.
  The link can be turned off at any time (the old link stops at once) and closes by itself when the collection is
  trashed or made private, public links are turned off in the workspace, or the member who published it can no
  longer add rows. Answers appear in the change feed and catch_up as "<publisher> via public form". Audit:
  `form.published`, `form.unpublished`.
- **Formula fields** (docs/adr/1823-* to 1825-*). A new property type computes a value from the same row: arithmetic,
  comparisons, `if`, `and`/`or`/`not`, `concat`, `length`, `round`, `min`/`max`, `abs`, `now`, `dateAdd`,
  `dateBetween` and `prop("Name")`. Errors show in the cell (circular reference, division by zero, unknown
  property…). Formulas follow property renames. The server and the web compute the same values.
- Formulas work in view filters and sorts, chart views and chart blocks (group by, sum/average when the formula yields
  a number), exports, and agents' `query_rows` (filter, sort, display) (docs/adr/1826-*, 1827-*).
- MCP: `create_view` takes `type: "form"` with `form` settings (questions by property name); `create_collection` and
  field specs take `type: "formula"` with `expression`; `query_rows describe=true` lists formulas as
  `(formula → number, read-only)`; formula error cells read `#error(code)`.
- **Page verification** (docs/adr/1840-* to 1842-*). "Verify page…" in the ⋯ menu marks a page as correct until a
  date (30/90/180 days or a date, at most a year). The badge under the title says "Verified until …" or, after the
  date, "Needs verification", and how many sections changed since (from the change feed). Who: people who can edit
  the page; when the page has a document owner, only that owner or a workspace owner/admin. Verifying also counts as
  a review. "All verified pages" lists pages that need verification, expire within 7 days, or are verified. Audit:
  `page.verified`, `page.unverified`. MCP: `read_page` prints `- verified: until 2026-12-10` or
  `- stale: verification lapsed 2026-11-01` (+ `, N sections changed since`); `find_context` adds `; verified`,
  `; verified, changed since` or `; stale: verification lapsed`.
- **Presentation mode** (docs/adr/1843-*). "Present" in a document's ⋯ menu and on shared pages: slides split at the
  highest heading level and at dividers, full screen, ←/→ (PageUp/PageDown, Space, Home/End), swipe, Esc. Read-only
  copies of the blocks; the fade is off under reduced motion.
- **Scheduled public links** (docs/adr/1844-*). A public link can get a start time ("Schedule a start" when
  publishing, "Opens …" with "Change start" / "Open now" afterwards, a badge in Web shares). Before the start every
  public route answers like a link that is not shared (404, same body, plain shell) and visits are not counted as
  token guesses; after the expiry it is 410 as before. Times are picked in the device's time zone. Audit:
  `share.start_changed`.
- **Member status** (docs/adr/1845-*, 1846-*). Settings → Account → Status: an emoji and a short message with an
  automatic clear time (in an hour, today, this week, or a date and time). Shown in the members panel, the `@`
  mention menus and on presence avatars. MCP: after `patch_section`, `update_page` and `create_page` that mention
  people with a status, one line `status: Mia "🎓 Exam week" until 2026-11-14`; `read_page`'s owner line carries the
  owner's status.
- **Team agents board** (`/w/:wsId/team-agents`, linked from Activity; docs/adr/1862-*). Per person: sections their
  agents claimed with the minutes left, their suggestions waiting for a person, and what each agent connection did
  today (edits, new pages, suggestions, changes a person reverted, recent pages). Pages you cannot open are listed
  without title or section. `GET /api/workspaces/:id/team-agents?since=` (members only).
- **Hand a comment to one agent** (docs/adr/1863-*). `@Bob · Claude Code` in the comment box (or `mentionConnections`
  in `POST /api/pages/:id/comments`, or `handoffTo` on MCP `add_comment` / `reply_comment`) puts the thread in that
  connection's inbox only; Bob's other connections and Bob's bell do not get it unless Bob turns on "Show me what is
  handed to my agents" (Settings › Notifications). Mention menus and comment boxes offer the members' live agent
  connections (`GET /api/workspaces/:id/agent-connections`). A revoked or expired connection hands its open items back
  to the person.
- **Assign work to a person's agent** (docs/adr/1864-*). A person cell can name one of that person's connections
  (picker under each member in the table and the row panel; MCP `update_row` / `create_row` take `"this connection"`,
  `grant:<id>` or `g:1a2b3c4d`). The cell keeps the person (0.14 clients show the person); the agent sits next to it
  under `agent:<fieldId>`. An agent chip in a to-do assigns that task to the agent. The assignment goes to the agent's
  inbox (`assigned → this connection`). `query_rows`: `Owner = this connection`; cells read `Bob → Claude Code (g:…)`.
- **catch_up `team: true`** (docs/adr/1865-*): one extra group with other connections' live claims and one line per
  other busy agent. Off by default: catch_up output is unchanged.

### Changed
- Answers sent through a public form count as people's input everywhere Inkling separates people from AI: the
  activity "AI" filter and client list, the "Written by AI" badge, the daily AI summary (in-app and the `agent_digest`
  webhook), the team agents board and notification quieting. They still read "<publisher> via public form"
  (docs/adr/1870-*).
- MCP: `update_row` / `create_row` that assign people (or a person's agent) end with one
  `status: Name "…" until …` line when someone assigned has a status; `query_rows` ends with one such line for the
  people in the shown person cells. Nothing is added when nobody has a status. Agent chips in written Markdown count
  as their person for the existing status line (docs/adr/1846-*, 1870-*).
- MCP `inbox`: an item handed to this connection reads `… | mention (comment) → this connection | …`, the header adds
  `(N handed to this connection)` when N > 0; every other line is byte-identical. `ack` from one connection never
  acknowledges items handed to another.
- Only live connections of workspace members can be targets of a hand-off or an assignment: a non-member's, another
  person's, one whose range leaves the workspace (or, for a subtree range, the page) out, or one blocked there is
  refused with 400 `AGENT_NOT_AVAILABLE` and nothing is written (docs/adr/1860-*).
- Slack: work handed to one agent connection is never posted to the channel, also when the person keeps a copy; a
  comment that mentions a person and hands to their agent posts once (docs/adr/1870-*).
- The mention menus show a person's status on their agents' entries too; the comment box shows statuses like the
  editor menu.
- New routes and fields are in [docs/API.md](docs/API.md), "v0.15.0 additions".

### Performance
- query_rows filter and sort on a formula: 16.2 ms at 2,000 rows, 96.1 ms at 20,000 rows (the same query on a stored
  number: 7.6 / 35.2 ms). A cursor page on a formula sort takes 161–172 ms at 20,000 rows (first page 89–121 ms)
  (docs/adr/1826-*).
- MCP tool list: the hand-off and team parameters add 149 tokens per session (0.9% of the tool list). An inbox line
  for a hand-off is 12 tokens longer; `catch_up(team=true)` adds about 113 tokens in the test fixture; a status line
  after a row write or `query_rows` is 11 tokens per person. Outputs without hand-offs, `team` or statuses are
  byte-identical.
- Workspaces without a Slack app: the notification consumer does one cached lookup per event (60 s cache), no extra
  SQL statement once cached.
- Numbers and methods: [docs/PERFORMANCE.md](docs/PERFORMANCE.md).

### Security
- Requests from Slack are checked with the v0 signature, a 5-minute timestamp window, the team ID and a replay table
  (docs/adr/1804-*). The bot token and signing secret are sealed with APP_SECRET_KEY (when set), never returned by the
  API and never logged (docs/adr/1801-*). Slack settings are for workspace owners only.
- The public form route is the first anonymous write. It accepts only the asked properties (no person, relation or
  formula), answers only `{ ok: true }`, and is limited: 10 answers per minute per IP, 300 per form per hour (per
  server process), a 32 KiB body, 5,000 characters per text answer, a strict body schema and a honeypot field. No
  CAPTCHA or other third party (docs/adr/1822-*).
- Formulas run in a small evaluator of our own (no `eval`, no `new Function`, no dependency) with caps on length
  (2,000 characters), size (300 parts), nesting (40) and built text (10,000 characters) (docs/adr/1824-*).
- `public form` is a reserved OAuth client name, so an agent cannot label its edits as form answers
  (docs/adr/1870-*).
- Being assigned work gives an agent connection no rights: it still acts as its person, within its range
  (docs/adr/1860-*).

### Database
- Migration 0043: `slack_integrations`, `slack_user_links`, `slack_link_codes`, `slack_request_nonces`.
- Migration 0044: table `collection_form_links` (view_id PK → collection_views ON DELETE CASCADE, token_hash unique,
  token_enc, published_by → users ON DELETE SET NULL, created_at).
- Migration 0045: `pages.share_starts_at`, tables `page_verifications`, `user_statuses`.
- Migration 0046: `notifications.connection` (text, NULL), `notifications.person_too` (boolean, default false) with a
  partial index on `connection`; `user_notification_settings.agent_handoff_copy` (boolean, default false).

## [0.14.0] - 2026-11-10

One database migration, `0042_v014_semantic_vectors`: the table `page_chunk_vectors` (one `real[]` vector per section
chunk, no pgvector, no new database extension or image). Nothing writes to it unless an operator sets up semantic
search: it is **off by default** and only turns on when both `EMBEDDING_URL` and `EMBEDDING_MODEL` are set. With the
variables unset nothing of it runs (no request, no timer, no query) and a single find_context query answers byte for
byte as without it. No new dependency. Upgrade matrix adds v0.13.0: CI also tests the upgrade from it with data
(`.github/workflows/upgrade.yml`, docs/adr/1052-*).

### Added
- **find_context takes several phrasings at once.** `queries: [...]` (up to 5, next to or instead of `query`) searches
  synonyms, translations and other wordings in one call and merges the answers by Reciprocal Rank Fusion (k = 60)
  under one token budget. Each section is shown once with the queries that found it (`matched: 1,3`); header, footer
  and hints appear once. In the benchmark, 5 bundles of 3–5 phrasings: 18 calls → 5, returned tokens −24% (default
  budget) / −38% (budget 1,200), every answer section still shown (docs/adr/1720-*).
- `GET /api/context` accepts `q` repeated (`?q=a&q=b`, up to 5 different values): the merged result adds `queries` and
  a `matched` list per fragment. A single `q` answers exactly as before while semantic search is off
  (docs/adr/1720-*).
- **Optional semantic search** (off by default, docs/adr/1740-* to 1745-*). Set `EMBEDDING_URL` (any
  OpenAI-compatible `/embeddings` API, including a local Ollama at `http://host:11434/v1`) and `EMBEDDING_MODEL`,
  optionally `EMBEDDING_API_KEY`, and the server embeds the section index in the background (only changed chunks,
  rate limited, backing off when the endpoint fails) and can rank sections by meaning, so a Korean question can find
  an English section. Vectors are a plain `real[]` column (migration 0042, no pgvector, no new dependency); search
  compares them in memory within the pages you may see. The admin status shows indexed and waiting sections and the
  last error, never the key. Without the variables nothing of it runs and every output is unchanged. When on,
  find_context and `GET /api/context` merge each query's semantic candidates into the answer (Reciprocal Rank Fusion
  with the word search; candidates below 0.6 × the best match are left out), so a section that shares no word with
  the question is shown with its text (docs/adr/1723-*).
- `fuseContextResults(…, { extra })` / `cachedFindContextMulti(…, { extraLists })`: extra ranked lists join the same
  RRF merge; semantic candidates use it (docs/adr/1722-*, 1723-*).

### Changed
- find_context finds Korean words written differently in the question and the note (docs/adr/1700-*): a compound in
  the question also matches its spaced form ("팀구성" finds "팀 구성은 다섯 명으로", "회의주기" finds the heading
  "회의 주기"); a one-syllable noun with a particle counts as the noun ("팀을", "팀으로" find 팀, 팀에, 팀의, but not
  팀장); more verb endings are stripped ("결석했을" → 결석). Particles are only split off when they fit the noun's
  last sound, so 가을, 마을, 아이, 평가 stay whole. All at query time: no migration and no re-index.
- Page aliases count as the page's title in find_context: a query with only "PayFix" finds the page whose alias it
  is (docs/adr/1701-*).
- A section whose heading names the question weighs more (heading weight 0.2 → 0.3, set on the dev questions only,
  docs/adr/1701-*).
- `find_context`: `query` is optional when `queries` is given; one of the two is required. A call with one query (or
  with `queries` whose entries are all the same query) returns exactly the answer of `query` alone.
- The find_context cache (docs/adr/1550-*) also stores merged answers, and a bundle reuses the entries of its queries
  asked alone or in other bundles (docs/adr/1721-*).
- With semantic search on, every find_context call is merged (one query too): the header stays
  `N result(s) for "q"` and no `matched:` is printed for one query; the REST answer of one `q` gains `queries` and
  `fragments[].matched`. Off (the default), one query answers exactly as before (docs/adr/1723-*).
- `GET /api/admin/status` adds `semantic` while semantic search is on (docs/adr/1744-*).
- New routes and fields are in [docs/API.md](docs/API.md), "v0.14.0 additions".

### Fixed
- The changes_since long-poll tests run alone (`run-tests: db-exclusive`): with other test files on the same
  database another process's change consumer could apply the test's row and the wait missed it; the timing checks
  wait on the waiter registry instead of a sleep.

### Performance
- Retrieval evaluation: 4 more fictional pages and 15 more questions (8 dev, 7 test) in four failure families
  (compound in the query, particle on the query word, compound in the note, page alias) with per-family metrics; 62
  questions, dev 37 / test 25 (docs/adr/1702-*). `context-bench.ts` prints the family table and the workspace ids for
  `context-tune.ts` / `context-explain.ts`.
- find_context ranking on the large set: dev MRR 0.874 → 0.901, recall@5 0.910 → 0.937; test MRR 0.920 → 0.940,
  recall@5 0.927 → 0.947. Cost: p50 about +4–6 ms (+11–15%) on the 15,732-chunk benchmark, and a common
  one-syllable noun with a particle ("팀을 나눈 방식") 11 → 40 ms.
- Several phrasings in one call: 18 calls → 5, −24% tokens at the default budget, −38% at 1,200.
- Semantic search (when on): candidates from the per-workspace cache in a median 10.7 ms (1,000 sections, 2,667
  chunks × 768 dims); indexer overhead 25.6 ms per request of 32 chunks.
- Numbers and methods: [docs/PERFORMANCE.md](docs/PERFORMANCE.md).

### Security
- Semantic candidates pass the same permission boundary as find_context (member workspaces, connection range, guest
  scope, agent blocks, two-step requirement), checked again in the request; guests get none (docs/adr/1743-*). The
  embedding API key is never logged or shown; a redirecting endpoint is refused.
- With semantic search on, the server sends chunk text (page title, heading path, chunk text) to the configured
  endpoint. With a hosted provider that is a third party; docs/OPERATIONS.md says so next to the variables.

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
