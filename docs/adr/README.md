# Architecture Decision Records

Each file records one decision: the context, what was decided and why, and usually the alternatives that were rejected. A `Status` line (Accepted, Rejected or Superseded) and a date sit under the title.
Files are numbered `NNNN-short-title.md`; the first two digits group them by area, with sub-ranges inside 07xx and 08xx, and numbers are never reused. A superseded ADR stays in place and names its successor.

## 01xx Accounts & authentication

| ADR | Title | Status |
|---|---|---|
| [0100](0100-one-time-reset-codes-atomic-consume.md) | One-time password reset codes, hashed and consumed atomically | Accepted |
| [0101](0101-signup-key-as-recovery-only-when-single-use.md) | A signup key works as a recovery code only if it was single-use | Accepted |
| [0102](0102-reset-request-queue-no-account-enumeration.md) | Password reset request queue without account enumeration | Accepted |
| [0103](0103-brute-force-guard-ip-ban-and-account-backoff.md) | Brute-force guard: escalating IP bans, account backoff (no lockout), trusted-proxy IPs, IPv6 /64 | Accepted |
| [0104](0104-force-delete-user-fk-handling.md) | Force-deleting a user: rely on FK SET NULL, guard the last admin | Accepted |
| [0105](0105-generic-delegated-authentication.md) | Generalize delegated login (external auth server) for the public codebase | Accepted |
| [0106](0106-first-user-admin-bootstrap.md) | First-user admin bootstrap | Accepted |
| [0107](0107-nodemailer-for-smtp.md) | nodemailer for outbound mail, disabled unless SMTP is configured | Accepted |
| [0108](0108-email-verification-not-retroactive.md) | Email verification without retroactive lockout | Accepted |

## 02xx Vault sync & query blocks

| ADR | Title | Status |
|---|---|---|
| [0200](0200-vault-sync-protocol.md) | Vault sync protocol: change feed + state-vector revisions + client-side 3-way merge | Accepted (experimental, behind `EXPERIMENTAL_FEATURES=vault-sync`) |
| [0201](0201-vault-sync-markdown-frontmatter-links-attachments.md) | Vault sync markdown: frontmatter, wikilinks and attachments | Accepted (experimental `vault-sync`) |
| [0202](0202-vault-sync-merge-conflicts-deletes.md) | Vault sync: diff3 merge, conflict copies, delete and rename rules | Accepted (experimental `vault-sync`) |
| [0203](0203-query-language-parser-and-sql-compilation.md) | Query blocks: hand-written parser, parameterized SQL, no new indexes | Accepted |
| [0204](0204-query-block-is-a-dataview-code-block.md) | The Query block is a `dataview` code block with portal-rendered results | Accepted |

## 03xx Databases, calendar & export

| ADR | Title | Status |
|---|---|---|
| [0300](0300-relation-values-in-row-props.md) | Relation values live in row props (no junction table); two-way links mirrored in SQL | Accepted |
| [0301](0301-rollups-computed-per-request-depth-one.md) | Rollups are computed per request, set-wise, and may not aggregate rollups/relations | Accepted |
| [0302](0302-own-list-virtualization.md) | Own fixed-height list windowing for table, gallery and timeline | Accepted |
| [0303](0303-ical-subscription-token.md) | iCal subscription: per-user secret URL, token stored as SHA-256 | Accepted |
| [0304](0304-ical-feed-format.md) | iCal feed format: all-day VEVENTs, date-independent UIDs, octet folding | Accepted |
| [0305](0305-spreadsheet-import-export-in-browser.md) | Spreadsheet import/export in the browser; exceljs only via dynamic import; batch row APIs | Accepted |
| [0306](0306-sheets-read-sync.md) | Google Sheets read sync (experimental): published-CSV pull, key upsert, claim-based locking | Accepted (experimental, flag `sheets-sync`) |
| [0307](0307-pdf-export-print-css.md) | "Export as PDF" = print-only CSS + window.print() | Accepted |
| [0308](0308-app-pdf-export-reaches-the-editor-node-views.md) | The app's "Export as PDF" reaches the editor's node views | Accepted |

## 04xx Plugins & feature flags

| ADR | Title | Status |
|---|---|---|
| [0400](0400-plugin-isolation-sandboxed-opaque-origin-iframe.md) | Plugin isolation: sandboxed opaque-origin iframe + strict CSP + MessagePort | Accepted (experimental `plugins`) |
| [0401](0401-plugin-install-admin-only-hash-pinned-approval.md) | Plugin installation: operator-only, approval pinned to a content hash | Accepted (experimental `plugins`) |
| [0402](0402-plugin-permissions-parent-proxy-and-server-recheck.md) | Plugin permissions: parent proxies with the user's session; server re-checks | Accepted (experimental `plugins`) |
| [0403](0403-plugin-blocks-as-placeholder-blocks.md) | Plugin blocks are stored as generic placeholder blocks | Accepted (experimental `plugins`) |
| [0404](0404-plugin-storage-server-kv-with-quotas.md) | Plugin storage: server-side KV per plugin and user, with quotas | Accepted (experimental `plugins`) |
| [0405](0405-experimental-feature-flags.md) | Experimental feature flags via EXPERIMENTAL_FEATURES | Accepted |

## 05xx Outbound fetch, embeds & webhooks

| ADR | Title | Status |
|---|---|---|
| [0500](0500-safe-fetch-ssrf-guard.md) | safeFetch: one SSRF-guarded entry point for server-side fetches of user URLs | Accepted |
| [0501](0501-embed-providers-and-frame-src.md) | Link embeds: client-side provider table, constructed iframe URLs, frame-src-only CSP | Accepted |
| [0502](0502-link-preview-cache-and-thumbnails.md) | Link preview cards: bounded head scan, in-memory LRU, hotlinked thumbnails | Accepted |
| [0503](0503-share-page-unfurl-meta.md) | Server-injected Open Graph meta for public share links | Accepted |
| [0504](0504-workspace-webhooks.md) | Workspace Slack/Discord webhooks: strict URL allowlist, delivery-time privacy gate, in-memory queue | Accepted |

## 06xx Backups

| ADR | Title | Status |
|---|---|---|
| [0600](0600-backup-sidecar-postgres-image-sleep-loop.md) | Backups run in a postgres:16 sidecar with a sleep loop, not in the app or cron | Accepted |
| [0601](0601-backup-set-format-snapshot-consistency.md) | Backup set = dump + data archive + manifest, one exported snapshot, DB before files | Accepted |
| [0602](0602-gfs-retention-local-and-remote.md) | GFS retention, applied to local and remote copies independently | Accepted |
| [0603](0603-backup-encryption-openssl-pbkdf2.md) | Optional encryption with openssl enc AES-256-CBC + PBKDF2 (200k iterations) | Accepted |
| [0604](0604-rclone-binary-via-init-container-overlay.md) | Off-site copies with rclone, binary copied in by an init container in an overlay file | Accepted |
| [0605](0605-app-sidecar-file-protocol-cli-only-restore.md) | App ↔ sidecar via shared files; read-only settings in the UI; restore is CLI only | Accepted |
| [0606](0606-backup-verification-and-restore-test.md) | Verify every set; test-restore weekly into a temporary database | Accepted |
| [0607](0607-backup-failure-alerts.md) | Backup failures become admin notifications (+ mail); webhook hook left as an extension point | Accepted |

## 0700–0749 Web performance

| ADR | Title | Status |
|---|---|---|
| [0700](0700-awareness-users-equality.md) | Push the online-users list to React only when it changes | Accepted |
| [0701](0701-yjs-undo-stack-cap.md) | Cap the Yjs undo history at 500 captures | Accepted |
| [0702](0702-shared-collab-websocket.md) | One collaboration WebSocket per tab | Accepted |
| [0703](0703-webkit-content-visibility-stays-off.md) | Keep `content-visibility` off for WebKit (alternatives measured and rejected) | Superseded by 0850 (the rule was removed in every engine: it caused lost keystrokes in Chromium) |
| [0704](0704-route-and-feature-code-splitting.md) | Route- and feature-level code splitting | Accepted |
| [0705](0705-right-panel-incremental-outline.md) | Right panel outline from the ProseMirror doc with a per-block cache | Accepted |
| [0706](0706-service-worker-update-and-precache.md) | Service worker: prompt-to-update, trimmed precache, full server-route denylist | Accepted |
| [0707](0707-polling-conditional-get.md) | Conditional GET for polled queries, keyed by the cached object | Accepted |
| [0708](0708-page-tree-row-subscriptions.md) | Sidebar tree: memoized rows with per-row subscriptions | Accepted |
| [0709](0709-board-incremental-columns.md) | Board columns render incrementally; windowed table cells get a full-value tooltip | Accepted |
| [0710](0710-graph-engine-soa-rejected.md) | Graph view: keep d3-force object nodes (SoA rewrite rejected after measuring) | Rejected |

## 0750–0799 Server performance

| ADR | Title | Status |
|---|---|---|
| [0750](0750-collab-store-path-db-side-snapshot-debounced-diffed-indexing.md) | Collab store path: DB-side auto snapshot, serialised stores, debounced + diffed derived indexes | Accepted |
| [0751](0751-stream-large-bodies-to-disk-and-copy-in-postgres.md) | Large bodies: stream to disk, copy inside Postgres, spill exports | Accepted |
| [0752](0752-http-caching-policy-and-conditional-gets.md) | HTTP caching: immutable assets, revalidated shell, private API, version-validated ETags | Accepted |
| [0753](0753-public-share-render-cache.md) | Revision-keyed render cache for public share pages | Accepted |
| [0754](0754-revoke-live-collab-connections-on-permission-change.md) | Close live collaboration connections when permissions change | Accepted |
| [0755](0755-search-indexes-planner-costs-and-hot-updates.md) | Search plans, indexes declared in the schema, HOT-friendly fillfactor | Accepted |
| [0756](0756-importer-title-resolver-visibility.md) | Wiki-link title resolution respects page visibility | Accepted |
| [0757](0757-concurrency-hardening-periodic-jobs-and-snapshots.md) | Concurrency: periodic-job re-entry, sheet-sync claim release, snapshot sources | Accepted |
| [0758](0758-postgres-and-node-runtime-settings.md) | Postgres and Node runtime settings in compose | Accepted |
| [0759](0759-hardware-cache-hot-loops-measured-and-rust-notes.md) | Hot-loop / memory-hierarchy work: measured, mostly rejected; notes for a Rust port | Accepted |

