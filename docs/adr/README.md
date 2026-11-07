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
| [0978](0978-reserved-oauth-client-names.md) | Reserved OAuth client names | Accepted |

## 099x Client updates

| ADR | Title | Status |
|---|---|---|
| [0990](0990-build-id-and-version-header.md) | Build id in the bundle and an X-Inkling-Build header on every API response | Accepted |
| [0991](0991-client-update-modes.md) | Client update modes: prompt (default) and force | Accepted |
| [0992](0992-force-reload-safety.md) | Force mode reloads only when nothing local is unsaved | Accepted |
| [0993](0993-single-update-notice-and-sw-handoff-fix.md) | One update notice at the app root; the SW hand-off looks up the waiting worker on accept | Accepted |
| [0994](0994-optional-github-release-check.md) | Optional GitHub release check for admins (off by default) | Accepted |
