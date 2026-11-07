# Known issues

These are known issues that were triaged out of the ship-blocking fix phase and accepted for now. Each entry gives a severity (High / Medium / Low / Info) and the audit or follow-up ID it came from: `A-*` sync and concurrency audit, `B-*` resource and OS audit, `C-*` security code review, `TODO` the follow-up ledger, `P-*` the performance-phase reports.

Add new items to the matching section, one line per item in the same shape: `- **Severity** (ID) description`. "Editor" covers the editor and content fidelity (export, public share, round trips). When an item is fixed, delete it and mention the fix in the changelog or ADR.

For the deployment hardening checklist see [OPERATIONS.md](OPERATIONS.md). To report a new vulnerability see [SECURITY.md](../SECURITY.md).

## Security

- **Medium** (C-L7) Session tokens are stored in plaintext in `sessions.token`; a database or backup leak yields usable sessions. Fix: store sha256 and convert existing rows in a migration.
- **Medium** (C-L4) No Origin / `Sec-Fetch-Site` check on state-changing requests or on the `/collab` upgrade; CSRF and cross-site WebSocket protection relies on `SameSite=Lax` alone. Any future fix must exempt `/oauth/token` and `/mcp`, which are called by non-browser clients.
- **Medium** (C-L2, TODO #4) A successful login resets the IP-wide failure counter, so an attacker with one valid account can interleave its logins to keep guessing other accounts. Fix: reset only that account's counter and let the IP counter decay.
- **Medium** (C-L14, TODO #6) A single-use signup key stays valid forever as a password-recovery code for the account that used it. Fix: expire recovery after a period, or show and revoke it in the admin screen.
- **Medium** (C-M3, remaining part) Any workspace member can add existing users directly via `POST /workspaces/:id/members`, and there is no block list, so a removed member can be re-added by any member.
- **Medium** (C-L9) The collaboration socket has no limits on message rate, awareness payload size, documents per socket or accumulated Yjs size; awareness user names can be spoofed. Fix: token bucket and size checks in `beforeHandleMessage`, server-side awareness identity.
- **Medium** (C-M11) `pnpm audit --prod` reported vulnerable dependencies (fastify, @fastify/static, @fastify/busboy, MCP SDK, drizzle-orm, zod, @tiptap/core, prosemirror-view). Addressed in the dependency phase; re-run `pnpm audit --prod` before release.
- **Low** (C-L15) OAuth: no token revocation endpoint; dynamic client registration has no global cap or cleanup of unused clients; `client_id` handling is lenient; any `https` `redirect_uri` is accepted at registration.
- **Low** (TODO, P-server leftover) The OAuth authorization code is consumed before the PKCE verifier is checked, so a wrong verifier burns the code instead of being rejected without side effects.
- **Low** (C-L6) Login for a nonexistent account returns 401 immediately while existing accounts pay an argon2 verify, so response timing reveals which emails exist. Fix: dummy argon2 verify.
- **Low** (C-L13, TODO) Webhook URLs, which often embed secrets (Slack/Discord tokens), are stored in plaintext. Fix: encrypt with an app secret from env.
- **Low** (C-L16) A plugin can navigate its own frame to exfiltrate data it was given. Accepted: the trust boundary is the admin's approval of the plugin (documented in `docs/PLUGINS.md`).
- **Low** (C-L17) The link-preview rate-limit key is the session, so one user with several sessions (or several users) multiply the outbound fetch budget.
- **Low** (C-L11, last item) The vault-sync manifest hash (`sync.ts`) includes titles of linked pages the caller cannot see, which leaks that they changed.
- **Low** (TODO, P-server leftover) An open collaboration socket on a page that is moved to the trash stays connected and writable.
- **Low** (TODO #5) Login failure counters live in memory and reset on restart (IP bans themselves persist in `ip_bans`). Accepted for a single instance.
- **Low** (C-Info) Session TTL is a fixed 30 days with no idle expiry.
- **Low** (C-Info) With delegated login enabled, a typo in a local account's email sends the password to the upstream auth server.
- **Low** (C-Info) `GET /files/*` answers `Cache-Control: private, immutable, max-age=1y`; a browser keeps a file after access to it is revoked. Fix: short `max-age`.
- **Info** (C-Info) `GET /auth/mode` is unauthenticated and reveals the signup and delegated-login configuration.

- **Info** (fix phase) When a collab store or upgrade fails, the logged `DrizzleQueryError` message contains the SQL text and may contain bound parameters; log volume during a DB outage is high. Fix: log only the SQLSTATE and the document id.
- **Info** (C-M5, design) Members can still add rows to a publicly shared collection: a new row is treated as an edit of the collection's content (like typing into a public page). Moving existing pages into a public folder, or creating pages/folders there, is owner-only (docs/adr/0802-*).

- **Low** (fix phase, docs/adr/0814-*) The SPA CSP allows `img-src`/`media-src` `https:`, `data:` and `blob:` only; plain `http:` images and media embedded in documents no longer load. `style-src` keeps `'unsafe-inline'` (BlockNote/Mantine inline styles).

<!-- fix-web / tests-ci: append Security items above this line -->

## Concurrency

- **Low** (A-Low) Collection fields `PUT` has no version / 412 either; concurrent schema edits last-write-wins.
- **Medium** (A-M6) Vault-sync `PUT` compares metadata and then overwrites it later (TOCTOU) while the document is already written, so a race leaves a partial write. Fix: integer `meta_version` CAS; never await a DirectConnection while holding a row lock.
- **Medium** (A-M9) A DirectConnection can attach to a document that Hocuspocus is unloading, and the edit may be lost.
- **Medium** (A-M13) Sheet sync reads collection fields, fetches the sheet, then writes the fields back, overwriting schema edits made in between. Fix: re-read under `FOR UPDATE` and merge.
- **Medium** (B-M3, A-Low) File upload and import insert the DB row before writing the file (not atomic); a crash leaves rows without files or orphan files. Fix: tmp file + rename, then insert; free-space check; orphan sweep.
- **Medium** (TODO, DB extension) Collection import runs in chunks and is not atomic; a failure leaves a partial collection. Fix: roll back the created collection or tag rows with an import session id.
- **Low** (A-Low) Two concurrent "create share link" requests can create two tokens. Fix: coalesce on conflict.
- **Low** (A-Low) Collaboration per-IP connection count is checked after an `await`, so a burst can exceed the cap. Fix: reserve the slot before awaiting.
- **Low** (A-Low) The auth guard records a failure only after argon2 finishes, so parallel guesses are not counted until they complete.
- **Low** (A-Low) Forgot-password and verification resend are check-then-issue; a double click can send two mails with two valid codes.
- **Low** (A-Low) After a successful reset, consuming the code and `setPassword` run in separate transactions.
- **Low** (A-Low) An OAuth refresh retry with an already-rotated refresh token revokes the whole grant (intentional reuse detection; a flaky client network logs the user out).
- **Low** (TODO, P-server leftover) The boot-time backfill can overwrite values written concurrently by a request during startup.
- **Low** (TODO, P-server leftover) Renaming a page does not bump `workspaceVersion`, so cached query-block results can show the old title for up to 60 s.
- **Info** (A-Low) Page `sortOrder` is computed as `max + 1000` outside a transaction; concurrent inserts can share a value (harmless, order is still stable).
- **Info** (A, not reviewed) The concurrency audit did not cover exporter/importer internals, `notion.ts`, plugins (except storage), comments, bookmarks, notifications or page-tree drag and drop.

- **Low** (fix phase) Page-tree changes of one workspace are serialised by an advisory lock; under heavy contention a waiter hits `lock_timeout` (10 s) and gets a 500 instead of being retried. Fix: map SQLSTATE 55P03 to 503 + Retry-After.
- **Low** (docs/adr/0910-*) A request that passed its membership check just before a workspace was soft-deleted can still write into it; the write is hidden with the workspace and restored or purged with it. Members left with no workspace cannot see the `workspace_deleted` notification until they create or join one.
- **Low** (fix phase) Trees deeper than 64 levels that already exist in a database (created before the cap) are only walked to depth 64 by trash/restore/purge; deeper descendants of a trashed page stay live and are moved to the root at purge time.

- **Low** (fix phase, docs/adr/0815-*) Ink 412 merge: the undo history is not rebased onto the merged stroke list, and a stroke another device added after our base cannot be erased until it has been merged in. The client merge path is covered by the server test and code review only, not by a two-device browser run.

<!-- fix-web / tests-ci: append Concurrency items above this line -->

## Operations

- **Medium** (B-M8) Backups are written to the same disk as the database, and the weekly restore test creates a temporary database inside the production PostgreSQL without checking the db volume's free space. Keep an off-site copy and ample free disk.
- **Medium** (B-M9) No concurrency cap on heavy jobs (folder import, zip export, subtree duplicate) inside the 768m app container; several at once can OOM-kill it. Fix: a global semaphore (1 to 2 jobs).
- **Medium** (B-M1) Zip export opens a read stream for every attachment up front (one fd each) and leaks them if the client aborts. Fix: open lazily and destroy on `reply.raw` close.
- **Low** (B-L4, remaining parts) Base `compose.yaml` publishes `3000` on all interfaces, `POSTGRES_PASSWORD` defaults to `nodian`, and `DATABASE_URL` falls back to a dev value, with no boot warning for any of them. Production must use the Caddy overlay and a strong password.
- **Low** (B-L1) The app container runs as root without an init process (tini). The backup scripts (umask 077, read-only mounts) currently assume root.
- **Low** (B-L2) The Caddy and rclone overlay services have no `logging:` limits, so their container logs can grow without bound.
- **Low** (B-L5) Reminders: no overlap guard beyond the re-entrancy flag, N+1 queries per tick, a burst of work right after boot, and reminders or backups missed while the server was down are not caught up.
- **Low** (B-L6) `query.ts` computes "today" in UTC while reminders use `TZ`, so date filters near midnight disagree.
- **Low** (B-L7) Housekeeping does not delete expired `ip_bans` rows or unused `oauth_clients`.
- **Low** (TODO, backup) Backup failures are only visible in Admin › Backups; there is no instance-level alert channel (`notifyBackupFailureExternal` is not wired to mail or an admin webhook).
- **Low** (TODO #7) With `REQUIRE_EMAIL_VERIFICATION=1`, the first admin cannot log in before verifying, and mail may not be configured yet. Workaround: mark the account verified via SQL or set the flag after the first admin exists.
- **Info** (TODO, webhooks) The webhook delivery queue and link-preview cache are in memory (single instance); queued deliveries are lost on restart.
- **Info** (TODO, vault-sync) `drizzle-kit push --force` drops hand-written indexes (trigram, perf). Since migration 0024 they are declared in the schema, but never run `push` against production.
- **Info** (TODO #9) When upgrading an existing deployment, its environment (`DELEGATED_AUTH_URL`, `DELEGATED_AUTH_NAME`, `DELEGATED_EMAIL_DOMAIN`, `SIGNUP_REQUIRE_KEY=1`, and any existing `TZ` / `DEFAULT_LOCALE`) must be applied together before the first boot of the new version; changing `DELEGATED_EMAIL_DOMAIN` later splits delegated accounts.

- **Low** (fix phase, docs/adr/0813-*) The admin confirm dialog does not yet call `GET /api/admin/users/:id/delete-preview`, so it cannot say how many personal workspaces will be deleted (web follow-up). Attachment links copied from a deleted personal workspace into other workspaces break.

<!-- fix-web / tests-ci: append Operations items above this line -->

## Performance

Some of these were measured before the performance phase and may be partly mitigated; re-measure before closing them.

- **Medium** (P, memory audit P1) Awareness updates call `setUsers` without an equality check (`CollabEditor.tsx`, `useCanvasDoc.ts`); measured 21x extra React commits.
- **Medium** (P, memory audit P1) The Yjs `UndoManager` stack is unbounded; typing grows memory by about 2.5 MB per minute. Fix: trim the stack in a wrapper or patch.
- **Medium** (P, memory audit P2) Each page embed opens its own `HocuspocusProviderWebsocket` instead of sharing one, which also counts against the 40 sockets per IP cap.
- **Medium** (TODO, DB extension) The 15 s collection poll includes `refs`; a changed 10k-row collection sends about 4.5 MB (unchanged ones already get 304). Fix: split refs out, send deltas, drop constant DTO fields.
- **Medium** (P, memory audit P3) Whole-buffer paths: folder import (peak 3 to 4x the 50 MB upload), subtree duplicate (in-memory map), zip export, and the right panel converting the whole document every 300 ms.
- **Low** (P, memory audit P3) Server store path re-reads the previous state before the snapshot decision and runs `stateToBlocks` plus four reindex passes on every store. Fix: reorder and debounce.
- **Low** (P, memory audit P2; docs/adr/0850-*) `content-visibility: auto` on editor blocks was removed in every engine because it made Chromium drop keystrokes typed right after Enter. Large documents are laid out in full everywhere. Measured cost in Chromium: 3,701 blocks open in 455 ms instead of 320 ms, and relayout after a width change is no longer skipped. A real fix would be JS block virtualization that keeps the edited block rendered.
- **Low** (P, memory audit) `window.ProseMirror` keeps a reference to the last editor (`@blocknote/react` `useCreateBlockNote`), retaining it after unmount.
- **Low** (TODO, DB extension) Board and calendar views are not virtualized; cells in the virtualized table are clipped to one line.
- **Low** (P-web) Page tree with 2,000 rows takes about 115 ms to lay out; no virtualization yet.
- **Low** (B-L9) argon2 hashing shares the 4-thread libuv pool with file streaming and zlib; logins and large uploads slow each other down (`UV_THREADPOOL_SIZE`, see OPERATIONS.md).
- **Low** (B-L10) MCP requests up to 12 MB are parsed with synchronous `JSON.parse`, blocking the event loop.
- **Low** (TODO, performance) Service worker `navigateFallbackDenylist` may not include newer server paths (`/ical`, `/s`, `/mcp`, `/oauth`); verify.
- **Info** (P, memory audit) A real Safari soak test (one hour of typing with five embeds) is still pending after deployment.

<!-- fix-web / tests-ci: append Performance items above this line -->

## Editor

- **Medium** (B-L8) The collaboration WebSocket `maxPayload` is 2 MB; a very large paste closes the socket with 1009 and the client reconnects in a loop.
- **Medium** (TODO, vault-sync) A vault upload regenerates all block ids, which breaks comment anchors on that page. The server schema also lacks callout, mention, pageEmbed, linkEmbed and pluginBlock, so Markdown round trips lose them.
- **Medium** (TODO, DB extension) Duplicating a collection leaves relation fields pointing at the original collection instead of the copy.
- **Low** (TODO, embeds/plugins) linkEmbed, pageEmbed, callout and pluginBlock are missing from public share HTML and from Markdown / Notion export; `PageEmbed`'s embed schema also lacks pluginBlock and callout.
- **Low** (TODO, vault-sync) Query blocks are shown as raw code in public shares and embeds.
- **Low** (tags) Tags inside code blocks and inline code are ignored, but plain-text tokens such as `#191919` still count as tags; Obsidian requires at least one non-digit character. Aligning would also need the query language's tag parser (`packages/shared`) to change.
- **Low** (P, memory audit) `useCanvasDoc` depends on `me.name`, so a name change reconnects a destroyed provider and leaves a zombie socket.
- **Info** (TODO, embeds) Paste-to-embed conversion and the toolbar's "Link" action are verified in Chromium and WebKit (Playwright). The Embed / Card toggle, the embed slash entry and the webhooks modal have not been verified in a real browser yet.

- **Low** (fix-web measurement) In Chromium, caret-moving keys pressed back to back with no delay are partly dropped. Measured with Playwright: ArrowLeft x3 at 0 ms moved the caret once (5/5 runs), and a click followed at once by Cmd+→ was ignored. At a 30 ms gap (key-repeat speed) 0/10 runs dropped, and WebKit dropped none at 0 ms. No text is lost (the caret lands elsewhere), and humans do not reach this speed. Not investigated further.

<!-- fix-web / tests-ci: append Editor items above this line -->

## Localization (i18n pass, docs/adr/0900-0904)

- **Low** Titles the server fills in for date items with no title (`Untitled`, `(empty)` in `md/dateItems.ts`) and Notion upload `warnings[]` are English and are shown as-is in the Korean UI.
- **Low** Server messages with dynamic parts (zod `refine` messages prefixed with the field path, `Delegated sign-in (<name>)…`, `Too many pages to import (max N)` when `IMPORT_MAX_PAGES` is changed) have no exact Korean match and fall back to the generic `errors.<CODE>` text; `NOTION_ERROR` shows Notion's English detail inside the Korean sentence.
- **Low** BlockNote's built-in slash items only match aliases of the active dictionary (`/할일` works in Korean UI, `/todo` in English); Inkling's own items keep both languages' aliases.
- **Low** Link previews are cached for 60 s with their placeholder text already rendered, so right after a language switch a preview can show the previous language.
- **Low** Date cells in databases show the stored `YYYY-MM-DD` value in every language; only calendar/timeline headers and tooltips are localized.
- **Info** A new account's locale is not saved at sign-up; until the user picks a language (or the browser value is adopted) their emails use `DEFAULT_LOCALE`. Content already created (snapshot labels, default field names, the Tasks document) keeps the language it was created in.