## 0800–0849 Server hardening

| ADR | Title | Status |
|---|---|---|
| [0800](0800-page-tree-lock-and-depth-cap.md) | Page tree: workspace tree lock, one ancestor walk, depth cap 64 | Accepted |
| [0801](0801-concurrency-principles.md) | Concurrency principles | Accepted |
| [0802](0802-public-folder-placement-owner-only.md) | Publishing into a public folder is owner-only | Accepted |
| [0803](0803-forced-deletion-private-pages-visible-to-nobody.md) | Forced account deletion: private pages visible to nobody, sole owner blocks | Accepted (supersedes the P-server "transfer to acting admin" variant) |
| [0804](0804-workspace-member-lock-and-invite-code.md) | Workspace membership changes under a member lock; invite code is an owner secret | Accepted |
| [0805](0805-process-lifecycle-crash-and-shutdown.md) | Process lifecycle: no crash on rejected promises, bounded graceful shutdown | Accepted |
| [0806](0806-configured-public-origin-only.md) | External origin from configuration only | Accepted |
| [0807](0807-postgres-timeouts-per-connection.md) | Postgres timeouts per pooled connection, not per role | Accepted |
| [0808](0808-auth-races-login-reset-ical.md) | Login vs password reset, reset-code issue, iCal token | Accepted |
| [0809](0809-lost-updates-props-and-collection-locks.md) | Lost updates: page properties, row props, collection schema lock order | Accepted |
| [0810](0810-import-limits-and-zip-metering.md) | Import limits and real-byte zip metering | Accepted |
| [0811](0811-authorization-leak-fixes.md) | Authorization leak fixes (C-L11, C-L12) | Accepted |
| [0812](0812-operational-defaults.md) | Operational defaults and small hardening | Accepted |
| [0813](0813-forced-deletion-removes-personal-workspaces.md) | Forced deletion removes the user's personal workspaces | Accepted |
| [0814](0814-spa-content-security-policy.md) | Full Content-Security-Policy for the SPA shell | Accepted |
| [0815](0815-ink-optimistic-concurrency.md) | Ink layer: optimistic concurrency with 412 | Accepted |

## 0850–0879 Web hardening

| ADR | Title | Status |
|---|---|---|
| [0850](0850-editor-blocks-without-content-visibility.md) | Editor blocks no longer use `content-visibility: auto` (typed text was lost after Enter) | Accepted (supersedes the Chromium part of 0703) |
| [0851](0851-safe-next-parses-urls.md) | `?next=` redirects are validated by URL parsing, not by prefix | Accepted |
| [0852](0852-public-share-html-sanitizer.md) | Client-side allowlist sanitizer for public share HTML; app shell ready for `script-src 'self'` | Accepted |
| [0853](0853-react-query-optimistic-races.md) | Optimistic cache writes: cancel first, roll back per field, refetch when the last one settles | Accepted |
| [0854](0854-ink-single-inflight-save.md) | Ink layer keeps one save in flight and coalesces to the latest strokes | Accepted (client part of A-M14) |

## 0880–0899 Tests, CI & dependencies

| ADR | Title | Status |
|---|---|---|
| [0880](0880-test-strategy-node-test-tsx.md) | Tests run on node:test through tsx, discovered by a repo script | Accepted |
| [0881](0881-ci-composition.md) | CI: three jobs — check, database, Docker image | Accepted |
| [0882](0882-dependency-policy.md) | Dependency policy: pinned editor stack, frozen lockfile, Dependabot with exclusions | Accepted |

## 09xx Internationalization

| ADR | Title | Status |
|---|---|---|
| [0900](0900-i18n-architecture.md) | UI localization without a library: flat per-area dictionaries and a module-level `t()` | Accepted |
| [0901](0901-locale-resolution-and-storage.md) | Locale resolution order and where the choice is stored | Accepted |
| [0902](0902-error-codes-and-client-translation.md) | API errors: English messages, translated by code on the client | Accepted |
| [0903](0903-server-locale-mail-templates-tz.md) | Server-generated content: recipient/creator locale, DEFAULT_LOCALE and TZ | Accepted |
| [0904](0904-legacy-titles-and-daily-notes.md) | Localized names for app-created pages, and daily-note titles stay ISO dates | Accepted |

## 0910–0919 Workspace lifecycle

| ADR | Title | Status |
|---|---|---|
| [0910](0910-workspace-soft-delete.md) | Workspace deletion: owner-only soft delete, 30-day restore, purge by housekeeping | Accepted |
| [0911](0911-workspace-leave-and-ownership-transfer.md) | Leaving and ownership transfer: atomic transfer endpoint, sole owner is stopped in the UI | Accepted |

## 092x Templates

| ADR | Title | Status |
|---|---|---|
| [0920](0920-template-model.md) | Template model: one tree format for documents and structures; legacy paths removed | Accepted |
| [0921](0921-structure-templates-atomic-instantiation.md) | Structure templates: atomic instantiation, id remapping and caps | Accepted |
| [0922](0922-template-variables.md) | Template variables: server-side at instantiation, inside text runs only | Accepted |
| [0923](0923-templater-compatibility-no-code.md) | Obsidian Templater compatibility: a rewrite of three tags, no code execution | Accepted |
| [0924](0924-template-file-format.md) | Template files: Markdown with flat frontmatter, zip with a manifest for structures | Accepted |
| [0925](0925-template-gallery-visibility-mcp.md) | Template gallery, visibility rules and MCP tools | Accepted |

## 0926–0939 MCP for agents

| ADR | Title | Status |
|---|---|---|
| [0926](0926-section-index-and-stable-anchors.md) | Section index (`page_chunks`) with heading-path anchors | Accepted |
| [0927](0927-find-context-ranking-and-budget-packing.md) | find_context: index probes, coverage ranking, top-k heap and fractional-knapsack packing | Accepted |
| [0928](0928-partial-and-batch-reads-compact-output.md) | Partial reads (outline/section), batch reads, compact list/search output | Accepted |
| [0929](0929-agent-facing-instructions-errors-and-repo-guides.md) | Agent-facing text: server instructions, tool descriptions, errors, AGENTS.md and llms.txt | Accepted |
| [0930](0930-patch-section-yjs-splice-with-base-version.md) | patch_section: splice one section in the live Yjs document, guarded by a section version | Superseded in part by 0940 |
| [0932](0932-change-feed-cursor.md) | Change feed for agents: cursor, merge window, permissions, retention | Accepted |
| [0933](0933-change-feed-diff-algorithm.md) | Change feed diff: Myers line diff with sentence units and hard caps | Accepted |
| [0934](0934-collection-query-tools-for-agents.md) | Collection query and row-update tools for agents | Accepted |
| [0935](0935-oauth-read-write-scopes.md) | Read-only MCP tokens: OAuth `read` / `write` scopes | Accepted |
| [0936](0936-via-agent-provenance.md) | "via agent" provenance for MCP writes | Accepted |
| [0937](0937-prompt-cache-friendly-deterministic-tool-output.md) | Prompt-cache-friendly, deterministic MCP output | Accepted |
| [0940](0940-patch-section-minimal-yjs-edit.md) | patch_section: minimal Yjs edit (block alignment + character diff) instead of replacing the section; never read the live doc through the server schema | Accepted |

## 0945–0959 Workspace settings

| ADR | Title | Status |
|---|---|---|
| [0945](0945-workspace-admin-role-and-settings-screen.md) | Workspace admin role and one workspace settings screen | Accepted |
| [0946](0946-workspace-audit-log.md) | Workspace audit log: same-transaction, append-only, no IP | Accepted |
| [0947](0947-per-workspace-agent-blocks.md) | Per-workspace agent blocks, enforced per request | Accepted |
| [0948](0948-member-add-policy-and-invite-toggle.md) | Member-add policy and an invite link switch (closes C-M3) | Accepted |
| [0949](0949-public-sharing-switch-and-link-list.md) | "No public links" switch and public link management | Accepted |
| [0950](0950-export-policy-and-trash-retention.md) | Export policy and per-workspace trash retention | Accepted |
| [0951](0951-document-owner-and-review.md) | Document owner and last review | Accepted |
| [0952](0952-review-reminders-as-webhook-digest.md) | Review reminders as a daily webhook digest, not inbox notifications | Accepted |
| [0953](0953-review-priority-freshness-model.md) | Review priority: read counters, a drift model, living documents, archive candidates | Accepted |

## 096x Import

| ADR | Title | Status |
|---|---|---|
| [0960](0960-notion-export-import.md) | Notion export import: Markdown & CSV zip into pages, collections and attachments | Accepted |
| [0961](0961-env-configurable-import-limits.md) | Import caps from the environment | Accepted |

## 0970–0989 Edit lock, agent instructions and the trust boundary

| ADR | Title | Status |
|---|---|---|
| [0970](0970-subtree-edit-lock.md) | Subtree edit lock, enforced at every write path | Accepted |
| [0971](0971-lock-evaluation-order-people-and-agents.md) | Lock evaluation order: deny then allow, nearer wins, people and agents apart | Accepted |
| [0975](0975-agent-instruction-pages.md) | Agent instruction pages: always, match, manual | Accepted |
| [0976](0976-data-instruction-boundary-in-mcp-output.md) | Data / instruction boundary in MCP output | Accepted |
| [0977](0977-injection-signals-and-taint-record.md) | Injection-like content signals and a taint record (signal, never a block) | Accepted |
| [0978](0978-reserved-oauth-client-names.md) | Reserved OAuth client names | Accepted (member-name part superseded by 1007) |

## 1000–1019 Notifications, agent inbox and activity

