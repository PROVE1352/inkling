# Changelog

All notable changes to Inkling. Versions follow [Semantic Versioning](https://semver.org/); while the
version is `0.x`, minor releases may change APIs, MCP tools and the database schema (migrations run
automatically on boot). Design decisions are in [`docs/adr/`](docs/adr/README.md); open problems in
[`docs/KNOWN-ISSUES.md`](docs/KNOWN-ISSUES.md).

## [Unreleased]

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