| ADR | Title | Status |
|---|---|---|
| [1000](1000-notification-engine.md) | Notification engine: one queue, one table, rules in one place | Accepted |
| [1001](1001-subtree-subscriptions-and-levels.md) | Subtree subscriptions: all, mentions, nothing, mute | Accepted |
| [1002](1002-body-mentions-and-agent-attribution.md) | Body @mentions: read from Yjs, attributed to a person or an agent | Accepted |
| [1003](1003-agent-inbox-and-ack.md) | Agent inbox: the person's direct items, a cursor and an explicit ack | Accepted |
| [1004](1004-notification-mail-digests-and-webhooks.md) | Delivery: instant mail, daily/weekly digest, AI summaries, webhooks | Accepted |
| [1005](1005-activity-screen-diffs-and-created-via.md) | Activity screen, version diffs and created-via provenance | Accepted |
| [1006](1006-comment-tools-for-agents.md) | Comment thread tools for agents | Accepted |
| [1007](1007-member-name-clash-per-workspace.md) | Client names vs member names: exact, per workspace, warning for common apps | Accepted |

## 1020–1039 Personal preferences

| ADR | Title | Status |
|---|---|---|
| [1020](1020-per-user-sidebar-menu-customization.md) | Sidebar menus: per-user order and visibility, stored on the account | Accepted |

## 1040–1049 Large pages

| ADR | Title | Status |
|---|---|---|
| [1040](1040-index-the-whole-page.md) | The section index covers the whole page; page_texts keeps head + tail | Accepted |
| [1041](1041-outline-and-section-reads-from-the-index.md) | Outline and section reads answer from the section index when it is provably current | Accepted |
| [1042](1042-write-path-on-large-pages.md) | Write paths on large pages: one connection, region-only checks, unchanged stores skipped | Accepted |
| [1043](1043-large-page-hint-for-agents.md) | A one-line "large page" hint in agent tool output | Accepted |

## 1050–1059 Release and upgrade

| ADR | Title | Status |
|---|---|---|
| [1050](1050-prebuilt-multi-arch-images-on-ghcr.md) | Prebuilt multi-arch release images on GHCR, built on native runners | Accepted |
| [1051](1051-compose-image-by-default-source-build-overlay.md) | compose.yaml runs the published image; source builds stay one flag or one overlay away | Accepted |
| [1052](1052-upgrade-path-ci.md) | Upgrade-path CI: every earlier release's image fills a database, the new image migrates it | Accepted |

## 1060–1069 Authentication

| ADR | Title | Status |
|---|---|---|
| [1060](1060-hashed-session-tokens.md) | Session tokens stored as SHA-256, converted in place at boot | Accepted |
| [1061](1061-totp-two-step-verification.md) | Two-step verification with TOTP, secrets encrypted under APP_SECRET_KEY | Accepted |
| [1062](1062-origin-check-for-cookie-requests.md) | Cross-site requests refused by Origin; the collab upgrade too | Accepted |

## 1070–1079 Access checks

| ADR | Title | Status |
|---|---|---|
| [1070](1070-mcp-agent-context-in-process.md) | MCP agent context in process, not a second REST call | Accepted |
| [1071](1071-workspace-access-version-and-write-gate.md) | Workspace access version, version-keyed caches and the write gate | Accepted |

## 1080–1089 Background work and outbox

| ADR | Title | Status |
|---|---|---|
| [1080](1080-change-log-through-a-transactional-outbox.md) | Change log through a transactional outbox: one writer per database, no request-wide queue | Accepted |
| [1081](1081-notifications-and-webhooks-through-the-outbox.md) | Notifications and webhooks through the outbox: retries, idempotency, leases | Accepted |

## 1090–1099 Page chrome

| ADR | Title | Status |
|---|---|---|
| [1090](1090-quieter-page-chrome-and-line-width-setting.md) | Quieter page chrome: ⋯ menu, line-width slider, title-heading dedupe on import | Accepted |

## 1100–1109 Large pages, part 2

| ADR | Title | Status |
|---|---|---|
| [1100](1100-incremental-version-history.md) | Incremental version history: snapshot rows as Yjs diffs in short chains | Accepted |
| [1101](1101-yjs-v2-encoding-for-stored-states.md) | Yjs V2 encoding for stored states, read in either format, converted on the next store | Accepted |
| [1102](1102-one-encode-per-store-one-decode-per-index-pass.md) | One encode per store, one decode per index pass | Accepted |
| [1103](1103-large-page-notice-for-people.md) | A "large page" notice for people and a list for workspace managers | Accepted |
| [1104](1104-editor-viewport-rendering-not-adopted.md) | Rendering only the visible part of the editor: investigated, not adopted | Rejected |

## 1110–1119 Secrets at rest and workspace security

| ADR | Title | Status |
|---|---|---|
| [1110](1110-hashed-link-secrets-with-sealed-copies.md) | Share tokens, invite codes and signup keys stored as SHA-256, with a sealed copy for "copy link" | Accepted |
| [1111](1111-webhook-and-sheet-urls-sealed-at-rest.md) | Webhook and sheet-sync URLs sealed with `APP_SECRET_KEY`; plaintext with a warning without it | Accepted |
| [1112](1112-workspace-requires-two-step-verification.md) | A workspace can require two-step verification | Accepted |

## 1120–1129 Algorithms

| ADR | Title | Status |
|---|---|---|
| [1120](1120-union-find-module.md) | One union-find module, and the rule for when it fits | Accepted |
| [1121](1121-former-titles-for-wikilinks-after-rename.md) | Former page titles: `[[old name]]` still finds a renamed page | Accepted |
| [1122](1122-import-deduplication.md) | Import de-duplication: identical attachments once, one Notion page per Notion id | Accepted |
| [1123](1123-link-islands-and-unlinked-pages.md) | Link islands and unlinked pages | Accepted |
| [1124](1124-cache-replacement-lru-vs-sieve-s3fifo.md) | Cache replacement: LRU kept (SIEVE and S3-FIFO measured, OPT as the bound) | Accepted |

## 1130–1139 Settings

| ADR | Title | Status |
|---|---|---|
| [1130](1130-settings-sections-and-flat-rows.md) | Personal settings: section list, flat rows, "This device" tags | Accepted |

## 1140–1149 Large pages, part 3

| ADR | Title | Status |
|---|---|---|
| [1140](1140-split-a-page-at-its-headings.md) | Split a page into subpages at its headings, on the live document | Accepted |
| [1141](1141-logs-that-split-themselves-and-a-one-time-large-page-notice.md) | Logs that split themselves, and a one-time "large page" notice to the owner | Accepted |
| [1142](1142-links-into-a-split-page.md) | Links into a split page: keep the page, move anchors with their blocks, resolve `[[Page#Heading]]` | Accepted |

## 1150–1159 Events and the write gate

| ADR | Title | Status |
|---|---|---|
| [1150](1150-events-in-the-writers-transaction.md) | Events in the writer's transaction, NOTIFY after the commit, batched notification consumer | Accepted |
| [1151](1151-write-gate-on-comments-and-document-edits.md) | Write gate on comments and document edits; fresh role after waiting at the gate | Accepted |

## 1160–1169 OpenID Connect

| ADR | Title | Status |
|---|---|---|
| [1160](1160-openid-connect-sign-in.md) | Sign-in with an OpenID Connect provider: Authorization Code + PKCE, built-ins only | Accepted |
| [1161](1161-oidc-identities-linking-and-account-creation.md) | OIDC identities keyed by (issuer, subject); email linking only when verified and allowed; no signup key | Accepted |
| [1162](1162-oidc-and-two-step-verification.md) | OIDC accounts and two-step verification: the provider's second factor, optionally proven by amr/acr | Accepted |

## 1170–1179 Public links

| ADR | Title | Status |
|---|---|---|
| [1170](1170-public-link-expiry.md) | Public links can expire | Accepted |
| [1171](1171-public-link-passwords.md) | Public links can have a password; unlock cookies per link | Accepted |
| [1172](1172-workspace-rules-for-new-public-links.md) | Workspace rules for new public links: default expiry, password required | Accepted |

## 1180–1189 Row templates

| ADR | Title | Status |
|---|---|---|
| [1180](1180-row-templates-stored-apart-from-pages.md) | Row templates: a table of their own, never pages | Accepted |
| [1181](1181-one-create-path-for-rows.md) | One create path for rows; template values reuse the template and MCP grammars | Accepted |
| [1182](1182-row-template-editor-on-a-local-document.md) | The row template editor: the page editor on a local Yjs document | Accepted |
| [1183](1183-row-templates-in-copies-and-files.md) | Row templates travel with their database in copies and template files, not in exports | Accepted |
| [1184](1184-row-template-permissions-and-leaks.md) | Row template permissions follow the database; what a template can carry into a row | Accepted |

## 1190–1199 Webhooks

| ADR | Title | Status |
|---|---|---|
| [1190](1190-generic-webhooks-and-signatures.md) | Generic webhooks: signed JSON to any public https endpoint | Accepted |
| [1191](1191-webhook-delivery-records-and-resend.md) | Webhook delivery records, resend, and what of a response is kept | Accepted |
| [1192](1192-generic-webhook-auto-disable.md) | Generic webhooks are disabled after 24 hours of failures, not after five events | Accepted |

## 1200–1209 Connection range and API tokens

| ADR | Title | Status |
|---|---|---|
| [1200](1200-connection-range-workspaces-or-subtree.md) | A connection can be limited to some workspaces or one page's subtree | Accepted |
| [1201](1201-personal-api-tokens-for-rest.md) | Personal API tokens for the REST API | Accepted |
| [1202](1202-range-enforced-at-the-permission-boundary.md) | The range is enforced at the permission boundary, not in the tools | Accepted |
| [1203](1203-inklingctl-api-token-auth.md) | inklingctl signs in with an API token; cli-token.sh stays for sessions | Accepted |
| [1204](1204-browser-only-routes-for-bearer-tokens.md) | One table of routes that bearer tokens may not call | Accepted |

## 1210–1219 Retrieval quality

| ADR | Title | Status |
|---|---|---|
| [1210](1210-find-context-idf-weighted-ranking.md) | find_context ranking: idf-weighted BM25, adjacency of query words, Korean word groups | Accepted (amended by [2401](2401-shorter-form-of-a-korean-compound-in-titles-and-headings.md)–[2403](2403-title-words-count-in-document-frequency.md)) |
| [1211](1211-find-context-per-page-diversification.md) | find_context: at most two sections per page, the second only when it is nearly as good | Accepted |
| [1212](1212-find-context-short-section-locations.md) | find_context: the last heading and a short anchor instead of the whole path | Accepted |
| [1213](1213-retrieval-evaluation-dev-test-split.md) | Retrieval evaluation: dev/test split, rank metrics, the field failure as data | Accepted |
| [1214](1214-hybrid-semantic-search-design-memo.md) | Semantic (hybrid) retrieval for find_context: design memo, not built | Proposed |

## 1220–1229 Reading view

| ADR | Title | Status |
|---|---|---|
| [1220](1220-mini-outline-in-the-margin.md) | Outline in the right margin (mini table of contents) | Accepted |
| [1221](1221-heading-folds-per-device.md) | Folding at headings, per device, without touching the document | Accepted |
| [1222](1222-block-styling-next-to-notion.md) | Callout, quote, divider, code and toggle styling next to Notion; quieter page open | Accepted |

## 1230–1239 Admin status

| ADR | Title | Status |
|---|---|---|
| [1230](1230-admin-status-summary.md) | Server status summary for admins | Accepted |
| [1231](1231-restart-count-and-error-counter.md) | Restart count from a boot log, error count from the logger | Accepted |
| [1232](1232-release-check-lists-releases-for-security-fixes.md) | Release check lists recent releases to see security fixes (amends 0994) | Accepted |
| [1233](1233-admin-status-banner-once-a-day.md) | Admin status banner: one line, the same problem once a day | Accepted |

## 1240–1249 Heavy jobs and test reliability

| ADR | Title | Status |
|---|---|---|
| [1240](1240-heavy-job-concurrency-cap.md) | Heavy jobs share a small concurrency cap with a fair queue | Accepted |
| [1241](1241-zip-export-teardown-on-abort.md) | A zip export closes its entry streams when the download is aborted | Accepted |
| [1242](1242-two-step-deadline-from-the-database-clock.md) | The two-step verification deadline is set from the database clock | Accepted |
| [1243](1243-intermittent-db-test-failures.md) | Intermittent `[db]` test failures: one clock bug, the rest shared-database assumptions | Accepted |

## 1250–1259 Guests and page levels

| ADR | Title | Status |
|---|---|---|
| [1250](1250-guests-are-people-with-page-rows.md) | Guests are people with page rows, not workspace members | Accepted |
| [1251](1251-one-level-per-person-and-page-tree.md) | One level per person and page tree; members too; separate from the edit lock | Accepted |
| [1252](1252-guest-visibility-at-the-permission-boundary.md) | Guest visibility at the permission boundary, opt-in routes, leak checklist | Accepted |
| [1253](1253-guest-tokens-and-two-step-verification.md) | Guests and tokens, guests and the workspace 2FA requirement | Accepted |

## 1270–1279 Editor input

| ADR | Title | Status |
|---|---|---|
| [1270](1270-caret-after-slash-menu-insert.md) | The caret lands in a block inserted from the slash menu | Accepted |
| [1271](1271-heading-folds-keyboard-touch-marker.md) | Heading folds: keyboard shortcut, touch screens, "…" marker | Accepted |

## 1280–1289 Look and motion

| ADR | Title | Status |
|---|---|---|
| [1280](1280-soft-corner-scale-and-shadows.md) | Soft corner scale, softer shadows, drawn checkboxes | Accepted |
| [1281](1281-motion-tokens-enter-and-exit.md) | Motion: one easing set, enter and exit animations, tree reveal | Accepted |

## 1300–1309 Workspace boundaries

| ADR | Title | Status |
|---|---|---|
| [1300](1300-two-step-requirement-on-cross-workspace-reads-and-mail.md) | The two-step requirement also covers cross-workspace reads and notification mail | Accepted |
| [1301](1301-outsiders-get-not-found.md) | Someone outside a workspace gets "not found" for its ids | Accepted |
| [1302](1302-public-files-stay-inside-what-a-link-shares.md) | Public links serve only files of pages inside what they share | Accepted |

## 1320–1329 Collection views and query blocks

| ADR | Title | Status |
|---|---|---|
| [1320](1320-query-block-person-and-relation-display.md) | Query blocks show people by name and relations as page links | Accepted (WHERE / SORT on stored values superseded by 1352) |
| [1321](1321-wide-collection-views-reach-the-pane-edges.md) | Wide collection views reach the edges of the page pane | Accepted |
| [1322](1322-collection-table-sticky-header-and-column-minimums.md) | Collection table: header sticks to the page, columns sized from their minimums | Accepted |

## 1340–1349 Pen mode

| ADR | Title | Status |
|---|---|---|
| [1340](1340-ink-layer-one-per-page-no-blind-save.md) | Ink layer: one layer per page, no save before the ink is loaded, no blind wipe | Accepted |

## 1350–1359 Widths, query comparisons and relation fields

| ADR | Title | Status |
|---|---|---|
| [1350](1350-resizable-sidebar-width-per-device.md) | The sidebar is resized on its edge, and the width is kept per device | Accepted |
| [1351](1351-collection-table-column-widths-in-the-view.md) | Collection table: column widths dragged in the header, saved on the view | Accepted |
| [1352](1352-query-block-compares-people-by-name-and-relations-by-title.md) | Query blocks compare people by name and relations by title | Accepted |
| [1353](1353-unchanged-relation-fields-with-a-hidden-target.md) | Unchanged relation fields pass when their target is hidden from the editor | Accepted |
| [1354](1354-collection-toolbar-wraps-on-phones.md) | Collection toolbar wraps under the view tabs on narrow screens | Accepted |

## 1400–1409 Keyboard shortcuts

| ADR | Title | Status |
|---|---|---|
| [1400](1400-shortcut-registry.md) | One registry for keyboard shortcuts and commands | Accepted |
| [1401](1401-familiar-keys-and-browser-conflicts.md) | Familiar keys from Notion and Obsidian, checked against browser and OS keys | Accepted |
| [1402](1402-command-palette-from-the-registry.md) | Command palette lists the registry, searches both languages and Korean initials | Accepted |
| [1403](1403-help-window-and-menu-keys-from-the-registry.md) | The ? window and menu items read their keys from the registry | Accepted |
| [1404](1404-user-shortcut-keys-per-device.md) | Users change shortcut keys in Settings; the keys are kept per device | Accepted |
| [1405](1405-capturing-and-checking-a-new-key.md) | Capturing a new key and checking it before it is saved | Accepted |
| [1406](1406-editor-keys-read-at-key-press.md) | Editor commands read their keys at each key press; the editor's own keys stay fixed | Accepted |
| [1407](1407-database-table-keyboard-grid.md) | The database table is a keyboard grid | Accepted |

## 1410–1419 Later list and followed threads

| ADR | Title | Status |
|---|---|---|
| [1410](1410-later-list-saved-items.md) | Later list: saved pages, threads and notifications, titles joined at read time | Accepted |
| [1411](1411-later-reminders-through-the-outbox.md) | Later reminders: a sweep that queues notification events through the outbox | Accepted |
| [1412](1412-followed-threads-and-the-inbox.md) | Followed comment threads, the Threads view and the reply notification | Accepted |
| [1413](1413-later-list-for-agents-read-only.md) | Agents read the Later list; they do not write it, and threads get no tool | Accepted |

## 1500–1509 Agent Markdown notation and renamed sections

| ADR | Title | Status |
|---|---|---|
| [1500](1500-agent-markdown-notation-for-custom-nodes.md) | Agent Markdown notation for callouts, embeds, files and mentions; update_page as a minimal edit | Accepted |
| [1501](1501-old-section-anchors-follow-heading-renames.md) | Old section anchors follow heading renames (from the change log) | Accepted |

## 1510–1519 Handwriting, versions, trash and files for agents

| ADR | Title | Status |
|---|---|---|
| [1510](1510-agents-read-handwriting-off-by-default.md) | Agents read handwriting only where the workspace allows it (off by default) | Accepted |
| [1511](1511-server-side-ink-rendering-without-dependencies.md) | read_ink renders strokes to PNG on the server, with the web layer's geometry and no dependency | Accepted |
| [1512](1512-ink-marker-in-page-headers.md) | Page headers mark handwriting with one line, never its content, and only where agents may read it | Accepted |
| [1513](1513-version-and-trash-tools-for-agents.md) | Version history and trash tools for agents; version restore under the write gate | Accepted |
| [1514](1514-read-file-attachments-for-agents.md) | read_file: images as images, text as untrusted text, everything else as metadata | Accepted |

## 1520–1529 catch_up, collection structure and MCP output

| ADR | Title | Status |
|---|---|---|
| [1520](1520-catch-up-for-agents.md) | catch_up: one call for "what happened while I was away" | Accepted |
| [1521](1521-catch-up-importance-packing.md) | catch_up packs by importance with find_context's knapsack and a per-group rule | Accepted |
| [1522](1522-catch-up-marker-without-a-schema-change.md) | The "last catch_up" marker lives in plugin_storage under a reserved id | Superseded by 1537 |
| [1523](1523-collection-structure-tools.md) | Agents create collections and change their properties by name | Accepted |
| [1524](1524-create-row-links-in-one-transaction.md) | create_row writes relation links in the row's transaction | Accepted |
| [1525](1525-json-tool-output-marks-member-text.md) | JSON tool output keeps its shape and marks member-written strings | Accepted |
| [1526](1526-mcp-request-body-before-and-during-parse.md) | POST /mcp: token before body, a value cap before JSON.parse | Accepted |

## 1530–1539 Suggested edits and section claims

| ADR | Title | Status |
|---|---|---|
| [1530](1530-suggestions-are-section-rows-until-a-person-decides.md) | Suggestions are section rows until a person decides | Accepted |
| [1531](1531-suggest-is-a-flag-next-to-mode.md) | `suggest` is a flag next to `mode`, not another mode | Accepted |
| [1532](1532-agents-suggestions-only-lock-level.md) | "Agents: suggestions only" lock level | Accepted |
| [1533](1533-accept-applies-on-the-current-section-after-a-warning.md) | Accepting applies the suggestion to the section as it is now, after a warning | Accepted |
| [1534](1534-approval-request-and-result-notifications.md) | approval_request and approval_result come from suggestions | Accepted |
| [1535](1535-section-claims-in-a-table.md) | Section claims live in a table | Accepted |
| [1536](1536-writes-on-claimed-sections-are-refused.md) | Other agents' writes on a claimed section are refused, people's are not | Accepted |
| [1537](1537-catch-up-markers-table.md) | catch_up markers move to their own table | Accepted (supersedes 1522) |
| [1538](1538-patch-sections-makes-suggestions-together.md) | patch_sections makes suggestions too, all together | Accepted |
| [1539](1539-embed-viewer-schema-from-the-shared-block-list.md) | Embed viewer schema built from the editor's one spec list | Accepted |

## 1540–1549 Saving tokens and the agent edit policy

| ADR | Title | Status |
|---|---|---|
| [1540](1540-known-versions-and-unchanged-reads.md) | `known` versions: unchanged pages come back as one line | Accepted |
| [1541](1541-compact-lists-and-short-page-ids.md) | Compact lists: folded numbered siblings and 8-character page ids | Accepted |
| [1542](1542-patch-sections-all-or-nothing.md) | patch_sections: several section edits, all or nothing | Accepted |
| [1543](1543-prompt-cache-audit-of-tool-lists-and-outputs.md) | Prompt-cache audit: tool list, instructions and outputs stay byte-stable | Accepted |
| [1544](1544-agent-edit-policy-levels.md) | Agent edit policy: direct, accept by rules, review everything | Accepted |
| [1545](1545-auto-accept-rules.md) | Auto-accept rules | Accepted |

## 1550–1559 Several agents at once

| ADR | Title | Status |
|---|---|---|
| [1550](1550-find-context-result-cache.md) | find_context result cache: per person, keyed by every permission input and index marker | Accepted |
| [1551](1551-changes-since-long-poll.md) | changes_since long-poll: wake-ups from the change log consumer, no new NOTIFY | Accepted |
| [1552](1552-usage-per-connection-in-memory.md) | Usage per connection: counted in memory since start, numbers only | Accepted |

## 1600–1609 Charts

| ADR | Title | Status |
|---|---|---|
| [1600](1600-chart-blocks-store-a-config-not-data.md) | Chart blocks store what to draw, never the data | Accepted |
| [1601](1601-ztd-charts-behind-one-adapter.md) | ztd-charts for drawing, behind one adapter, loaded on first sight | Accepted |
| [1602](1602-chart-aggregate-endpoint.md) | One aggregate endpoint on the collection query's access path | Accepted |
| [1603](1603-chart-view-type-in-the-view-config.md) | A "chart" collection view, configured in the view config | Accepted |
| [1604](1604-chart-token-carries-its-config.md) | The chart token carries its config; the data line is a comment | Accepted |
| [1605](1605-charts-in-exports-and-public-pages.md) | Charts in exports and on public pages are tables, inside what is shared | Accepted; amended by 2440 |
| [1606](1606-create-chart-and-create-view-tools.md) | create_chart and create_view write through the existing routes | Accepted |

## 1620–1629 Partial accept and reverting agent edits

| ADR | Title | Status |
|---|---|---|
| [1620](1620-revert-on-the-change-log-with-block-sources.md) | Reverting a logged change: 3-way on the change log's text, blocks from the page and its versions | Accepted |
| [1621](1621-suggestion-hunks-with-a-stored-base.md) | Suggestions are reviewed in hunks, merged 3-way against a stored base | Accepted |
| [1622](1622-accepted-partial-status.md) | `accepted_partial`: a suggestion of which some hunks were applied | Accepted |
| [1623](1623-a-revert-is-a-change-of-the-person.md) | A revert is an ordinary change of the person, linked by an audit event | Accepted |
| [1624](1624-reverting-an-agents-run.md) | Reverting one change or an agent's run: scopes, preview, permissions | Accepted |
| [1625](1625-typing-attributed-per-index-window.md) | Live typing is attributed per index window; server edits log pending typing first (CF-2) | Accepted |
| [1626](1626-one-status-filter-for-suggestion-lists.md) | One status filter for both suggestion lists; withdraw says why | Accepted |

## 1640–1649 Sidebar on short screens and typed tables

| ADR | Title | Status |
|---|---|---|
| [1640](1640-the-page-tree-keeps-its-height-menus-fold.md) | The page tree keeps its height; menus that do not fit fold under "More" | Accepted |
| [1641](1641-four-sidebar-menus-by-default.md) | Four sidebar menus by default; saved choices keep their meaning | Accepted |
| [1642](1642-typing-a-table-pipe-row-size-and-paste.md) | Typing a table: a pipe row and Enter, "/table 3x4", pasted Markdown | Accepted |
| [1643](1643-opening-more-shows-every-folded-menu.md) | Opening "More" shows every folded menu; the page tree gives way | Accepted |

## 1650–1659 Change feed and MCP fixes

| ADR | Title | Status |
|---|---|---|
| [1650](1650-collections-and-rows-in-the-change-feed.md) | Collections, rows and row properties in the change feed | Accepted |
| [1651](1651-many-added-rows-are-one-line.md) | Many rows added to one collection are one line | Accepted |
| [1652](1652-trash-then-restore-leaves-a-line.md) | Trash then restore between two cursors leaves a line | Accepted |
| [1653](1653-catch-up-others-means-identified-people.md) | catch_up "by others" means changes by identified other people | Accepted |
| [1654](1654-claims-on-every-read-page-form.md) | Section claims on every read_page form | Accepted |
| [1655](1655-not-found-hints-name-the-target.md) | Not-found hints name what was not found | Accepted |
| [1656](1656-query-rows-describe-is-data.md) | query_rows describe=true is data | Accepted |

## 1700–1709 Search: Korean partial match and field weights

| ADR | Title | Status |
|---|---|---|
| [1700](1700-korean-partial-match-at-query-time.md) | Korean partial match at query time: split compounds, one-syllable nouns with particles | Accepted (amends the word groups of 1210) |
| [1701](1701-aliases-count-as-title-heading-weight.md) | find_context: page aliases count as the title; heading weight 0.2 → 0.3 | Accepted (amends the weights of 1210) |
| [1702](1702-evaluation-korean-partial-match-questions.md) | Retrieval evaluation: Korean partial-match questions, per-family metrics, 0.14 numbers | Accepted (extends 1213) |

## 1720–1729 find_context with several queries

| ADR | Title | Status |
|---|---|---|
| [1720](1720-find-context-several-queries-merged-by-rrf.md) | find_context queries=[…]: several phrasings merged by RRF under one budget, each section once | Accepted |
| [1721](1721-several-queries-share-the-find-context-cache.md) | Several queries share the find_context cache: per-query entries plus a bundle entry | Accepted |
| [1722](1722-extra-ranked-lists-join-the-rrf-merge.md) | Extra ranked lists join the RRF merge (the join point for semantic candidates) | Accepted |
| [1723](1723-semantic-candidates-wired-into-find-context.md) | Semantic candidates wired into find_context: one extra list per query, off path untouched | Accepted |

## 1740–1749 Optional semantic search

| ADR | Title | Status |
|---|---|---|
| [1740](1740-optional-semantic-search-off-by-default.md) | Optional semantic search: an operator's embedding endpoint, off by default | Accepted (role prefixes: [2404](2404-embedding-role-prefixes.md)) |
| [1741](1741-vectors-in-real-arrays-brute-force-cosine.md) | Vectors in `real[]`, brute-force cosine from a per-workspace cache | Accepted |
| [1742](1742-background-indexer-content-addressed-chunks.md) | Background indexer: content-addressed chunk vectors, rate limit and backoff | Accepted |
| [1743](1743-semantic-candidates-at-the-permission-boundary.md) | Semantic candidates pass the same permission boundary as find_context | Accepted |
| [1744](1744-semantic-index-state-in-the-admin-status.md) | Semantic index state in the admin status, never the key | Accepted |
| [1745](1745-testing-semantic-search-with-a-fake-endpoint.md) | Testing semantic search: a local fake endpoint, and "off" proven by counters | Accepted |

## 1800–1809 Slack app per workspace

| ADR | Title | Status |
|---|---|---|
| [1800](1800-slack-app-per-workspace-operator-owned.md) | Slack app per workspace, owned by the operator | Accepted |
| [1801](1801-slack-secrets-sealed-never-returned.md) | Slack token and signing secret: sealed at rest, never returned or logged | Accepted |
| [1802](1802-slack-channel-posts-from-the-notification-engine.md) | Slack channel posts follow the notification engine, shared pages only | Accepted |
| [1803](1803-slack-command-and-account-links.md) | /inkling: ephemeral find_context for linked members only | Accepted |
| [1804](1804-slack-request-signatures-and-replays.md) | Slack requests: v0 signature, 5-minute window, replay table | Accepted |
| [1805](1805-slack-link-unfurls.md) | Link unfurls: title and first paragraph of shared pages | Accepted |
| [1806](1806-slack-setup-manifest-and-fake-slack-tests.md) | Setup by manifest, and tests against a fake Slack | Accepted |

## 1820–1829 Form views and formula fields

| ADR | Title | Status |
|---|---|---|
| [1820](1820-form-view-in-the-view-config.md) | A "form" collection view, its questions in the view config | Accepted |
| [1821](1821-public-form-links.md) | Public form links: a token per form view, in their own table | Accepted |
| [1822](1822-public-answers-made-as-the-publisher.md) | Public answers: made as the publisher, via "public form", with abuse limits | Accepted |
| [1823](1823-formula-fields.md) | Formula fields: computed from the same row, never stored | Accepted |
| [1824](1824-a-safe-formula-parser-of-our-own.md) | A small formula language with our own parser and evaluator | Accepted |
| [1825](1825-same-formula-results-on-server-and-web.md) | Same formula results on the server and the web; errors in the cell | Accepted |
| [1826](1826-formulas-in-query-rows.md) | Formulas in query_rows filters and sorts: decided in memory, handed to SQL | Accepted |
| [1827](1827-formulas-in-charts.md) | Formulas in charts and view filters: by what they yield | Accepted |
| [1828](1828-testing-forms-and-formulas.md) | Testing forms and formulas | Accepted |

## 1840–1849 Page verification, presentation mode, scheduled public links and member status

| ADR | Title | Status |
|---|---|---|
| [1840](1840-page-verification-with-an-expiry.md) | Page verification with an expiry | Accepted |
| [1841](1841-changes-since-verification-from-the-change-feed.md) | "Changed since verification" comes from the change feed | Accepted |
| [1842](1842-verified-and-stale-marks-in-agent-output.md) | Verified and stale marks in agent output | Accepted |
| [1843](1843-presentation-mode-slides-from-headings.md) | Presentation mode: slides from headings, read-only copies | Accepted |
| [1844](1844-scheduled-public-links.md) | Scheduled public links: a start time | Accepted |
| [1845](1845-member-status-per-account-with-auto-clear.md) | Member status: one per account, cleared at a set time | Accepted |
| [1846](1846-member-status-in-presence-mentions-and-agent-output.md) | Member status in presence, mentions and agent output | Accepted |

## 1860–1869 Team agents

| ADR | Title | Status |
|---|---|---|
| [1860](1860-a-persons-connection-as-a-target.md) | A person's connection as a target | Accepted |
| [1861](1861-agent-refs-next-to-person-values.md) | Agent refs sit next to person values | Accepted |
| [1862](1862-team-agents-board.md) | Team agents board | Accepted |
| [1863](1863-hand-offs-go-to-one-connection.md) | Hand-offs go to one connection's inbox | Accepted |
| [1864](1864-assigning-work-to-a-persons-agent.md) | Assigning work to a person's agent | Accepted |
| [1865](1865-team-summary-in-catch-up.md) | Team summary through catch_up, not a new tool | Accepted |
| [1866](1866-testing-team-agents.md) | Testing team agents | Accepted |

## 1870–1879 Public form answers and agents

| ADR | Title | Status |
|---|---|---|
| [1870](1870-public-form-answers-are-people-not-agents.md) | Public form answers are people's input, not agents' edits | Accepted |

## 1900–1909 find_context 0.15.1: page slots, URLs, packing, output

| ADR | Title | Status |
|---|---|---|
| [1900](1900-thin-and-title-only-sections-do-not-take-the-page-slot.md) | find_context: a line of links or a title-only match does not take its page's slot | Accepted (amends the per-page rule of 1211) |
| [1901](1901-urls-are-not-words-of-the-note.md) | find_context: link targets and bare URLs are not words of the note | Accepted |
| [1902](1902-large-chunks-are-cut-around-their-best-lines.md) | find_context packing: a chunk above 40% of the budget is cut around its best lines | Accepted (amends the packing of 0927, 1211 and the merge of 1720) |
| [1903](1903-per-page-rule-and-floor-re-measured.md) | find_context: per-page rule and relevance floor re-measured, kept at 1 / 0.7 / 0.6 | Accepted (confirms 1211) |
| [1904](1904-other-language-notes-guidance-and-weak-result-hint.md) | find_context: notes in another language — ask with queries=[original, translation], and say so when an answer is weak | Accepted |
| [1905](1905-query-forms-and-rrf-k.md) | find_context query forms (English inflection, Korean double particles) and RRF k = 10 | Accepted (amends the word groups of 1210/1700 and the merge constant of 1720) |
| [1906](1906-find-context-short-page-ids-and-shared-can.md) | find_context output: 8-character page ids, `can:` once when every result has the same | Accepted (amends the output of 0927, 1212 and 1720) |
| [1907](1907-find-context-verification-marks-at-the-end.md) | find_context: verification marks in one line at the end | Accepted (amends the find_context part of 1842) |
| [1908](1908-find-context-output-baselines-changed-in-0151.md) | find_context output in 0.15.1: what changed in the bytes, and the tests that pin them | Accepted |
| [1909](1909-evaluation-field-cases-of-0151.md) | Retrieval evaluation: the 0.15.1 field cases, answer-in-body and tokens per question, 0.15.1 numbers | Accepted (extends 1213, 1702) |

## 1920–1929 Sync and data-loss paths

| ADR | Title | Status |
|---|---|---|
| [1920](1920-vault-sync-revision-sees-deletions.md) | Vault sync revisions see deletions | Accepted |
| [1921](1921-failed-collab-store-retries-and-unload-guard.md) | A failed collab store retries, and an unsaved document is not unloaded | Accepted |
| [1922](1922-inbox-ack-follows-the-listing.md) | Inbox acknowledgement follows the listing | Accepted |
| [1923](1923-duplicate-flushes-live-documents-transfer-bumps-access.md) | Duplicate copies the live document; ownership transfer is an access change | Accepted |
| [1924](1924-boot-reindex-of-pages-a-crash-left-stale.md) | Boot re-index of pages a crash left stale | Accepted |
| [1925](1925-single-instance-guard.md) | Single-instance guard at boot | Accepted |
| [1926](1926-unsaved-edits-in-the-browser.md) | Unsaved edits in the browser: leave guard, deferred release, indicator | Accepted |

## 1940–1949 MCP fixed cost and tool surface

| ADR | Title | Status |
|---|---|---|
| [1940](1940-id-arguments-without-patterns-in-the-tool-list.md) | Id arguments: a plain string in the tool list, checked by a refinement, resolved before the handler | Accepted |
| [1941](1941-short-ids-in-every-tool-and-what-a-prefix-may-reveal.md) | Short ids in every tool, and what a prefix may reveal | Accepted |
| [1942](1942-ids-once-and-outline-without-repeated-headings.md) | Ids once each in read output; outline lines without the repeated heading, with known | Accepted |
| [1943](1943-workspace-inferred-from-a-page-or-the-only-workspace.md) | workspaceId inferred from a page or the only workspace; fewer calls before the first answer | Accepted |
| [1944](1944-compact-is-the-default-list-format.md) | compact is the default format of list_pages and search | Accepted |
| [1945](1945-tool-list-without-sdk-defaults-and-one-copy-of-each-spec.md) | Tool list without the SDK's defaults, one copy of each spec; profiles designed, not built | Accepted |
| [1946](1946-values-that-change-without-the-page-go-after-the-body.md) | Values that change without the page go after the body | Accepted |
| [1947](1947-update-page-replace-names-the-version-it-read.md) | update_page replace names the version it read | Accepted |
| [1948](1948-backlinks-on-read-page-and-create-page-kinds.md) | Backlinks on read_page; create_page makes canvases and folders | Accepted |

## 1960–1969 Section names after headings move

| ADR | Title | Status |
|---|---|---|
| [1960](1960-a-section-name-another-section-answered-to-needs-the-version.md) | A section name that passed to another section needs the version read | Accepted |
| [1961](1961-patch-section-keeps-its-baseversion-rule.md) | patch_section keeps its baseVersion rule (not ADR 1947's) | Accepted |

## 2000–2009 MCP profiles, resources, prompts, memory check

| ADR | Title | Status |
|---|---|---|
| [2000](2000-tool-profiles-core-and-full-in-the-mcp-url.md) | Tool profiles: core and full, chosen in the MCP URL; more_tools reaches the rest | Accepted |
| [2001](2001-pages-as-mcp-resources.md) | Pages as MCP resources: a template, a short list, the read_page answer | Accepted |
| [2002](2002-fixed-mcp-prompts-with-id-arguments.md) | Three MCP prompts: fixed server text, id arguments only | Accepted |
| [2003](2003-check-notes-memory-check.md) | check_notes: a read-only memory check of a workspace or subtree | Accepted |
| [2004](2004-long-instructions-note-and-length-route.md) | Long agent instructions: a note at the end of get_instructions and a length route | Accepted |

## 2020–2029 Connecting apps and team memory

| ADR | Title | Status |
|---|---|---|
| [2020](2020-connection-settings-generator.md) | Connection settings generator: per-client formats from their own docs, token mode behind a switch | Accepted |
| [2021](2021-instruction-page-length-warning.md) | A long instruction page shows a warning; the server measures, the web only shows | Accepted |
| [2022](2022-claude-code-skill-and-team-memory-recipe.md) | An Inkling skill for Claude Code and a "team memory" recipe, instead of longer tool descriptions | Accepted |

## 2040–2049 Suspicious content, agent uploads and PDF text

| ADR | Title | Status |
|---|---|---|
| [2040](2040-suggest-only-after-flagged-content.md) | Suggest only after flagged content | Accepted |
| [2041](2041-taint-suggestions-are-never-auto-accepted.md) | Suggestions of a suggest-only connection are never auto-accepted | Accepted |
| [2042](2042-suggest-only-window-and-releases.md) | Suggest-only for 60 minutes; the owner or an admin lifts it; no "new session" | Accepted |
| [2043](2043-suggest-only-switch-on-by-default.md) | The workspace switch for suggest-only is on by default | Accepted |
| [2044](2044-upload-file-for-agents.md) | upload_file: an agent's file goes through the web upload and the page's write path | Accepted |
| [2045](2045-agent-upload-limits-and-types.md) | Uploads through a connection: 5 MB, typed by the server, a daily budget | Accepted (limits and budget amended by [2065](2065-agent-uploads-switch-and-limits.md)) |
| [2046](2046-read-file-text-by-extension-and-read-time-scan.md) | read_file: text by extension, and attachment text is scanned when read | Accepted |
| [2047](2047-pdf-text-with-unpdf.md) | PDF text for read_file with unpdf 1.9.1 | Accepted |
| [2048](2048-pdf-limits-in-a-worker-thread.md) | PDF limits: a worker thread with a time limit, pages and characters per call | Accepted |

## 2060–2069 Agent connection tokens and agent uploads

| ADR | Title | Status |
|---|---|---|
| [2060](2060-agent-connection-tokens-are-hand-made-grants.md) | Agent connection tokens: hand-made agent connections, stored as OAuth grants | Accepted |
| [2061](2061-agent-token-format-storage-and-expiry.md) | Agent connection tokens: format, storage and expiry | Accepted |
| [2062](2062-guessing-agent-tokens-at-mcp.md) | Guessing agent connection tokens at /mcp counts towards the IP ban | Accepted |
| [2063](2063-issuing-agent-tokens-names-audit-and-the-connections-screen.md) | Issuing agent connection tokens: browser only, names, audit, and the Connections screen | Accepted |
| [2065](2065-agent-uploads-switch-and-limits.md) | Uploads by AI agents: a server default, a workspace switch, limits from the environment | Accepted |

## 2100–2109 Mermaid diagrams and section links

| ADR | Title | Status |
|---|---|---|
| [2100](2100-section-links-are-page-links-with-a-heading-fragment.md) | Section links `[[Page#Heading]]` are page links with a heading fragment | Accepted |
| [2101](2101-section-refs-in-page-links.md) | Section references in `page_links.sections`; backlinks name the heading | Accepted |
| [2102](2102-following-section-links-through-renames.md) | Following section links: block id, name, then the change log | Accepted |
| [2103](2103-check-notes-reports-section-links-without-their-heading.md) | check_notes reports section links whose heading is gone | Accepted |
| [2104](2104-mermaid-diagrams-in-code-blocks.md) | Mermaid diagrams are code blocks in language `mermaid`, drawn on demand | Accepted |
| [2105](2105-mermaid-safety-strict-and-an-image.md) | Mermaid safety: strict configuration, a cleaning pass, shown as an image | Accepted |
| [2106](2106-mermaid-in-themes-print-and-presentation.md) | Mermaid in dark mode, PDF export, presentation and narrow screens | Accepted |
| [2107](2107-internal-link-clicks-in-editor-bodies.md) | Internal link clicks in editor bodies: one owner per click | Accepted |
| [2108](2108-select-pickers-inside-editor-blocks.md) | Select pickers inside editor blocks are kept from ProseMirror | Accepted |

## 2120–2129 Database views in pages, public pages and exports

| ADR | Title | Status |
|---|---|---|
| [2120](2120-inline-database-view-is-a-page-embed-with-a-view.md) | An inline database view is a page embed of a collection with a view | Accepted |
| [2121](2121-public-pages-show-embedded-data-only-from-inside-the-link.md) | Public pages show embedded data only from inside the link | Accepted |
| [2122](2122-markdown-download-keeps-blocks-with-snapshots.md) | The Markdown download keeps charts, database views and queries with a snapshot | Accepted |
| [2123](2123-database-views-in-agent-reads.md) | Database views in agent reads: the page-embed token and a name line | Accepted |

## 2140–2149 Database fields, filters, sub-items and guests

| ADR | Title | Status |
|---|---|---|
| [2140](2140-automatic-values-email-phone-and-unique-ids.md) | Collection fields: automatic values, email and phone, unique IDs from a trigger | Accepted |
| [2141](2141-last-editor-from-the-change-log.md) | "Last edited by" is the change log's actor, kept on the page | Accepted |
| [2142](2142-view-filter-groups-and-not.md) | View filters: OR groups and NOT, one evaluator, stored next to the flat list | Accepted |
| [2143](2143-file-field-deferred.md) | A files field: designed, not in 0.17 | Accepted |
| [2144](2144-sub-items-as-a-parent-relation.md) | Sub-items: a Parent item relation of the collection to itself | Accepted |
| [2145](2145-list-view.md) | A list view | Accepted |
| [2146](2146-guests-open-shared-collections.md) | Page guests open the collections shared with them | Accepted |
| [2147](2147-agent-task-board-template-and-mcp-parameters.md) | An agent task board template; sub-items in query_rows and create_row | Accepted |

## 2160–2169 Local trial, zip imports and vault sync

| ADR | Title | Status |
|---|---|---|
| [2160](2160-first-admin-setup-link-from-the-server-log.md) | The first admin comes in through a one-time setup link from the server log | Accepted |
| [2161](2161-local-trial-script-and-compose-overlay.md) | A local trial in one command: deploy/local.sh and compose.local.yaml | Accepted |
| [2162](2162-import-zip-for-agents-with-the-upload-rules.md) | import_zip: an agent's zip becomes a page tree under the upload rules | Accepted |
| [2163](2163-zip-archive-safety-names-encodings-links-and-ratio.md) | Zip imports: crafted names, legacy encodings, links and the inflate ratio | Accepted |
| [2166](2166-vault-sync-retries-create-once-and-rewrite-nothing.md) | Vault sync retries: a create happens once, a repeated write changes nothing | Accepted |
| [2167](2167-vault-directories-follow-renames-and-deletes.md) | Vault sync: directories follow renames and deletes | Accepted |
| [2168](2168-vault-sync-keeps-and-reports-what-it-cannot-carry.md) | Vault sync keeps and reports what it cannot carry, instead of dropping it or stopping | Accepted |
| [2169](2169-vault-sync-writes-embeds-as-block-tokens.md) | Vault sync writes embeds as block tokens; the revision carries the Markdown format | Accepted |

## 2180–2189 AI step versions, search and workspace scope

| ADR | Title | Status |
|---|---|---|
| [2180](2180-one-version-per-agent-write.md) | One version per agent write ("AI step"): snapshot rows with a content digest, per-client step caps | Accepted |
| [2181](2181-ai-step-boundaries.md) | Where one AI step ends: batches, people in between, suggestions, conflicts and restores | Accepted |
| [2182](2182-list-versions-shows-steps-folded.md) | list_versions and the web history show AI steps; long runs are folded | Accepted |
| [2183](2183-search-ranking-and-one-agent-search-route.md) | search ranks title > heading > body, whole word before part; one agent search route over every workspace | Accepted |
| [2184](2184-search-output-grouped-by-workspace-with-a-more-line.md) | search output: grouped by workspace, 10 by default with an "N more" line, and when to use it instead of find_context | Accepted |
| [2185](2185-find-context-names-workspaces-when-an-answer-spans-several.md) | find_context names the workspaces when an answer spans several | Accepted |
| [2186](2186-workspace-arguments-take-a-name.md) | Workspace arguments take a name as well as an id | Accepted (extends 1940, 1941) |
| [2187](2187-no-per-connection-default-search-workspace.md) | No per-connection default search workspace (for now) | Accepted |
| [2188](2188-best-workspace-first-measured-and-not-adopted.md) | Several-workspace evaluation cases; "best workspace first" measured and not adopted | Accepted (extends 1213, 1909) |

## 2190–2199 0.17 integration

| ADR | Title | Status |
|---|---|---|
| [2190](2190-automatic-values-and-sub-items-outside-the-app.md) | Automatic values and sub-items in database tables outside the app | Accepted |
| [2191](2191-mermaid-on-public-pages.md) | Mermaid diagrams on public pages are drawn in the reader's browser | Accepted |
| [2192](2192-query-rows-computes-automatic-values-only-when-read.md) | query_rows computes automatic values in SQL only for the fields a filter or sort reads | Accepted |

## 2200–2209 Offline copies

| ADR | Title | Status |
|---|---|---|
| [2200](2200-device-copies-of-pages-in-indexeddb.md) | Device copies of pages in IndexedDB, written without y-indexeddb | Accepted |
| [2201](2201-document-generation-and-the-sync-gate.md) | Document generation and a sync gate before every Auth | Accepted |
| [2202](2202-offline-start-from-stored-app-data.md) | Offline start from the last app data the server sent | Accepted |
| [2203](2203-device-setting-and-when-copies-are-deleted.md) | Device setting: on in the installed app, off in a browser tab; when copies are deleted | Accepted |
| [2204](2204-one-status-for-unsent-edits.md) | One status for unsent edits: on this device, or only in this tab | Accepted |

## 2220–2229 Web push

| ADR | Title | Status |
|---|---|---|
| [2220](2220-web-push-with-node-crypto-and-a-stored-vapid-key.md) | Web push with node:crypto, and a VAPID key made on first use | Accepted |
| [2221](2221-push-subscriptions-belong-to-a-session-and-endpoints-are-allowlisted.md) | Push subscriptions belong to the session that made them; endpoints are allowlisted and protected | Accepted |
| [2222](2222-push-deliveries-through-the-outbox-from-the-notification-rows.md) | Push deliveries go through the outbox, one per notification row and device | Accepted |
| [2223](2223-what-a-push-shows-and-the-service-worker.md) | What a push shows on a lock screen, and what the service worker does with it | Accepted |

## 2240–2249 Buttons and database automations

| ADR | Title | Status |
|---|---|---|
| [2240](2240-database-automations-run-from-the-change-log.md) | Database automations are queued by the change-log consumer and run after the write | Accepted |
| [2241](2241-automations-act-as-their-author-capped-by-the-trigger.md) | Automations act as their author through REST, capped by whoever triggered them | Accepted |
| [2242](2242-automation-loops-limits-and-the-via-label.md) | Automation loops stop at a marker and a depth limit; their writes read "via automation: <name>" | Accepted |
| [2243](2243-automation-runs-failures-and-outbound-actions.md) | Automation runs are logged, failing rules turn off, outbound actions use registered webhooks | Accepted |
| [2244](2244-button-block.md) | A button block runs its actions as the person who presses it | Accepted |
| [2245](2245-agents-see-automations-in-describe.md) | Agents see a database's enabled automations in query_rows describe; they cannot make rules | Accepted |

## 2260–2269 Web clipper and share target

| ADR | Title | Status |
|---|---|---|
| [2260](2260-web-clipper-request-and-page-shape.md) | The web clipper is one REST route that writes a page like an imported file, with no MCP tool | Accepted |
| [2261](2261-article-extraction-on-the-server-dom-without-readability.md) | Article extraction uses server-util's DOM and a small reader-mode heuristic, not Readability | Accepted |
| [2262](2262-clip-fetches-are-browser-only-and-rate-limited.md) | Server-side fetches for clips are for browser sessions only, limited per person and per server | Accepted |
| [2263](2263-clip-screen-bookmarklet-and-share-target.md) | /clip is a form filled from its query; the bookmarklet and the share target only open it | Accepted |

## 2280–2289 OAuth Client ID Metadata Documents

| ADR | Title | Status |
|---|---|---|
| [2280](2280-oauth-client-id-metadata-documents-behind-a-switch.md) | OAuth clients identified by a metadata document, behind OAUTH_CIMD, stored as oauth_clients rows keyed by the URL | Accepted |
| [2281](2281-cimd-document-fetch-validation-and-cache.md) | Metadata documents: fetched through safeFetch without redirects, 5 KiB, public clients only, cached 1 min–24 h | Accepted |
| [2282](2282-cimd-consent-screen-host-and-iss.md) | Metadata-document clients on the consent screen: the client_id host next to the unverified name, a localhost warning, no logo, `iss` in the response | Accepted |

## 2300–2309 Workspace groups and archive

| ADR | Title | Status |
|---|---|---|
| [2300](2300-workspace-groups-and-archive-are-per-person.md) | Workspace groups and archive are a person's own list, not a state of the workspace | Accepted |
| [2301](2301-workspace-listings-table-for-members-and-guests.md) | Two tables for the list: workspace_list_groups and workspace_listings (migration 0057) | Accepted |
| [2302](2302-list-arrangement-is-not-a-permission.md) | The list arrangement is not a permission: browser-only writes, no access version | Accepted |
| [2303](2303-archived-workspaces-leave-the-default-scope.md) | Archived workspaces leave the default scope of find_context, search and catch_up only | Accepted |
| [2304](2304-one-closing-line-names-the-archived-workspaces.md) | One closing line names the archived workspaces a default answer left out | Accepted |
| [2305](2305-switcher-shape-organizer-and-list-workspaces.md) | Switcher shape, the organizer, list_workspaces fields; group names are not workspace arguments | Accepted |

## 2320–2329 0.18 integration

| ADR | Title | Status |
|---|---|---|
| [2320](2320-row-numbers-in-bulk-inserts-without-walking-row-versions.md) | Row numbers in bulk inserts: the counter bump goes to this transaction's newest collection row | Accepted |
| [2321](2321-no-answer-from-the-server-on-the-0-18-screens.md) | No answer from the server: one "No connection" error, 0.18 screens fail at once, logout drops the push subscription it could not end | Accepted |
| [2322](2322-menus-at-the-caret-choose-their-side-from-the-room.md) | Menus at the caret choose their side from the room around the caret | Accepted |
| [2323](2323-presentation-splits-at-the-shallowest-repeated-heading-level.md) | Presentation mode splits at the shallowest heading level used twice, and long slides scroll | Accepted |
| [2324](2324-a-screen-that-cannot-be-drawn-says-so-instead-of-going-white.md) | A screen that cannot be drawn says so instead of going white | Accepted |

## 2340–2349 0.19 names

| ADR | Title | Status |
|---|---|---|
| [2340](2340-data-names-from-one-required-variable.md) | Data names from one required variable: INKLING_DATA_NAME, and compose refuses without it | Accepted |
| [2341](2341-rename-by-copying-volumes-and-renaming-in-the-copy.md) | Moving an install to the new names: copy the volumes, rename the role in the copy | Accepted |
| [2342](2342-rename-test-in-ci.md) | Rename test: an old-name install upgraded and moved in CI, the same script locally | Accepted |

## 2360–2369 Public page toolbar: wide view, PDF and Markdown download

| ADR | Title | Status |
|---|---|---|
| [2360](2360-public-page-wide-view-follows-the-page-and-the-visitor.md) | Wide view on public pages follows the page, then the visitor; running text capped at 60rem | Accepted |
| [2361](2361-public-page-pdf-through-the-browser-print.md) | "Save as PDF" on public pages is the browser's print, with the article marked while it is shown | Accepted |
| [2362](2362-markdown-download-of-public-pages.md) | Markdown download of public pages: per link, off by default, the page's own blocks | Accepted |
| [2363](2363-public-page-toolbar-folds-into-one-menu-on-phones.md) | Public page actions: a row of buttons, one "⋯" menu on narrow screens | Accepted |

## 2380–2389 Onboarding

| ADR | Title | Status |
|---|---|---|
| [2380](2380-onboarding-state-per-person-new-accounts-only.md) | Onboarding state per person, for new accounts only; the checklist ticks itself from stored facts | Accepted |
| [2381](2381-sample-page-first-admin-auto-members-by-button.md) | The sample page: made for the first admin once, for members by button, private, labelled as a sample | Accepted |
| [2382](2382-intro-motion-drawn-in-code-as-a-function-of-time.md) | The intro motion is SVG drawn in code as a pure function of time, in a lazy chunk | Accepted |
| [2383](2383-operators-can-show-the-intro-to-existing-accounts-once.md) | Operators can show the intro to existing accounts once (ONBOARDING_EXISTING_USERS=once) | Accepted |
| [2384](2384-getting-started-card-inside-the-sidebar-height-budget.md) | The Getting started card is part of the sidebar's height budget; it scrolls inside, the footer stays reachable | Accepted |
| [2385](2385-intro-end-screen-camera-and-ink-wipe.md) | The intro ends on a screen of next steps; a camera and ink wipes inside the same pure function | Accepted |
| [2386](2386-image-viewer-double-click-in-the-editor-click-elsewhere.md) | Image viewer: double-click or the corner button in the editor, one click where nothing can be edited | Accepted |
| [2387](2387-public-callouts-carry-their-icon-css-finds-parts-by-class.md) | Public page callouts carry their icon; the CSS finds the icon and the text by class | Accepted |

## 2400–2409 find_context recall (0.20)

| ADR | Title | Status |
|---|---|---|
| [2400](2400-recall-evaluation-set-and-page-metrics.md) | Recall evaluation set: questions as people remember pages, asked over several workspaces | Accepted |
| [2401](2401-shorter-form-of-a-korean-compound-in-titles-and-headings.md) | The shorter form of a Korean compound counts in titles and headings, with a discount | Accepted (amends the word groups of 1210/1700) |
| [2402](2402-a-chunk-without-the-rare-query-word-keeps-three-quarters.md) | A chunk without the query's rarest word keeps three quarters of its score | Accepted (amends the score of 1210) |
| [2403](2403-title-words-count-in-document-frequency.md) | Title words count in a word's document frequency; results of the 0.20 word rules | Accepted (amends the word weights of 1210) |
| [2404](2404-embedding-role-prefixes.md) | Optional role prefixes for embedding models (EMBEDDING_QUERY_PREFIX, EMBEDDING_PASSAGE_PREFIX) | Accepted (amends 1740) |

## 2420–2429 Columns (0.20)

| ADR | Title | Status |
|---|---|---|
| [2420](2420-columns-are-columnlist-and-column-nodes.md) | Columns are `columnList` and `column` nodes next to BlockNote's blocks (core's API, not the GPL package) | Accepted |
| [2421](2421-column-edits-without-automatic-cleanup.md) | Column edits never tidy a group by themselves (own transactions, column-safe replace/remove, edge keys) | Accepted |
| [2422](2422-columns-in-markdown-as-comment-markers.md) | Columns in Markdown are comment markers around each column, in every notation mode | Accepted |
| [2423](2423-columns-on-narrow-screens-and-other-views.md) | Columns stack below 640 px and keep their layout in public, slides, print, embeds | Accepted |
| [2424](2424-headings-in-columns-are-not-sections.md) | A heading inside a column is not a section; patch_section and find_context keep a group whole | Accepted |
| [2425](2425-older-clients-are-read-only-on-pages-with-newer-nodes.md) | Older clients are read-only on pages that hold node types they do not know (document schema version) | Accepted |

## 2440–2449 Charts on public links (0.20)

| ADR | Title | Status |
|---|---|---|
| [2440](2440-public-link-charts-switch-per-link-off-by-default.md) | Charts on a public link: a per-link switch, off by default | Accepted; amended by 2444 |
| [2441](2441-public-charts-aggregate-as-the-manager-who-turned-them-on.md) | Public charts are aggregated as the manager who turned them on, while a member | Accepted; amended by 2444 |
| [2442](2442-public-charts-drawn-in-the-browser-from-labels-and-numbers.md) | Public charts are drawn in the browser from labels and numbers, a table underneath | Accepted |
| [2443](2443-public-render-cache-keyed-by-whose-charts.md) | The public render cache is keyed by whose access its charts use | Accepted |
| [2444](2444-public-charts-only-of-approved-sources.md) | Public charts only of sources a manager approved | Accepted |

## 099x Client updates

| ADR | Title | Status |
|---|---|---|
| [0990](0990-build-id-and-version-header.md) | Build id in the bundle and an X-Inkling-Build header on every API response | Accepted |
| [0991](0991-client-update-modes.md) | Client update modes: prompt (default) and force | Accepted |
| [0992](0992-force-reload-safety.md) | Force mode reloads only when nothing local is unsaved | Accepted |
| [0993](0993-single-update-notice-and-sw-handoff-fix.md) | One update notice at the app root; the SW hand-off looks up the waiting worker on accept | Accepted |
| [0994](0994-optional-github-release-check.md) | Optional GitHub release check for admins (off by default) | Accepted |

## 0995–0999 Math (KaTeX)

| ADR | Title | Status |
|---|---|---|
| [0995](0995-math-nodes-in-both-editor-schemas.md) | Math nodes in both editor schemas, built from one shared config | Accepted |
| [0996](0996-math-markdown-notation.md) | Math in Markdown: `$$` blocks and `$…$` spans, cut out around BlockNote's converter | Accepted |
| [0997](0997-math-rendering-katex-safety-and-loading.md) | Math rendering: KaTeX with safety options, lazy loading, editing UX, share page and print | Accepted |
| [0998](0998-math-render-scheduling.md) | Math render scheduling: paced insertion, a resident cap, deferral only on math-heavy pages | Accepted |
| [0999](0999-no-server-side-math-rendering.md) | The server never renders math | Accepted |
