# Known issues

These are known issues that were triaged out of the ship-blocking fix phase and accepted for now. Each entry gives a severity (High / Medium / Low / Info) and the audit or follow-up ID it came from: `A-*` sync and concurrency audit, `B-*` resource and OS audit, `C-*` security code review, `TODO` the follow-up ledger, `P-*` the performance-phase reports.

Add new items to the matching section, one line per item in the same shape: `- **Severity** (ID) description`. "Editor" covers the editor and content fidelity (export, public share, round trips). When an item is fixed, delete it and mention the fix in the changelog or ADR.

For the deployment hardening checklist see [OPERATIONS.md](OPERATIONS.md). To report a new vulnerability see [SECURITY.md](../SECURITY.md).

## Security

- **Medium** (C-L2, TODO #4) A successful login resets the IP-wide failure counter, so an attacker with one valid account can interleave its logins to keep guessing other accounts. Fix: reset only that account's counter and let the IP counter decay.
- **Medium** (C-L14, TODO #6) A single-use signup key stays valid forever as a password-recovery code for the account that used it. Since docs/adr/1110-* it is stored only as SHA-256 and never shown again once used, but it still works. Fix: expire recovery after a period, or revoke it in the admin screen.
- **Medium** (C-L9) The collaboration socket has no limits on message rate, awareness payload size, documents per socket or accumulated Yjs size; awareness user names can be spoofed. Fix: token bucket and size checks in `beforeHandleMessage`, server-side awareness identity.
- **Medium** (C-M11) `pnpm audit --prod` reported vulnerable dependencies (fastify, @fastify/static, @fastify/busboy, MCP SDK, drizzle-orm, zod, @tiptap/core, prosemirror-view). Addressed in the dependency phase; re-run `pnpm audit --prod` before release.
- **Low** (C-L15) OAuth: no token revocation endpoint; dynamic client registration has no global cap or cleanup of unused clients; `client_id` handling is lenient; any `https` `redirect_uri` is accepted at registration.
- **Low** (TODO, P-server leftover) The OAuth authorization code is consumed before the PKCE verifier is checked, so a wrong verifier burns the code instead of being rejected without side effects.
- **Low** (C-L6) Login for a nonexistent account returns 401 immediately while existing accounts pay an argon2 verify, so response timing reveals which emails exist. Fix: dummy argon2 verify.
- **Low** (C-L13, docs/adr/1111-*) Webhook and sheet-sync URLs are encrypted only when `APP_SECRET_KEY` is set; without it they, and the "copy link" copies of share tokens, invite codes and unused signup keys (docs/adr/1110-*), stay in plaintext (the boot log counts them). Fix: set `APP_SECRET_KEY`; the next boot encrypts them.
- **Low** (C-L16) A plugin can navigate its own frame to exfiltrate data it was given. Accepted: the trust boundary is the admin's approval of the plugin (documented in `docs/PLUGINS.md`).
- **Low** (C-L17) The link-preview rate-limit key is the session, so one user with several sessions (or several users) multiply the outbound fetch budget.
- **Low** (TODO, docs/adr/0947-*) A per-client agent block can be sidestepped by registering the same agent again under a new OAuth `client_id`; blocking "all agents" of the member covers it. Dynamic client registration has no cap (C-L15).
- **Low** (TODO, docs/adr/0946-*) The workspace audit log is append-only in application code only (no DB trigger); a database administrator can still change rows.
- **Medium** (TODO, docs/adr/0976-*, 0977-*, 2040-*) The `<untrusted_content>` markers and the injection heuristics are mitigations, not a boundary: a model can still follow wrapped text. Since 0.16 a connection handed flagged content is suggest-only for an hour, but that only helps when the heuristics fire: the phrase list is short and English/Korean only, and it is evaded by paraphrase, other languages, homoglyphs NFKC does not fold, splitting an instruction across sections or pages, text in images and in attachment types read_file does not return, and instructions that do not name a tool or address an agent. `encoded-blob` misfires on long hex/base64-looking runs (a CSV of ids, a line of `xxxx…`). Real boundaries remain edit locks, scopes, ranges, agent blocks and review policies.
- ~~**Low** (TODO, docs/adr/0976-*) JSON-output MCP tools (list_pages, search `json`, list_workspaces, the create/rename/move echoes) are not wrapped and get no `applies:` line, to keep their shape; page titles there remain a small injection channel. No MCP tool returns comments yet; one that does must wrap them.~~ Resolved in part by docs/adr/1525-*: JSON-output tools clean every member-written string, mark it as data (a trailing `untrusted` key or a second text block) and add `applies` to the create/rename/move answers. Still open: the strings are not inside `<untrusted_content>` (the JSON shape is kept), so a model may still treat a title as an instruction; the same mitigation-not-boundary caveat as 0976 applies.
- **Low** (TODO, docs/adr/0970-*) Live collaboration sockets are re-authenticated when a lock changes, but not when a member's role changes (admin → member); the next reconnect is read-only. File uploads with a `pageId` are not refused on locked pages (inert until a document references them).
- **Low** (TODO, docs/adr/0970-*) Canvas nodes, collection cells and the properties panel stay editable in the web UI on a locked page (no read-only mode there yet); the server refuses the writes with `PAGE_LOCKED`.
- ~~**Low** (TODO, docs/adr/0978-*) A member whose display name folds to the same string as an OAuth client's name (e.g. "Claude") blocks that client at consent for everyone in their workspaces until one of them renames.~~ Resolved by docs/adr/1007-*: exact match, per workspace, common app names warn only.
- **Low** (NOTIFY-S1, docs/adr/1007-*) A client may still choose a common app name ("Claude") while a member has that display name; writes stay labelled "<person> via Claude", and the consent screen warns.
- **Info** (TODO, docs/adr/0977-*) `content.suspicious` audit dedupe is best effort: two concurrent re-indexes of one page can record the same rule twice.
- **Info** (TODO, docs/adr/0950-*) The export policy gates only the whole-workspace zip; any member can still export single pages they can see (by design: agent reads and copy/paste allow it anyway).
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

- **Low** (AGENT-S1, docs/adr/0936-*) OAuth client names are self-asserted at dynamic registration; "(via X)" is sanitized (control/bidi characters stripped, 60 characters) but X can imitate another product's name.
- **Low** (AGENT-S2, docs/adr/0935-*) A refresh request cannot narrow a grant's scope; to downgrade to read-only, disconnect and connect again.

- **Low** (docs/adr/1061-*) Wrong two-step codes are counted per challenge (5) in the database, but the per-account backoff (`totp:<email>`) lives in memory like the other guard counters and resets on restart.
- **Low** (docs/adr/1061-*) An admin can turn off a member's two-step verification and then reset their password, which together take over the account. Admins are trusted; a workspace that requires 2FA (docs/adr/1112-*) then blocks that member until they turn it on again, which the new password holder can do.
- **Low** (docs/adr/1061-*) Losing or changing `APP_SECRET_KEY` makes every stored TOTP secret unreadable; affected users can only sign in with a recovery code (or an admin turns 2FA off). There is no key rotation.
- **Low** (docs/adr/1062-*) State-changing requests whose Origin is not `PUBLIC_URL`/`APP_URL` are refused, so an instance reached under a second address (LAN IP, alias domain) is read-only there. There is no extra-origins setting.
- **Info** (docs/adr/1060-*) A plaintext session row inserted by an older `deploy/cli-token.sh` stays plaintext until its first use (then it is hashed in place).

- **Low** (docs/adr/1110-*) Invite codes are 10 characters (~50 bits) and stored as unsalted SHA-256: a leaked database lets someone brute-force a code offline in about a GPU-day. Regenerating the code (members panel) makes the leaked hash useless. Fix: longer codes or a keyed hash.
- **Low** (docs/adr/1110-*, 1111-*) Losing or changing `APP_SECRET_KEY` makes the encrypted copies unreadable: share links, invite codes and unused signup keys keep working but can no longer be shown (publish again / regenerate / issue a new key), and webhooks and sheet syncs fail until the URL is entered again. There is no key rotation.
- **Low** (docs/adr/1112-*) When a workspace's 2FA grace period runs out by itself, members' open collaboration sockets stay connected until they reconnect (turning the requirement on with no grace closes them at once).
- ~~**Low** (docs/adr/1112-*) A member blocked by a workspace's 2FA requirement still gets that workspace's mail digests, agent-inbox items (when the inbox is read without a workspace) and its outgoing webhooks keep firing; the in-app notification list and the iCal feed leave it out.~~ Resolved by docs/adr/1300-* for mail, the agent inbox and the other cross-workspace reads. Still open: the workspace's outgoing webhooks keep firing (they belong to the workspace, not the member), and items dropped from notification mail while blocked are not mailed later.
- **Info** (docs/adr/1112-*) Delegated sign-in accounts count as satisfying a workspace's 2FA requirement (their second factor is the upstream service's); Inkling cannot check that it is on.

- **Low** (docs/adr/1302-*) Duplicating a page, creating one from a template and copying blocks do not copy attachment rows; the copy points at the original page's files. Since public links serve only files of pages inside what they share, such a copy shared on its own shows no images on the public page.
- **Low** (docs/adr/1301-*) Routes that check a browser session with a per-file `requireSessionUser` helper (page access, edit lock, workspace administration, notification settings, sidebar) call `requireUser` directly and run without the request's guest scope: a guest there is not narrowed to their shared trees, so a page outside them answers 403 instead of 404.
- **Info** (docs/adr/0970-*) Manual snapshots (`POST /api/pages/:id/snapshots`) and "Mark reviewed" (`POST /api/pages/:id/review`) stay open under an edit lock and for members with a view or comment level, as 0970 decided. A reader's mark sets `reviewed_at`/`reviewed_by` (and can hold off the review reminder), and a manual snapshot puts their name in the version history.

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

- **Low** (fix phase, docs/adr/0815-*) Ink 412 merge: the undo history is not rebased onto the merged stroke list, and a stroke another device added after our base cannot be erased until it has been merged in. The client merge (`mergeConflict`, `apps/web/src/lib/inkSync.ts`) has unit tests since docs/adr/1340-*; a two-device browser run is still missing.

- **Low** (AGENT-C1, docs/adr/0930-*, 0940-*, 1500-*) `patch_section(replace)` and `update_page(replace)` edit in place (block alignment + character diff), so concurrent typing merges; characters typed into a block the agent deletes or retypes are lost, and a changed table is replaced as one node (typing inside it is not merged). (Until 0.12 the live-document reads of `update_page` and vault sync also deleted callouts, embeds and mentions page-wide; with the server schema of docs/adr/1500-* they keep them.)
- ~~**Low** (AGENT-C2, docs/adr/0934-*) `create_row` with relation values is two writes (insert, then links); if the second fails the row exists without links (the error says so).~~ Resolved by docs/adr/1524-*: the links are written in the row's transaction; when they cannot be written, no row is made.

- ~~**Medium** (CF-1, docs/adr/0932-*) Change-feed ordering and merge safety rely on an in-process write chain and high-water mark: single server instance only; a second process writing `page_changes` would need a database lock.~~ Resolved by docs/adr/1080-*: one consumer per database under an advisory lock, high-water mark in `change_feed_state`.
- **Low** (CF-7, docs/adr/1080-*) Readers of `page_changes` other than `changes_since` (activity screen, provenance badge / `last_edit`, review scores, AI digest) see a write after the outbox consumer: milliseconds normally, at most the 1 s poll while the process runs. `changes_since` drains first and is not affected.

- **Low** (TEST-1, docs/adr/1243-*) All `[db]` test files share one database and run in parallel processes: a test that needs database-wide quiet (no other process issuing change-feed cursors, consuming orphaned outbox rows) must wait for the condition it asserts or carry `// run-tests: db-exclusive` (now `context/changeFeed.test.ts` and `outbox.db.test.ts`, run alone after the others, about +11 s). The causes found there besides the 2FA clock were test assumptions: provenance read before the outbox consumer (CF-7), cursors and consumers of other files, a TOTP step boundary.
- **Low** (TEST-2, docs/adr/1242-*) Timestamps written from the app clock (`new Date()`) and compared with `now()` in SQL can disagree by the app–database clock skew (46 ms to 2.1 s on Docker Desktop as its VM clock drifts; the same host in production shares one clock). The two-step deadline now uses the database clock; other columns (TOTP challenge expiry, share and token expiry) were not changed, since their margins are minutes, and were not audited further.
<!-- fix-web / tests-ci: append Concurrency items above this line -->

## Operations

- **Low** (TODO, docs/adr/0953-*) Page read counters are buffered in memory for up to a minute; a crash loses that minute, and several app instances would each keep their own buffer (single instance assumed, like reminders).
- **Medium** (B-M8) Backups are written to the same disk as the database, and the weekly restore test creates a temporary database inside the production PostgreSQL without checking the db volume's free space. Keep an off-site copy and ample free disk.
- ~~**Medium** (B-M9) No concurrency cap on heavy jobs (folder import, zip export, subtree duplicate) inside the 768m app container; several at once can OOM-kill it. Fix: a global semaphore (1 to 2 jobs).~~ Resolved by docs/adr/1240-*: `HEAVY_JOBS_MAX` (default 2) slots with a per-person fair queue, 503/429 with Retry-After.
- **Low** (B-M9, remaining) The heavy-job cap is per process (one instance assumed); template import (`/workspaces/:id/templates/import`, up to 25 MB) and pages-from-template are not gated; a zip export keeps its slot until the download ends, so a very slow client holds one slot (others get 503 + Retry-After after `HEAVY_JOBS_WAIT_MS`, not memory growth).
- ~~**Medium** (B-M1) Zip export opens a read stream for every attachment up front (one fd each) and leaks them if the client aborts. Fix: open lazily and destroy on `reply.raw` close.~~ Resolved: entries were already opened lazily (docs/adr/0751-*); since docs/adr/1241-* an aborted download destroys the open entry, removes the temp dir and releases the heavy-job slot.
- **Low** (B-M1, remaining) The export teardown hooks `_destroy` of JSZip's readable-stream 2.x output and pauses its `_helper`; a JSZip upgrade must keep `md/exportZip.db.test.ts` green.
- **Low** (B-L4, remaining parts) Base `compose.yaml` publishes `3000` on all interfaces, and `DATABASE_URL` falls back to a dev value, with no boot warning for any of them. Production must use the Caddy overlay and a strong password.
- **Low** (B-L1) The app container runs as root without an init process (tini). The backup scripts (umask 077, read-only mounts) currently assume root.
- **Low** (B-L2) The Caddy and rclone overlay services have no `logging:` limits, so their container logs can grow without bound.
- **Low** (B-L5) Reminders: no overlap guard beyond the re-entrancy flag, N+1 queries per tick, a burst of work right after boot, and reminders or backups missed while the server was down are not caught up.
- **Low** (B-L6) `query.ts` computes "today" in UTC while reminders use `TZ`, so date filters near midnight disagree.
- **Low** (B-L7) Housekeeping does not delete expired `ip_bans` rows or unused `oauth_clients`.
- **Low** (TODO, backup) Backup failures are only visible in Admin › Backups; there is no instance-level alert channel (`notifyBackupFailureExternal` is not wired to mail or an admin webhook).
- ~~**Low** (TODO #7) With `REQUIRE_EMAIL_VERIFICATION=1`, the first admin cannot log in before verifying, and mail may not be configured yet. Workaround: mark the account verified via SQL or set the flag after the first admin exists.~~ Resolved in part in 0.17 by docs/adr/2160-*: the account made through the first-admin setup link is not subject to `REQUIRE_EMAIL_VERIFICATION`. A first admin who signs up with a signup key instead still needs the workaround.
- **Info** (TODO, webhooks) The link-preview cache is in memory (single instance). Webhook deliveries are in the outbox since docs/adr/1081-* and survive a restart; they are at least once: a crash during the HTTP call sends that message again after the 30 s lease (`X-Inkling-Delivery` is stable, but Slack and Discord do not deduplicate on it).
- **Info** (TODO, vault-sync) `drizzle-kit push --force` drops hand-written indexes (trigram, perf). Since migration 0024 they are declared in the schema, but never run `push` against production.
- **Info** (TODO #9) When upgrading an existing deployment, its environment (`DELEGATED_AUTH_URL`, `DELEGATED_AUTH_NAME`, `DELEGATED_EMAIL_DOMAIN`, `SIGNUP_REQUIRE_KEY=1`, and any existing `TZ` / `DEFAULT_LOCALE`) must be applied together before the first boot of the new version; changing `DELEGATED_EMAIL_DOMAIN` later splits delegated accounts.

- **Low** (fix phase, docs/adr/0813-*) The admin confirm dialog does not yet call `GET /api/admin/users/:id/delete-preview`, so it cannot say how many personal workspaces will be deleted (web follow-up). Attachment links copied from a deleted personal workspace into other workspaces break.

- **Low** (AGENT-O1, docs/adr/0926-*) After upgrading, existing pages are invisible to `find_context` until the boot backfill reaches them (50 pages per batch, at most 50,000 per boot; the rest continue next boot or on their next edit). `search` is unaffected.

- **Low** (UPD-1, docs/adr/0993-*) Tabs still running a bundle from before the update-banner change keep the old toast logic (a stale waiting worker, a one-shot prompt, no notice outside `AppLayout`) until they are reloaded once by hand or the browser restarts; the deploy after that is handled by the new code.
- **Low** (UPD-2, docs/adr/0992-*) Force mode protects collaborative document edits and in-flight API mutations only; text typed into a non-Yjs field (e.g. an unsent comment draft) is protected only by the 3-second idle rule and is lost if the tab reloads.
- **Low** (UPD-3, docs/adr/0993-*) When no new service worker takes over within 8 s, the tab unregisters its service worker before reloading; the next load downloads the full precache again.
- **Info** (UPD-4, docs/adr/0990-*) The build id is time-based unless `INKLING_BUILD` is set, so an image rebuilt from the same source announces a "new version" once.

- **Low** (NOTIFY-O1, docs/adr/1000-*, 1081-*) Notification events are queued in the outbox table and written exactly once, also across a crash. Remaining gap: producers that call `notify()` / `emitWebhookEvent()` after their own transaction (comment, assignment, owner, reminder and digest routes) insert the event in a separate statement; a crash in the milliseconds between the route's commit and that insert loses the event. After a restart, the previous boot's pending events are picked up 10 s after they became due. Instant-mail timers are rebuilt from `mail_state` by housekeeping.
- **Low** (NOTIFY-O2, docs/adr/1004-*) Digest mail goes out from 08:00 server-local time, not the recipient's time zone; weekly digests are "7 days since the last one", not a fixed weekday.
- **Low** (NOTIFY-O3, docs/adr/1002-*) Live typing is attributed to the person who typed in the page most recently (two-minute window); with several people typing at once a mention may be credited to the wrong one. Mentions inside canvases and collection cells are not tracked.
- **Low** (NOTIFY-O4, docs/adr/1002-*) Agent-written plain-text "@Name" is matched against exact display names; two members with the same name both receive the (quiet) mention.
- **Info** (NOTIFY-O5, docs/adr/1003-*) Inbox acknowledgement is per person, not per connection: when one of a person's agents acks an item, their other agents no longer see it.
- **Info** (NOTIFY-O6, web) On a locked page, "Mark reviewed" and "Save as template" stay available; their server routes were not re-checked against the lock in this change.

<!-- fix-web / tests-ci: append Operations items above this line -->

## Performance

Some of these were measured before the performance phase and may be partly mitigated; re-measure before closing them.

- **Medium** (P, memory audit P1) Awareness updates call `setUsers` without an equality check (`CollabEditor.tsx`, `useCanvasDoc.ts`); measured 21x extra React commits.
- **Medium** (P, memory audit P1) The Yjs `UndoManager` stack is unbounded; typing grows memory by about 2.5 MB per minute. Fix: trim the stack in a wrapper or patch.
- **Medium** (P, memory audit P2) Each page embed opens its own `HocuspocusProviderWebsocket` instead of sharing one, which also counts against the 40 sockets per IP cap.
- **Medium** (TODO, DB extension) The 15 s collection poll includes `refs`; a changed 10k-row collection sends about 4.5 MB (unchanged ones already get 304). Fix: split refs out, send deltas, drop constant DTO fields.
- **Medium** (P, memory audit P3) Whole-buffer paths: folder import (peak 3 to 4x the 50 MB upload), subtree duplicate (in-memory map), zip export, and the right panel converting the whole document every 300 ms.
- **Medium** (NOTION-4, docs/adr/0961-*) Zip and Notion imports hold the uploaded archive in memory (JSZip needs the whole buffer); a Notion export with part archives holds those too (bounded by `IMPORT_MAX_UPLOAD_MB`). Raising the `IMPORT_MAX_*` caps on a 768m container needs headroom; since docs/adr/1240-* at most `HEAVY_JOBS_MAX` imports, exports and copies hold such buffers at once, and an upload is read into memory only inside its slot.
- **Low** (P, memory audit P3) Server store path re-reads the previous state before the snapshot decision and runs `stateToBlocks` plus four reindex passes on every store. Fix: reorder and debounce.
- **Low** (P, memory audit P2; docs/adr/0850-*) `content-visibility: auto` on editor blocks was removed in every engine because it made Chromium drop keystrokes typed right after Enter. Large documents are laid out in full everywhere. Measured cost in Chromium: 3,701 blocks open in 455 ms instead of 320 ms, and relayout after a width change is no longer skipped. A real fix would be JS block virtualization that keeps the edited block rendered.
- **Low** (P, memory audit) `window.ProseMirror` keeps a reference to the last editor (`@blocknote/react` `useCreateBlockNote`), retaining it after unmount.
- **Low** (TODO, DB extension) Board and calendar views are not virtualized; cells in the virtualized table are clipped to one line.
- **Low** (P-web) Page tree with 2,000 rows takes about 115 ms to lay out; no virtualization yet.
- **Low** (B-L9) argon2 hashing shares the 4-thread libuv pool with file streaming and zlib; logins and large uploads slow each other down (`UV_THREADPOOL_SIZE`, see OPERATIONS.md).
- ~~**Low** (B-L10) MCP requests up to 12 MB are parsed with synchronous `JSON.parse`, blocking the event loop.~~ Resolved in part by docs/adr/1526-*: requests without a valid token are not parsed and value-heavy bodies are refused above 20,000 values. Still open: string-heavy bodies (folder imports) are parsed synchronously, about 3 ms of event-loop time per MB (≈ 30 ms at the 12 MB limit); a worker parser was measured and rejected for now.
- **Low** (TODO, performance) Service worker `navigateFallbackDenylist` may not include newer server paths (`/ical`, `/s`, `/mcp`, `/oauth`); verify.
- **Info** (P, memory audit) A real Safari soak test (one hour of typing with five embeds) is still pending after deployment.

- **Low** (AGENT-P1, docs/adr/0927-*) `find_context` ranks at most 300 candidate chunks chosen by a coarse SQL score; a query made only of very common words is ranked on that coarse score before the cut. Measured p50 49 ms / p95 67 ms on a 15k-chunk workspace.
- **Low** (AGENT-P2, docs/adr/0926-*) Section text is stored twice (`page_texts` and `page_chunks`, plus a stored tsvector). `page_chunks` covers the whole page up to 5,000 rows; `page_texts` keeps the first and last ≈ 100 KB of a body over 200 KB, so `search` misses the middle of such a page (`find_context` finds it, docs/adr/1040-*).
- **Low** (AGENT-P3, docs/adr/0934-*) Collection filters scan the collection's rows (no per-field indexes); very large collections with custom sorts can hit the 3 s timeout (400 `QUERY_TIMEOUT`). `query_rows` with all columns on a large collection costs more tokens than `read_page` (row id + version on every line).

- **Low** (CF-5) Each `changes_since` call may hash up to 2,000 rows × 2 × 16 KB of text; worst case tens of MB per call.

<!-- fix-web / tests-ci: append Performance items above this line -->

## Editor

- **Medium** (B-L8) The collaboration WebSocket `maxPayload` is 2 MB; a very large paste closes the socket with 1009 and the client reconnects in a loop.
- ~~**Medium** (TODO, vault-sync) A vault upload regenerates all block ids, which breaks comment anchors on that page. Exported Markdown carries callouts (`> [!type]`) and mentions as `@Name` text, but not page/link embeds or plugin blocks, so uploading a file back removes those and turns mention chips into text (docs/adr/1500-*).~~ Resolved for the usual paths: block ids are kept since 0.15.1 (docs/adr/1920-*), and page embeds, database views, link embeds, plugin blocks and charts are kept as one-line block tokens since 0.17 (docs/adr/2169-*). Still open: when the minimal edit does not validate, the rewrite gives new ids (SYNC-3); a mention chip or a file/audio block in a paragraph edited in the vault becomes `@Label` / a link.
- **Medium** (TODO, DB extension) Duplicating a collection leaves relation fields pointing at the original collection instead of the copy.
- ~~**Low** (TODO, embeds/plugins) linkEmbed, pageEmbed and pluginBlock are missing from public share HTML and from Markdown / Notion export. Callouts (and mention names) are in share HTML and Markdown export since docs/adr/1500-*, and `PageEmbed`'s embed schema is built from the editor's block list since docs/adr/1539-*.~~ Resolved in part in 0.17: page embeds, link embeds, database views and query results are on public pages (docs/adr/2121-*) and in the Markdown download (docs/adr/2122-*).
- **Low** (TODO, plugins) Plugin blocks are missing from public share HTML and Markdown export; Notion export leaves out page and link embeds.
- ~~**Low** (TODO, vault-sync) Query blocks are shown as raw code in public shares and embeds.~~ Resolved in part in 0.17 by docs/adr/2121-*: public pages show the results.
- **Low** (TODO, embeds) Inside an in-app page embed, a query block shows its code without results (the embed viewer has no query portals).
- **Low** (tags) Tags inside code blocks and inline code are ignored, but plain-text tokens such as `#191919` still count as tags; Obsidian requires at least one non-digit character. Aligning would also need the query language's tag parser (`packages/shared`) to change.
- **Low** (P, memory audit) `useCanvasDoc` depends on `me.name`, so a name change reconnects a destroyed provider and leaves a zombie socket.
- **Info** (TODO, embeds) Paste-to-embed conversion and the toolbar's "Link" action are verified in Chromium and WebKit (Playwright). The Embed / Card toggle, the embed slash entry and the webhooks modal have not been verified in a real browser yet.

- **Low** (fix-web measurement) In Chromium, caret-moving keys pressed back to back with no delay are partly dropped. Measured with Playwright: ArrowLeft x3 at 0 ms moved the caret once (5/5 runs), and a click followed at once by Cmd+→ was ignored. At a 30 ms gap (key-repeat speed) 0/10 runs dropped, and WebKit dropped none at 0 ms. No text is lost (the caret lands elsewhere), and humans do not reach this speed. Not investigated further.

- **Low** (AGENT-E1, docs/adr/0926-*) `find_context` is lexical: no synonyms, and a question in one language does not find a page written only in the other. The section index trails live typing by up to 30 s (server edits are indexed immediately).
- ~~**Low** (AGENT-E2, docs/adr/0926-*) Renaming a heading changes its section anchor; agents holding the old anchor get `SECTION_NOT_FOUND` with the list of current anchors.~~ Resolved by docs/adr/1501-*: old anchors follow renames from the change log, within its retention (AGENT-E6).
- ~~**Low** (AGENT-E3, docs/adr/0930-*) Inside the range it rewrites, `patch_section` converts Markdown with the server schema, so callouts, page embeds and mentions in that section are lost; blocks outside the section are untouched.~~ Resolved by docs/adr/1500-*: the server schema knows these nodes, agents read and write them in the agent notation, and `update_page` replace is a minimal edit.
- **Low** (AGENT-E4, docs/adr/0934-*) `today` in collection filters and writes is the server's UTC date; relation values given as one comma-separated string are split on commas (pass an array for titles with commas).
- ~~**Info** (AGENT-E5, docs/adr/0936-*) Pages created through MCP (`create_page`, `import_folder`, `create_from_template`) carry no `via` label; their later edits do.~~ Resolved by docs/adr/1005-* (`pages.created_via`, `page_added` rows carry the client).

- ~~**Low** (CF-2) Live typing is not attributed per change, so feed rows from the editor show no "by"; only REST/MCP writes carry actor and via.~~ Resolved in part by docs/adr/1625-*: live typing is attributed to the typist when only one person typed in the page since the last index pass, and a REST/MCP write logs pending typing first. Still open: with several typists in one index window the row has no "by"; the window is kept in memory per process.
- **Low** (CF-3) A section renamed and rewritten in the same edit, in a document without heading block ids (e.g. Markdown import), shows as removed + added rather than renamed.
- **Low** (CF-4) A page created but never written is never indexed, so it gets no `page_added` until it has content; pages edited before the upgrade backfill reaches them log `page_added` with their full text.
- **Low** (CF-6) After a page goes from private to shared, other members see one `visibility: private → shared` line, not the edits made while it was private; agents must read the page.

- **Medium** (NOTION-1, docs/adr/0960-*) Notion import: callouts become quotes (no callout block in the server schema), equations become `latex` code (no math rendering), person / rollup / formula / files columns become text, relations are one-way and only to databases in the same import, select needs at least four values, date cells keep only the start date (no time). Attachments not referenced by any page are skipped (listed in the report). Notion's HTML export and the Notion API are not supported.
- **Low** (NOTION-2, docs/adr/0960-*) Relation detection is heuristic: a text column whose every value equals a row title of one imported database becomes a relation; a link to a page that is not in the export stays a notion.so URL and is reported as unresolved.
- **Low** (NOTION-3, docs/adr/0960-*) Notion pages are created first and filled one at a time; a process crash (not an error) in that window leaves pages with empty documents. Errors roll the import back.

<!-- fix-web / tests-ci: append Editor items above this line -->

## Localization (i18n pass, docs/adr/0900-0904)

- **Low** Titles the server fills in for date items with no title (`Untitled`, `(empty)` in `md/dateItems.ts`) and Notion upload `warnings[]` are English and are shown as-is in the Korean UI.
- **Low** Server messages with dynamic parts (zod `refine` messages prefixed with the field path, `Delegated sign-in (<name>)…`, `Too many pages to import (max N)` when `IMPORT_MAX_PAGES` is changed, the import size / file-count messages when `IMPORT_MAX_*` differ from the defaults) have no exact Korean match and fall back to the generic `errors.<CODE>` text; `NOTION_ERROR` shows Notion's English detail inside the Korean sentence.
- **Low** BlockNote's built-in slash items only match aliases of the active dictionary (`/할일` works in Korean UI, `/todo` in English); Inkling's own items keep both languages' aliases.
- **Low** Link previews are cached for 60 s with their placeholder text already rendered, so right after a language switch a preview can show the previous language.
- **Low** Date cells in databases show the stored `YYYY-MM-DD` value in every language; only calendar/timeline headers and tooltips are localized.
- **Info** A new account's locale is not saved at sign-up; until the user picks a language (or the browser value is adopted) their emails use `DEFAULT_LOCALE`. Content already created (snapshot labels, default field names, the Tasks document) keeps the language it was created in.

## Added in 0.6.0
- **Low** An OIDC sign-in cannot be disconnected in the app; remove the row from `user_identities` by hand. Two tabs signing in at once: the first one fails with `OIDC_STATE_INVALID` and must start again. Multi-tenant Entra issuers (`common`, `organizations`) are not supported. With `OIDC_REQUIRE_MFA=0` a workspace that requires two-step verification trusts the provider's own policy for OIDC accounts.
- **Low** Log rotation applies to MCP `update_page` appends only; REST `/content` and `inklingctl` write to the page itself (call `POST /pages/:id/rotation/target` first). The one-time large-page notice is never sent again for that page.
- **Low** After a split the new subpages are missing from search for 2–3 s while they are indexed. The `page_created` webhooks of a split are sent after it succeeds, outside the transaction (a split can still be undone before that), so a crash in that moment loses them. The same crash window remains for review-due and digest webhooks and reminders.
- **Low** The write gate does not cover comment DELETE, quick task add, ink, vault sync, snapshot restore and typing in the editor.
- **Low** Without `APP_SECRET_KEY` the unlock cookie of password links is signed with a per-process key, so a restart asks visitors again. A link-preview fetched before a password was set may stay in the 6-hour preview cache of signed-in users.

## Added in 0.7.0
- **Low** A token or connection limited to a subtree can still list the workspace's members, see the root page's parent id and relation target ids outside the range, and download legacy files that have no page. `changes_since` does not report pages that left the range; resync after changing a range. Agent instruction pages stay readable outside the range (by design, docs/adr/1200-*).
- **Low** Personal API tokens are not agents, so a workspace owner cannot block them like an MCP connection (docs/adr/0947-*), and creating one does not ask for the password again.
- **Low** `find_context` still misses a section when its key word is common in the workspace (lexical ranking; semantic search is a design memo, docs/adr/1214-*). A rare word that is unrelated to the question can win.
- **Low** Generic webhooks accept port 443 only (put n8n's 5678 behind a proxy). The row template editor has no live co-editing; relation defaults are not supported yet.

## Added in 0.8.0
- ~~**Medium** Inserting a callout from the `/` menu can leave the cursor in the previous or next block, so the first characters typed land outside the callout (`SlashMenu.insertCallout`). Click into the callout before typing.~~ Resolved by docs/adr/1270-* (the callout is rendered before the caret moves in; math, inline math and divider/file items fixed too). Pasting or undoing a callout still renders it a moment late; undo does not move the caret into it (checked), paste was not checked.
- ~~**Low** Heading folds work on top-level headings with a mouse only (no keyboard, not on phones)~~ ⌘. / Ctrl+. and a tap-to-show arrow on touch screens since docs/adr/1271-*. Still open: ⌘F opens every fold on the page, not only the matching one (by design, the page cannot see the find query); fold safety was checked in headless Chromium and WebKit, not yet in Safari or Android, and Safari's own ⌘. (Stop) was not tested.
- **Low** Security-fix detection in the release check needs the release notes to carry the CHANGELOG Security section.

## Added in 0.9.0
- ~~**Low** Guests cannot open database pages, do not receive notifications or mentions, and cannot leave a shared page themselves (an owner or admin removes them). A view-only guest still sees the tree's [+] (it answers `PAGE_ACCESS`).~~ Resolved in part in 0.17 by docs/adr/2146-*: guests open the databases shared with them (what stays member-only: COLL17-5).
- **Low** Guests do not receive notifications or mentions and cannot leave a shared page themselves (an owner or admin removes them). A view-only guest still sees the tree's [+] (it answers `PAGE_ACCESS`).
- **Low** When a page is moved out of a guest's tree or made private, REST access stops at once but an open collaboration socket stays until it reconnects (same window as role changes, docs/adr/0970-*).
- **Low** A callout pasted or inserted by another editor still renders a moment late (the cause fixed for the `/` menu in docs/adr/1270-*); ⌘. folds have not been tried in real Safari, where ⌘. also means Stop.

## Added in 0.10.0
- **Low** (docs/adr/1340-*) Ink has no server-side history: a bad save cannot be undone once the pen layer is closed. Keeping the previous stroke list for a short time (`page_ink_history` or a `prev_strokes` column) is proposed and needs a migration.
- **Low** (docs/adr/1340-*) Old bundles still served by the service worker keep the lost-layer and save-before-load bugs until they update. The server refuses only their empty-list wipes; an unversioned non-empty save can still replace strokes (last write wins, as before).
- **Low** (docs/adr/1340-*) Strokes drawn while a page's ink cannot be loaded are kept only in the open layer and are lost when it closes (a toast says the ink did not load).
- **Low** (docs/adr/1320-*, 1352-*) Query blocks compare names and titles case-sensitively (`Owner = "priya nair"` does not match), unlike the table view's filter and `query_rows`, which also accept e-mail addresses. Rollup fields are empty in query blocks. A renamed member or retitled row shows the old name for up to a minute (query cache).
- **Low** (docs/adr/1352-*) `WHERE` / `SORT` on a relation field looks up every linked row of every candidate row before `LIMIT`; on very large collections such a query can approach the statement timeout. Narrow it with `FROM` first.
- **Low** (docs/adr/1353-*) Removing a two-way relation whose partner lives in another member's private collection edits that collection (the partner becomes one-way) and goes through its edit lock; if it is locked the removal is refused. Not covered by a test.
- **Low** (docs/adr/1351-*) Column widths are set on a 6 px edge of the header; on a phone it works with a finger but is hard to hit (no larger touch handle).
- **Low** (docs/adr/1354-*) On phones the Sort & filter panel is fixed to the screen while it is open and does not scroll with the page.

## Added in 0.11.0
- **Low** (TODO, docs/adr/1401-*) Whether a browser window hands a reserved chord to the page was not tested in real browsers: headless Chromium/WebKit have no browser chrome or menus. In a Chrome tab on a Mac ⌘⌥←/→ switch tabs (use ⌘[ / ⌘]) and ⌘N opens a window (use ⌘⌥N); Safari's menu keys ⌘⇧D (Reading List) and ⌘L may win over the editor there.
- **Low** (TODO, docs/adr/1401-*) On Windows keyboard layouts that type characters with AltGr on digit keys (German ², ³, {, }), Ctrl+Alt+0–3 type the character instead of changing the block type; use the `/` menu or the palette.
- **Low** (TODO, docs/adr/1406-*) Keys the editor binds itself (bold, italic, underline, strikethrough, inline code, headings, lists, moving blocks, indent, undo/redo) cannot be changed; Settings marks them "Built in".
- **Low** (docs/adr/1404-*) Changed keys are saved in the browser only; use Export/Import to carry them to another device or browser.
- **Low** (TODO, docs/adr/1407-*) In a database table, typing a character on a focused cell does not start editing with it (as spreadsheets do); press Enter or F2 first.
- **Low** (docs/adr/1410-*) Later, Threads, "Save this page for later" and "Follow / unfollow the thread" have no default key. The first three can get one in Settings › Keyboard shortcuts; the thread command is not listed there or in the palette (it works on the focused thread card, and opening the palette moves the focus), so it only takes a key from an imported shortcuts file.
- **Low** (LATER-1, docs/adr/1410-*) Guests can save items and follow threads inside their shared trees, but the notification engine only reaches members (docs/adr/1000-*): a guest's reminder or followed-thread reply produces no bell item or mail. The Later and Threads screens still show them.
- **Low** (LATER-2, docs/adr/1411-*) A reminder set in another process is found by the sweep timer of this process within 60 s (the setting process fires it on time). Multi-instance deployments can see up to a minute of delay.
- **Info** (LATER-3, docs/adr/1411-*) A backlog of reminders (for example 10,000 due after a long downtime) holds the notification consumer for a few seconds (3.6–3.7 s measured for 10,000); other notifications queue behind it.
- **Info** (THREADS-1, docs/adr/1412-*) Opening the comments panel on a page does not mark its followed threads read; only opening a thread from the Threads screen, its bell item, or replying in it does.
- **Info** (THREADS-2, docs/adr/1412-*) The comment POST now writes the author's `thread_follows` row in its statement. Against v0.10.0 (`apps/server/scripts/comment-post-bench.ts`, new threads, 4 interleaved rounds) it costs +0.4–0.9 ms p50 at 1 client (3.47–3.91 → 4.07–4.36 ms); at 16 clients the difference is within the spread and commits per request are unchanged. Replies, which now read their recipients from `thread_follows`, were not measured separately (docs/PERFORMANCE.md, Regressions).

## Added in 0.12.0
- **Low** (AGENT-E6, docs/adr/1501-*) Old section anchors are followed only within the change feed's retention (`CHANGE_FEED_RETENTION_DAYS`, 30 days by default) and once the rename is in the change log (REST/MCP writes at once; editor typing after the index debounce, ≤ 30 s). A `replace`/`delete` with a `baseVersion` from before the rename always conflicts (the version includes the heading); the conflict names the new anchor and version. `add_comment(section=…)` does not follow renames yet.
- **Low** (AGENT-E7, docs/adr/1500-*) An invalid `<!-- inkling:… -->` token (bad JSON, unknown props, a page id that is not a UUID, a non-http(s) link) is dropped silently, like any HTML comment in Markdown.
- **Low** (AGENT-E8, docs/adr/1500-*) Colors, alignment, underline/text color/highlight and toggles have no Markdown notation: they are kept on blocks the agent leaves alone, edits or retypes, but a block the agent writes new (or that reads back differently) gets none.
- **Low** (AGENT-E9, docs/adr/0940-*, 1500-*) A non-list block nested under another block (embed, callout, file or paragraph under a list item or a callout) is shown at the top level in Markdown; a `patch_section` over that section keeps the node but moves it to the top level with a new id.
- **Low** (INK-1, docs/adr/1511-*) `read_ink` draws only the strokes on white, not the page text under them (that would need a browser on the server). Highlighter marks over text show as coloured bands; the agent pairs them with `read_page` by y position, which is approximate because the text layout depends on the reader's screen.
- **Low** (INK-2, docs/adr/1511-*) `read_ink` renders on the event loop: about 0.2 s for a page near the 8 MiB ink save limit on an Apple M4 (≈ 30 ms for a typical page). Many agents reading very dense pages at once delay other requests by that much.
- **Low** (INK-3, docs/adr/1512-*) The `ink: N strokes` marker is shown by `read_page` (full read) and `find_context` only, not by outline or section reads or `read_pages`. Counting strokes reads the whole ink array (≈ 2.5 ms for 2 MB of ink).
- **Low** (INK-4, docs/adr/1510-*) "Agents can read handwriting" applies to OAuth (MCP) connections only. Personal API tokens can still read the stroke JSON through `GET /api/pages/:id/ink`, as before (they act as the person, docs/adr/1201-*).
- ~~**Low** (FILE-1, docs/adr/1514-*) `read_file` returns no content for PDFs (no parser on the server), audio, video or AVIF, and no image over 3 MB (the server cannot shrink images without a dependency). Text files over 2 MB are refused.~~ Resolved in part in 0.16 by docs/adr/2046-*, 2047-*: PDFs are read (text layer only; scanned PDFs need OCR, which Inkling does not do; password-protected PDFs are not opened). Still: no content for audio, video or AVIF, no image over 3 MB, text files over 2 MB, PDFs over 20 MB.
- ~~**Low** (FILE-2, docs/adr/1514-*) Uploads accept only `text/plain` among text types, so Markdown, CSV and JSON attachments read through `read_file` only when the browser sent them as plain text.~~ Resolved in 0.16 by docs/adr/2045-*, 2046-*: csv, md and json are accepted by the web upload and read by extension.
- **Low** (CATCHUP-1, docs/adr/1520-*) `catch_up` ranks at most 400 changed pages per call and diffs the 40 most important; the others are counted only. A page with more than 2,000 log rows in the window gets no diff. Comments are read up to 500 per call. Due items and Later reminders are listed on every call while due (state, not events).
- **Low** (CATCHUP-2, docs/adr/1520-*) A comment that mentions the person appears twice in `catch_up` (under "For you" and under "Comments").
- **Low** (CATCHUP-3, docs/adr/1537-*) `catch_up_markers` rows of revoked connections stay until the account is deleted (one small row each); nothing cleans them up yet.
- **Info** (CATCHUP-4, docs/adr/1543-*) The line before `next since:` in `catch_up` names the due window (`due window: up to <date>`), which moves once a day; byte-identical output for an unchanged workspace holds within a day.
- **Low** (COLL-1, docs/adr/1523-*) `update_fields` reads the field list and writes it back whole (the route's replace semantics); two schema edits at the same moment still replace each other, as in the web app. ~~There is no view tool yet (`create_view` is proposed in docs/adr/1523-*).~~ Resolved by docs/adr/1606-*: `create_view`.
- **Low** (COLL-2, docs/adr/1523-*) `create_collection` is two requests (create, then fields); when the fields are refused after the page was created (a race or a lock on a two-way target), the new page is moved to the trash and the error says so.
- ~~**Low** (SUGGEST-1, docs/adr/1530-*) A suggestion is accepted or rejected as a whole; taking some hunks of it is planned. Copy the part you want by hand and reject the rest.~~ Resolved by docs/adr/1621-*, 1622-*: a section `replace` suggestion can be accepted in part, change by change (`accepted_partial`). Other modes are still accepted whole (SUGGEST-7).
- ~~**Low** (SUGGEST-2, docs/adr/1533-*) Accepting a "replace" suggestion after the section changed replaces the newer text too. The dialog warns ("changed after the agent read it") and shows the diff against the current text, but there is no merge.~~ Resolved by docs/adr/1621-*: the review merges the chosen changes 3-way against the text the agent read, so people's edits stay; a change that overlaps one starts unchecked. Accepting whole through the API without `hunks` still replaces the section as before.
- **Low** (SUGGEST-3, docs/adr/1530-*) Guests do not see suggestions on pages shared with them and cannot accept them.
- **Low** (SUGGEST-4, docs/adr/1538-*) `patch_sections` that makes suggestions (asked, or by policy or lock) writes all of them or none, but a bad section answers the single error of the first one (`SECTION_NOT_FOUND`), not the `SECTIONS_CONFLICT` list of a direct batch.
- **Info** (SUGGEST-5, docs/adr/1534-*) When the page owner's own agent suggests on the owner's page, the owner gets an approval request from themselves, without an actor name.
- **Low** (CLAIM-1, docs/adr/1536-*) Claims only stop other agents' direct edits. People editing in the app are never blocked; they only see "<client> is working on this section".
- **Low** (POLICY-1, docs/adr/1545-*) Whole-page edits (`update_page`) are never auto-accepted; under "Accept by rules" they always wait for a person.
- **Low** (POLICY-2, docs/adr/1544-*) The workspace's agent edit policy applies to body edits only; renames, moves and trash by agents follow the lock as before. To stop those, lock the page with "Suggestions only".
- **Info** (POLICY-3, docs/adr/1544-*) "Edit directly" on a page below a "Suggestions only" folder does not loosen it: a lock never grants more than the nearer-up lock allows.
- **Low** (POLICY-4, docs/adr/1545-*) The "needs review" reasons are English server texts, also in the Korean interface.
- **Low** (POLICY-5, docs/adr/1545-*) Grace periods are checked every 30 seconds, so an auto-accept may land up to 30 s after its time.
- ~~**Low** (TOKENS-1, docs/adr/1541-*) Short (8-character) page ids work in `read_page`, `read_pages`, `patch_sections` and `list_pages(parentId)` only; every other tool still needs the full id, which `read_page` prints. `format: "compact"` is an option, not the default of `list_pages`/`search`.~~ Resolved in 0.15.1 by docs/adr/1941-* (every id argument takes the 8-character prefix) and docs/adr/1944-* (`compact` is the default).
- **Low** (TOKENS-2, docs/adr/1540-*) `known` saves tokens, not server time: the page is still read and rendered to compare versions. `find_context` has no `known`; a repeated query returns the same text (byte-identical, so provider prompt caches can reuse it).
- **Low** (TOKENS-3, docs/adr/1540-*) `read_page` and `read_pages` compute the version from the same Markdown, but `read_page` reads the stored document and `read_pages` the open one when a person is editing: for the few seconds before the store catches up, the two can report different versions of the same page (the next read is a full read, never a wrong "unchanged").
- **Info** (TOKENS-4, docs/adr/1542-*) `patch_sections` checks every edit and runs the batch on a copy before the live document, so a failing edit writes nothing. If the live run still failed after a successful copy run (that would be a determinism bug), the edits before it stay and the call returns an internal error.
- **Low** (AGENTS-1, docs/adr/1550-*, 1552-*) The find_context cache and the usage counters are per process. With more than one app process (not supported, docs/adr/1240-*), a reindex in another process leaves a cached answer readable until its page markers move or for at most 5 minutes, and each process shows only its own usage.
- **Low** (AGENTS-2, docs/adr/1552-*) Usage numbers reset at every restart and are not stored. A call that searched several workspaces (find_context without `workspaceId`) counts in each of them with its whole token count; cross-workspace lists without a per-workspace check (list_workspaces, inbox, catch_up / changes_since without a workspace) count only on the connection. Calls the MCP SDK rejects before the tool runs (invalid arguments) are not counted.
- **Info** (AGENTS-3, docs/adr/1551-*) `changes_since` waits only through the MCP tool; `GET /api/changes` has no `wait`. A proxy in front of Caddy with a read timeout under 25 s cuts waiting calls (the client then sees an error and calls again).

## Added in 0.13.0
- **Low** (CHART-1, docs/adr/1605-*, 2121-*) Public pages cache their HTML per page revision for up to 10 minutes; a chart's or database view's table, query results and an embedded page's text on a public page can lag by that much. A page leaving the link (private, trashed, moved out) is gone at once (the cache key carries the link's membership).
- **Medium** (CHART-2, docs/adr/1600-*) A page with chart blocks opened in a 0.12 client loses the charts when that client edits the page (unknown block types are dropped by the editor schema). Update every client before using charts.
- **Low** (CHART-3, docs/adr/1605-*, 2122-*) Public pages and exports show charts as tables; there is no server-rendered image yet. Since 0.17 the Markdown download also keeps the chart line before its table, so importing the file restores the chart.
- **Low** (CHART-4, docs/adr/1604-*) `read_page(known=…)` says "unchanged" when only the data behind a chart changed (the data line is not part of the page version).
- **Info** (CHART-5, docs/adr/1601-*) `ztd-charts@0.5.0` is excluded from pnpm's minimum release age in `pnpm-workspace.yaml` (it was published the day it was added); the line can be removed after 2026-11-10 04:24 UTC.
- **Low** (CHART-6, docs/adr/1602-*) Rollup fields can be measured (sum, average…) but not grouped; formula-like fields do not exist yet.
- **Medium** (REV-1, docs/adr/1620-*) Reverting brings removed text back with its formatting only when the page itself or a stored version (usually the "Before AI edit" one) still has the exact block; otherwise plain paragraphs, list items, quotes and headings come back without marks (the preview counts them), and images, tables and embeds are not rebuilt (reported, restore from versions). Page events (rename, move, trash), section moves, heading-only renames and changes over 16 KB are not reverted there.
- **Low** (REV-2, docs/adr/1620-*) A change-log row merges one agent's edits of a section within 10 minutes; such edits are reverted together.
- **Low** (SUGGEST-6, docs/adr/1621-*) Suggestions made before 0.13, or with a stale `baseVersion`, have no stored base: once their section changes, every change in the review is marked and unchecked.
- **Low** (SUGGEST-7, docs/adr/1621-*) Per-change acceptance is for section `replace` suggestions; append/prepend/insert and whole-page suggestions are still accepted whole.
- **Low** (TABLE-1, docs/adr/1642-*) A typed pipe row converts only when the whole paragraph is plain text: a row with bold, a link, a mention or inline code stays text. Cell text keeps no formatting.
- **Low** (TABLE-2, docs/adr/1642-*) A table from `/table 3x4` (or the palette) has no header row, like `/table`; in Markdown (export, agents) its first row is written as the header, and read back it becomes one.
- **Low** (SIDEBAR-1, docs/adr/1641-*) "Every menu on in the default order" saved by a 0.12 client is stored as the empty value, which 0.13 reads as the new four-menu default. Only when an old and a new client are used at the same time; switching the menus back on in 0.13 stores them explicitly.
- **Low** (SIDEBAR-2, docs/adr/1640-*) With "More" open on a short screen the menu list scrolls on its own above the tree (two scroll areas). The compact footer shows no name or email (the account icon's title has them).
- **Low** (FEED-1, docs/adr/1650-*) Google Sheets sync (experimental) writes rows and row properties without change-log rows: `changes_since` / `catch_up` do not show them.
- **Info** (FEED-2, docs/adr/1650-*) `page_props` rows keep field names, not values: the activity diff of such a row shows the names.
- **Low** (CLAIM-2, docs/adr/1654-*) `read_pages` (several pages) does not print section claims; use `read_page`.
- **Low** (TRUST-1, docs/adr/1656-*) `read_page`'s `- properties:` header line carries member-written values cleaned with `cleanText` but outside `<untrusted_content>`.

## Added in 0.14.0
- **Low** (KO-1, docs/adr/1700-*) A one-syllable query word inside a note's compound is still not found by that word: "디자인 팀" does not match "디자인팀에서", "개발 팀" not "개발팀" (the prefix index never sees a word's last syllable). The evaluation questions of that family pass on their other words. A fix needs doc-side last-syllable grams: the chunk hash must include `grams`, `CHUNKER_VERSION` 4 → 5 and a boot re-index of every page.
- **Low** (KO-2, docs/adr/1702-*) "해커톤 팀구성" shows the decision note at rank 2: a study page with the heading "팀구성" ranks first, because nothing in the decision note says 해커톤 (lexical ranking has no page or workspace context).
- **Low** (KO-3, docs/adr/1700-*) A common one-syllable noun with a particle ("팀을") now searches the noun as a whole word, which can add many candidates: ~40 ms instead of ~11 ms on the 15.7k-chunk benchmark for "팀을 나눈 방식".
- **Low** (KO-4, docs/adr/1700-*) The whole-word family of a vowel-final one-syllable stem contains real nouns: "차를" also matches 차도, 차로; "제가" matches 제도, 제의, 제로. Bounded (it lowers that word's weight and adds some spurious coverage); the 받침 check prevents wrong strips, not every collision of the family.
- **Info** (KO-5, docs/adr/1700-*) Wrong compound splits are possible ("해커톤" → 해 + 커톤, "회의주기" → 회 + 의주기); they require the two words to be adjacent and match almost nothing, but they are part of each query.
- **Info** (KO-6, docs/adr/1701-*) Heading weight 0.3 was set on the 37 dev questions; the gain is one question on the unpadded set. Flattening idf for title and heading lost on dev and was not taken.
- **Low** (MQ-1, docs/adr/1720-*) RRF favours consensus: a section that every phrasing of a bundle finds weakly can outrank one that only one phrasing finds below its top few, so under a small budget that answer may be listed under "Also relevant" instead of shown. Seen only with a worst-case corpus (filler made of query words): the "restore" bundle of `multi-query-bench.ts 1` shows 1 of 2 answer sections in about half the runs. Ask that phrasing alone, or raise `budget`.
- **Low** (MQ-2, docs/adr/1720-*) The merge works on each query's packed answer (fragments + 5 pointers), not on its full candidate list, so a section ranked just below a query's budget is invisible to the merge unless it is one of the 5 pointers.
- **Low** (MQ-3, docs/adr/1720-*) A fragment of merged neighbour sections that overlaps a section already shown is not printed; its other sections appear only as pointers (no splitting of merged text), and their `~N tok` is the fragment's tokens divided by its sections (an estimate).
- **Info** (MQ-4, docs/adr/1723-*) With semantic search on, a section found only by meaning is shown from its first chunk, not the chunk that matched best (`semanticCandidates` returns sections, not chunks).
- **Info** (MQ-5, docs/adr/1720-*) A bundle costs up to 5 retrievals on a cold cache (run in parallel on the database pool of 10); single queries are unchanged.
- **Info** (SEM-1, docs/adr/1723-*) The semantic floor (a candidate needs at least 0.6 × the best cosine of its query) and the 8 candidates per query are constants, not tuned on an evaluation set or with a real multilingual model.
- **Low** (SEM-2, docs/adr/1741-*) Brute force has a ceiling. Query time grows linearly with the chunks of the searched workspaces: ~10 ms per ~2,700 cached 768-dim vectors; a workspace larger than `EMBEDDING_CACHE_MB` is scored in SQL (~150 ms per 2,700, seconds at 50k). Past ~50k chunks per workspace, pgvector (docs/adr/1214-*) is the fix. The first query after the indexer wrote to a workspace pays an incremental cache load.
- **Info** (SEM-3, docs/adr/1740-*) Determinism (docs/adr/0937-*) depends on the endpoint: with semantic search on, find_context output can differ between a call where the endpoint answered and one where it timed out (lexical only). Same model, same documents and the endpoint up give the same output.
- **Low** (SEM-4, docs/adr/1742-*) Chunks the endpoint refuses on their own (400/413/422) are skipped until restart; the admin status counts them. Lower `EMBEDDING_MAX_CHARS` if a model has a small context.
- **Info** (SEM-5, docs/adr/1743-*) Guests get no semantic candidates (find_context does not search the workspaces they are guests in either).
- **Low** (SEM-6, docs/adr/1741-*) Vector cache, backoff and the indexer loop are per process, like the find_context cache (one process is the supported deployment).
- **Info** (SEM-7, docs/adr/1742-*) The page title is part of the embedded text: renaming a page re-embeds its chunks. Turning the feature off keeps `page_chunk_vectors` (derived data); `TRUNCATE page_chunk_vectors` reclaims the space.
- **Low** (SEM-8, docs/adr/1742-*) The pending scan and the status counts read every live chunk (md5 over its text): 51 ms at 2,700 chunks, roughly 2 s at 100k, once per ~8 requests during a backfill, once per 5 minutes when idle and once per 30 s of admin status refreshes. With pgvector a "dirty" marker written by the chunk writer would replace it.
- **Low** (SEM-9, docs/adr/1742-*) A redirecting `EMBEDDING_URL` (e.g. http → https) is refused and reported as "connection failed"; configure the final URL.
- **Low** (AGENTS-4, docs/adr/1551-*) With several server processes, a `changes_since` wait can miss a change whose change-log row another process applied: the wait ends at its deadline and the next call sees the change. One process (the supported deployment) is not affected.

## Added in 0.15.0
- **Low** (SLACK-1, docs/adr/1800-*) One Slack app per Inkling workspace: two Inkling workspaces in one Slack team cannot both own the `/inkling` command name.
- **Low** (SLACK-2, docs/adr/1802-*) Delivery is at least once: a crash right after Slack accepted a post can post it twice.
- **Info** (SLACK-3, docs/adr/1802-*) One edit that @mentions two people posts two lines (a document mention is one notification event per person); identical posts within 10 minutes are merged.
- **Info** (SLACK-4, docs/adr/1802-*) Channel posts are in `DEFAULT_LOCALE`; `/inkling` answers follow the linked person's language.
- **Low** (SLACK-5, docs/adr/1803-*) Email matching trusts Slack's confirmed address: a Slack admin who changes a member's email to another person's address would link them to that person. Use `/inkling link` if this matters.
- **Low** (SLACK-6, docs/adr/1805-*) Link unfurls need `PUBLIC_URL` with a domain name (not an IP or localhost).
- **Info** (SLACK-7, docs/adr/1806-*) The app manifest JSON was not validated against Slack's live manifest schema; the raw values are shown next to it.
- **Low** (SLACK-8, docs/adr/1803-*) `/inkling` must answer within Slack's 3 s; the first command of an unlinked person makes one `users.info` call (1.5 s limit) before the search.
- **Low** (FML-1, docs/adr/1823-*) Formulas cannot read person names or relation titles (`prop()` of a person or relation is empty): names depend on the viewer and are not known to the shared evaluator.
- **Low** (FML-2, docs/adr/1825-*) Formula dates are UTC: `now()` and date-only values are compared in UTC, so near midnight a formula's "today" can differ from the viewer's local day.
- **Info** (FML-3, docs/adr/1825-*) `now()` on the web is the time of the last recompute; the server's is the request time. Charts cache results for up to 60 s, so `now()`-based groups can lag by a minute.
- **Low** (FML-4, docs/adr/1823-*) A rollup cannot aggregate a formula of the linked collection (only count).
- **Low** (FML-5, docs/adr/1825-*) Exports compute formulas from stored properties: a formula over a rollup is empty in an export.
- **Low** (FML-6, docs/adr/1826-*) A query_rows filter or sort on a formula reads every visible row of the collection once per call (16.2 ms at 2,000 rows, 96.1 ms at 20,000, docs/PERFORMANCE.md); not measured at the 100k row cap.
- **Low** (FML-7, docs/adr/1826-*) A query_rows cursor page on a formula sort sends the rank map once per key part: 161–172 ms at 20,000 rows against 89–121 ms for the first page (docs/PERFORMANCE.md).
- **Info** (FML-8, docs/adr/1825-*) The formula editor shows the parser's English detail after the localized error label.
- **Low** (FORM-1, docs/adr/1822-*) The hourly cap of public answers per form (300) is per server process.
- **Info** (FORM-2, docs/adr/1822-*) For the publisher, form rows are "your own changes" in catch_up (actor = publisher, docs/adr/1653-*); other members see "<publisher> via public form".
- **Info** (FORM-3, docs/adr/1821-*) Public forms have no expiry or password (page links do); turn the link off instead.
- **Low** (FORM-4, docs/adr/1820-*) Required questions are checked by the server only for public answers; member answers go through the generic row route (the web checks them before sending).
- **Info** (FORM-5, docs/adr/1822-*) Public forms cannot be posted cross-site from browsers (origin check, docs/adr/1062-*); embedding a form on another site is not supported.
- **Low** (FORM-6, docs/adr/1870-*) An OAuth client registered with the name "public form" before 0.15 keeps its existing grant until its next consent (it is refused then); its edits read as people's input until then.
- **Low** (VERIFY-1, docs/adr/1841-*) "Changed since verification" is a lower bound for verifications older than the change-feed retention (default 30 days), and misses edits merged into a change row that predates the verification (10-minute merge window). The verifier's own edits logged within 5 minutes after verifying are not counted (they are what was verified).
- **Info** (PRESENT-1, docs/adr/1843-*) Presentation mode copies the blocks when it opens: edits others make while presenting appear after reopening. Folded headings show in full. Interactive blocks (query tables, embeds) are static pictures of what the editor showed.
- **Info** (PRESENT-2, docs/adr/1843-*) On iOS Safari presentation mode is a full-window overlay (no element full screen).
- **Info** (STATUS-1, docs/adr/1846-*) Presence statuses come from the awareness `user.id` field: clients older than this release do not send it, so their avatars show no status until reloaded.
- **Info** (STATUS-2, docs/adr/1845-*) Member status is per account (the same in every workspace).
- **Low** (STATUS-3, docs/adr/1846-*) The comment box and the mention menus show the status that was live when the members list was loaded (no live refresh), like the members panel.
- **Low** (TEAM-1, docs/adr/1862-*) The board and catch_up team activity are grouped by person and client name (`page_changes` stores the client name, not the grant): two connections of one person with the same client name are one row; claims and suggestions are per connection.
- **Low** (TEAM-2, docs/adr/1863-*) Hand-back on expiry, refresh-token reuse, blocks, leaving the workspace or a range change happens in the hourly housekeeping, so for up to an hour such items are in neither the person's bell nor any inbox (the revoke routes hand back at once).
- **Low** (TEAM-3, docs/adr/1861-*) `agent:<fieldId>` is written only through `PATCH /api/pages/:id/props` (web table cell, row panel, MCP update_row; MCP create_row follows up with it). Bulk edit, CSV import, batch create and row templates drop or ignore it; a template saved from a row may keep a stale key without its person (it never counts).
- **Info** (TEAM-4, docs/adr/1861-*) The agent shows next to a person cell in the table and the row panel; board, gallery, calendar and exports show the person only.
- **Info** (TEAM-5, docs/adr/1863-*) The "copy to the person" choice is the recipient's setting, not per hand-off. Turning it on does not reveal items handed before.
- **Info** (TEAM-6, docs/adr/1864-*) Agents cannot create agent chips in page bodies (same rule as person chips, docs/adr/1002-*); they hand off through comments (`handoffTo`) or rows.
- **Info** (TEAM-7, docs/adr/1864-*) A to-do assignment to an agent exists only as the inbox item it caused; there is no per-task assignee index (`page_tasks` is unchanged).
- **Info** (TEAM-8, docs/adr/1863-*) A copy mailed to the person (copy setting on) uses the ordinary subject ("Alice mentioned you in a comment"); the mail does not say it was handed to the agent. The bell does ("For your Claude Code").
- **Low** (TEAM-9, docs/adr/1865-*) `catch_up(team=true)` without `workspaceId` covers the first ten workspaces only.

## Added in 0.15.1

find_context
- **Low** (CTX-1, docs/adr/1905-*, 1909-*) With `queries=[…]`, when two phrasings each put a different section first, the RRF tie goes to the first query. An English question that finds a plausible English section ranks it above the Korean answer found by the translation ("how are newcomers assigned to teams" + "신입 팀 배정": rank 2). Put the phrasing in the notes' language first.
- **Low** (CTX-2, docs/adr/1904-*) The weak-answer hint is triggered by missing words only: more than half of the query's words and at least two, never for one-word queries, for `queries=[…]` or while semantic search is on. A wrong answer that shares most words ("team dinner budget per person" → the offsite's "budget per person") gets no hint.
- **Info** (CTX-3, docs/adr/1907-*) The review note in a fragment header (`owner …, reviewed …, stale p=0.62`) stays there; `stale p` comes from a daily batch, so that header can change from one day to the next.
- **Info** (CTX-4, docs/adr/1905-*) English query forms are suffix rules, not a stemmer: some stems are prefixes of unrelated words ("evening" → even:*, "nothing" → noth:*). Such matches only raise that word's document frequency.
- **Info** (CTX-5, docs/adr/1902-*) The large-chunk cap (40% of the budget) has no evaluation question where it changes the answer; a unit test checks the reported shape.
- **Info** (CTX-6, docs/adr/1906-*) The packing estimate still charges 15 tokens per fragment for `can:`/`edited by`, also when `can:` is printed once; the reported `~used` errs high by about 6 tokens per fragment.

MCP ids and tools
- **Info** (MCP-ID-1, docs/adr/1906-*, 1941-*) Short ids resolve among the pages the connection can see (membership, visibility, live pages, agent blocks, connection range). A prefix that matches two visible pages is an error with the candidates (8 characters: about 1 in 4·10⁹ per pair), so an 8-character id printed by find_context or read_page can match another visible page that is not in the answer; the url carries the full id. A page outside the connection's range never makes a prefix ambiguous and never shows in an error.
- **Low** (MCP-REPL-1, docs/adr/1947-*) update_page replace checks `baseVersion` and then writes in a second step; a person's edit landing between them is not caught. Without `baseVersion`, the "a person edited last" test reads the change log, which records editor typing after the index debounce (≤ 30 s).
- **Info** (MCP-LIST-1, docs/adr/1945-*) The tools/list wrapper relies on the SDK's internal request-handler map (SDK exact pin 1.32.2); `toolSurface.test.ts` fails if an upgrade stops it from applying.
- ~~**Info** (MCP-FILE-1) No MCP file upload (`read_file` only).~~ Resolved in 0.16 by docs/adr/2044-* (`upload_file`).

Section names (the short-anchor problem found during this release, MCP-SA-1, is resolved by docs/adr/1960-*)
- **Low** (SECTION-1, docs/adr/1960-*) The check relies on the change log (30-day retention) and the section index. A structural edit whose change row another process has not yet written is not seen (one process with the single-instance guard). Reads (`read_page section=`, `list_comments section=`) still take the first match of a heading text.
- **Low** (SECTION-2, docs/adr/1960-*) A name that a still-existing section held before (within retention) makes version-less writes by that name ask for the version, even when the agent read after the change.

Sync and saving
- **Medium** (SYNC-1, docs/adr/1921-*, design limit) A crash or kill (OOM, power loss, `docker kill`) loses what was typed in the last 2–10 s before it: the store is debounced (2 s, at most 10 s behind) and the browser keeps nothing. A tab still open re-sends its edits on reconnect; a tab already closed cannot. A graceful stop (SIGTERM, `docker compose stop` / `up -d`) saves everything first.
- **Low** (SYNC-2, docs/adr/1926-*) No local persistence in the browser (IndexedDB): edits made offline survive only while the tab stays open. The tab warns before closing and keeps a page's edits after in-app navigation until the server has them, but a crash of the browser or the device loses them.
- **Low** (SYNC-3, docs/adr/1920-*) A vault `PUT` is a minimal edit, so in-flight browser typing in blocks the note left alone merges. Typing in a block the note changes is still lost (as with `update_page` replace, AGENT-C1), and when the minimal edit does not validate the server rewrites the whole document (logged as `[vault-sync] minimal replace not applied`).
- **Low** (SYNC-4, docs/adr/1925-*) The single-instance lock guards processes on one database only. Two servers pointed at two copies of the data, or a server whose lock connection is cut while the database stays up (a network partition), are not detected until the heartbeat (30 s) sees the lock gone.
- **Low** (SYNC-5, docs/adr/1925-*) The guard needs a session connection: behind a transaction-mode pooler (PgBouncer `pool_mode=transaction`) the session lock means nothing, so set `SINGLE_INSTANCE=0` there. It also cannot see a 0.15.0 process (which takes no lock) during a mixed-version overlap; a compose deploy never overlaps (stop, then start).
- **Info** (SYNC-6, docs/adr/1924-*) Migration 0047 marks every existing index as current, assuming the 0.15.0 process stopped gracefully (it flushes its queued passes on SIGTERM). An instance that crashed right before the upgrade keeps those few stale pages until they are edited.
- **Info** (SYNC-7, A-M9 note, docs/adr/1921-*) The unload guard makes Hocuspocus re-check connections after it stores, so a DirectConnection that attaches during that store keeps the document loaded; the A-M9 window before the hook runs is unchanged.

## Added in 0.16.0

MCP profiles, resources, prompts and the memory check
- **Low** (MCP-PROF-1, docs/adr/2000-*) A client that only lets the model call listed tools reaches a hidden tool through `more_tools(tool, arguments)`: one extra call for the spec, and the arguments are untyped for the client (the server validates them). `notifications/tools/list_changed` is not sent (stateless server, JSON responses).
- **Low** (MCP-PROF-4, docs/adr/2000-*) `more_tools` flattens a client's per-tool approval: a client that asks the person per tool name sees one tool without hints, and once it is allowed without asking again, every hidden tool runs under that approval — write tools such as restore_version, create_collection, import_folder and upload_file included. Server-side checks (read-only tokens, edit locks, agent edit policy, suggest-only) are unchanged. Use `full` for per-tool approval.
- **Info** (MCP-PROF-5) `more_tools()` and `more_tools(tool)` (index and spec) are not metered in connection usage; a run is metered as the tool it ran.
- **Info** (MCP-PROF-2, docs/adr/2000-*) The profile lives in the client's URL. A proxy that drops the query string gives every connection the full list.
- **Info** (MCP-PROF-3) The list filter and `more_tools` use the SDK's internal request-handler map, like the slim list (MCP-LIST-1); `toolProfiles.test.ts` fails if an SDK upgrade breaks it.
- **Info** (MCP-RES-1, docs/adr/2001-*) resources/list shows at most 50 pages (favorites, then recently changed); titles in the list are cleaned member text outside a wrapper (shown in the client's menu); reading one is metered as a read_page call.
- **Info** (MCP-CHECK-1, docs/adr/2003-*) check_notes: literal links in the middle of a body over 200 KB are not seen (page_texts keeps head and tail); text in code blocks counts; links to pages deleted for good are not reported; near-duplicate titles are found only up to case, punctuation, spacing and word order; a page linked only from someone's private page is "unlinked" for others.
- **Info** (MCP-INSTR-1, docs/adr/2004-*) The instruction-length limit (200 lines, 25 KB) follows another tool's reading limit, not a measured drop in rule following.

Suggest-only connections after flagged content
- **Low** (TAINT-1, docs/adr/2040-*) API tokens are tainted only by the REST routes that return page bodies (`/pages/:id/section`, `/pages/read`, `/context`, `/pages/:id/export`). Routes that also return member text but do not taint: `/workspaces/:id/search` (snippets), `/pages/:id/snapshots/:sid/preview` and `/diff`, `/changes`, `/pages/:id/changes`, `/changes/:seq/diff` (after_text), `/workspaces/:id/activity`, `/pages/:id/comments`, `/pages/:id/collection/query`, `/pages/:id/row`, `/workspaces/:id/templates/:tid/preview`, `/files/:id`, `/api/search` (snippets, 0.17), and vault sync (`/sync/read`, the 412 and replay bodies; this is what keeps vault sync experimental, docs/VAULT-SYNC.md). MCP tools taint per page they read (read_page, read_pages, find_context, diff_versions, read_ink, page resources) and per attachment (read_file), but not changes_since excerpts, comment threads, lists or row reads. The flags themselves exist only for indexed sections and returned attachment text (docs/adr/0977-*, 2046-*).
- **Low** (TAINT-2, docs/adr/2040-*) Comments stay open to a suggest-only connection; a hijacked agent can still post, @mention people (who get a notification) and resolve threads inside the workspace. Each comment names the agent; refusing comments would remove the only way it can report back. Hand-offs to other connections are refused, but a person who reads the comment and passes it on to a clean agent carries the text across.
- **Low** (TAINT-3, docs/adr/2042-*) A workspace admin lifts only sources in their workspace; a connection tainted by another workspace's page stays suggest-only there until its owner lifts it, the window ends, or the admin switches the rule off for the workspace.
- **Low** (TAINT-4) Refused writes of a suggest-only connection are not audited one by one (the agent's answer says so); the audit shows when it became suggest-only and who lifted it.
- **Low** (TAINT-5, docs/adr/2040-*) update_page `append` on a page that rotates its log into subpages appends to the page itself while suggest-only (the subpage cannot be created), as under a suggestions-only lock.
- **Low** (TAINT-6, docs/adr/2003-*, 2040-*) check_notes prints page titles and link text (wrapped as untrusted) but does not taint the connection: like lists and search (TAINT-1), titles are not scanned. Bodies never appear in its output.

Files, uploads and PDFs
- **Low** (FILE-3, docs/adr/2044-*) Reverting an agent's upload removes the link, not the file; files are never garbage-collected (as for a person's deleted image block). `attachOnly` files are in no change feed.
- **Low** (FILE-5, docs/adr/2045-*, 2065-*) An upload larger than the MCP body limit for upload_file calls (base64 of `AGENT_UPLOAD_MAX_MB` + 1 MB) is refused by the HTTP layer with its own 413 before upload_file can name the limit.
- **Info** (UPLOAD-1, docs/adr/2065-*) A workspace that turns agent uploads off does not hide upload_file from the tool list (lists are fixed per profile); the call is refused with `AGENT_UPLOADS_OFF`.
- **Info** (UPLOAD-2, docs/adr/2065-*) Files uploaded through connections before migration 0050 have `uploaded_via` null and do not count toward the daily budget (only matters within 24 hours of the upgrade, and only for 0.16 pre-releases).
- **Info** (PDF-1, docs/adr/2047-*) unpdf 2.x needs Node 24; 0.16 pins 1.9.1 (Node ≥ 22). Upgrade with the image's Node.

Agent connection tokens
- **Low** (AGT-1, docs/adr/2061-*) An agent connection token is a static bearer secret for up to 365 days; there is no IP column and no "last used from" for it (grants never had one). Connected agents per workspace shows when it was last used there.
- **Low** (AGT-2, docs/adr/2063-*) Making one needs only a signed-in session (no password or 2FA re-prompt), as for API tokens (docs/adr/1201-*).
- **Low** (AGT-3, docs/adr/2063-*) The name cannot be changed (the via label of past edits in lists reads the client name); make a new token instead.
- **Low** (AGT-5, docs/adr/2063-*) A token that runs out, and every token deleted by a password reset, leave no `agent.token_revoked` event (the expiry is in `agent.token_created`).
- **Low** (AGT-6, docs/adr/2063-*) An admin's block of one agent token (its client) does not cover the next token the member makes; block "all agents" of the member to stop them all in the workspace.
- **Info** (AGT-4) Real-client checks with Claude Code `--header`, Cursor `headers` and VS Code `inputs` against an `http://` LAN server were not run in this release (the db suite drives `/mcp` over HTTP with the SDK client). OAuth connections to `/mcp?profile=core` from Claude Code, Cursor and VS Code were not tried with the real clients either.

## Added in 0.17.0

Section links and Mermaid diagrams
- **Low** (LINK-1, docs/adr/2100-*, 2102-*) A section link's text and stored names are a snapshot: after a heading (or page) rename the page still shows `Page#Old heading`, and MCP reads print the old name. The link itself follows the heading (block id, name, change log); write it again to refresh the text.
- **Low** (LINK-2, docs/adr/2100-*) Section links reach top-level headings only (sections, ADR 0926). A heading inside a toggle or column is found when clicking an editor-made link, but the backlinks panel and check_notes report it as missing.
- **Low** (LINK-3, docs/adr/2102-*) A section link without a block id (written in Markdown, by an agent or by an import) whose heading was renamed is found only while the change log still holds the rename (`CHANGE_FEED_RETENTION_DAYS`); after that it is `missing`.
- **Low** (LINK-4, docs/adr/2100-*) `[[#Heading]]` (a heading of the same page) and typing `[[Page#Heading|alias]]` as raw text in the editor are not converted; use the `[[Page#` menu and edit the link text for an alias.
- **Low** (LINK-5, docs/adr/2102-*) A section moved to a subpage by split_page leaves its section links `missing` (backlinks, check_notes, click notice); they are not followed to the subpage titled like the heading.
- **Info** (LINK-6, docs/adr/2102-*) A section link to a heading of the same page is not indexed (page_links drops self-links): no backlink, not checked by check_notes; clicking it works.
- **Info** (LINK-7, docs/adr/2100-*) `[[Page|alias]]` without `#` is unchanged: outside vault sync it is still exported as `[[alias]]` and does not resolve on the way back.
- **Info** (LINK-8, docs/adr/2003-*) `[[…]]` inside code blocks counts as a literal broken link in check_notes (page_texts includes code), e.g. Mermaid's `A[[Name]]` subroutine nodes (the existing "code blocks count" limit of MCP-CHECK-1, now more visible).
- **Low** (MMD-1, docs/adr/2104-*, 2191-*) Mermaid diagrams are drawn in the page editor, the row-template editor and on public pages; a page embed (`![[…]]`) in the app, exports and presentation mode of a public page show the ```mermaid code.
- **Info** (MMD-2, docs/adr/2191-*) Presentation mode on a public page shows a Mermaid block as its code (the slides are built from the page's HTML before diagrams are drawn).
- **Info** (MMD-3, docs/adr/2105-*) Diagrams are images: their text is not found by find-in-page and cannot be selected (the code can).
- **Info** (MMD-4, docs/adr/2106-*) The browser's own print (Ctrl/⌘+P) does not wait for diagrams still rendering, and prints the code block too; use "Export as PDF". A dark-theme diagram printed through Export as PDF is colour-inverted, close to but not equal to the light theme.
- **Info** (MMD-5, docs/adr/2105-*) A diagram label containing an inline handler (`<img onerror=…>`) makes Chrome log a CSP "inline event handler" violation while Mermaid's DOMPurify parses it in an inert document. Nothing runs (checked with and without the CSP); the console line is noise a member can cause.
- **Info** (MMD-6, docs/adr/2105-*, 2191-*) While Mermaid lays out a diagram, its temporary SVG is in the page for a moment; an image node in the source (`img:` / image shapes) may be fetched then, as an image block's URL would be, also by a public page's visitor. The shown diagram is an `<img>` data URL with external references removed.

Database views in pages, public pages and the Markdown download
- **Low** (DBVIEW-1, docs/adr/2120-*) Database views are read-only inside a page (no cell edits, new rows, drag or view settings); rows open their page and "Open database" goes to the full view.
- **Info** (DBVIEW-2, docs/adr/2120-*) A tab still running 0.16 or older keeps a database view but shows it as a page card; if it moves or rewrites that block, the view choice is lost and the block shows the database's first view.
- **Low** (DBVIEW-3, docs/adr/2146-*) For a guest, a chart view inside a database view block shows its error (the chart aggregate is member-only, COLL17-5).
- **Low** (DBVIEW-4, docs/adr/2121-*, 2190-*) On public pages a database view's table has no relation titles, no rollups and at most 200 rows; a chart view is its table; query sources of charts, and every chart on a single-page link, stay left out without a placeholder (docs/adr/1605-*). A query block runs with no user inside the link's subtree: `FROM "folder"` and `file.folder` only match when the shared folder is at the top level of its workspace. Sub-items are shown in tree order with `↳` in table and list views.
- **Low** (DBVIEW-5, docs/adr/2122-*) The Markdown download writes at most 1000 rows per database view. Importing a downloaded file into another workspace or instance restores database views and charts that point at ids from the source, so they show "not available" there; the snapshot tables are not imported. A database view the exporter cannot see is left out of the file.
- **Info** (DBVIEW-6, docs/adr/2122-*) PDF export prints the live page: query and chart results appear only if they were loaded (on screen) before printing; database views load at once.
- **Info** (DBVIEW-8, docs/adr/2190-*) On public pages, created by / last edited by show the member's name without the agent connection ("via …"); the member download shows it.

Databases
- **Low** (COLL17-1, docs/adr/2140-*) A row created in a transaction that started before an ID property was added and committed after it stays without a number until the next fields update of that collection.
- **Low** (COLL17-2, docs/adr/2141-*) "Last edited by" changes only with logged changes (properties, title, body); two-way relation mirroring, sheet sync and moves do not change it, while "Last edited time" (`updated_at`) moves with them. Body edits set it when the section index runs (8–30 s).
- **Low** (COLL17-3, docs/adr/2142-*) A 0.16 client shows a view whose filter uses OR / NOT / groups unfiltered, and conditions it adds to such a view are ignored by 0.17 clients (it writes the flat list, the tree wins).
- **Low** (COLL17-4, docs/adr/2140-*) Created/edited time filters compare by the UTC day (as `today` in query_rows); a person east or west of UTC may see a row created late in their evening under the next/previous date.
- **Low** (COLL17-5, docs/adr/2146-*) Guests: chart views and chart blocks of a shared database answer 403 (the chart aggregate is member-only); bulk paste and CSV import into a shared database are refused; a guest with edit cannot assign people. The view tabs' "+" and the new-row button's template items still show for an edit guest (the server refuses them; same as on a locked page).
- **Low** (COLL17-6, docs/adr/2144-*) Duplicating a collection leaves its Parent item pointing at the original collection (the existing relation issue), so the copy has no sub-items until the field is made again.
- **Low** (COLL17-7, docs/adr/2140-*) Rollups can only count automatic values of linked rows.
- **Info** (COLL17-8, docs/adr/2143-*) No files field yet.
- **Low** (COLL17-9, docs/adr/2192-*) query_rows that filters or sorts on an automatic value computes it for every row it scans: 20,000 rows ≈ 111 ms vs ≈ 30 ms on a stored property (p50, local).
- **Info** (COLL17-10, docs/adr/2140-*) Every page inserted under a parent runs the ID trigger (one UPDATE attempt on the parent's collection row): a 20,000-row bulk insert takes about 0.4 s longer (≈ 20 µs a row).

Local trial, setup link and zip imports
- **Low** (SETUP-1, docs/adr/2160-*) The first-admin setup code is printed to stdout. Where container logs go to a service other people can read, the code is readable there until the first account exists. Create the first account right after the first start, or use `deploy/signup-key.sh` (deploy/DEPLOY.md 3-C). No switch to turn the link off yet.
- **Info** (LOCAL-1, docs/adr/2161-*) `deploy/local.sh` binds 127.0.0.1 and uses http; it is for one person's trial. It needs bash, curl and Docker Compose v2 (`!override` needs Compose ≥ 2.24). On Windows run it from WSL or Git Bash. Its default path pulls the published image, so it shows the setup link only once a 0.17 image is published (`--build` builds the checkout).
- **Low** (ZIP-1, docs/adr/2162-*) `import_zip` refuses Notion exports (415 `NOTION_IMPORT_IN_APP`): the Notion importer stores attachments outside the connection upload rules. Use the web app, or `source="markdown"` for plain files.
- **Low** (ZIP-2, docs/adr/2162-*) Reverting a connection's changes does not undo pages it created (page events are not reverted, docs/adr/1620-* .. 1624-*); undo an import by trashing its top page(s). For a zip with several top-level files that is one trash per top page.
- **Info** (ZIP-3, docs/adr/2162-*) Folder and canvas pages from an import have no `page_added` row in the change log (as with every import): changes_since and catch_up show the documents; the folders appear through their documents.
- **Info** (ZIP-4, docs/adr/2162-*) Attachments refused by type or size are skipped; links to them stay as written (relative paths) in the imported pages.

Vault sync (experimental)
- **Low** (VSYNC-1) Read-only API tokens cannot run `inklingctl sync` (the read is a POST).
- **Info** (VSYNC-2) Two devices each keep their own copy of frontmatter Inkling does not store.
- **Low** (VSYNC-3) Images inside table cells are dropped on upload.
- **Info** (VSYNC-4) Pages created by sync do not queue the "new page" webhook and have no `created_via` (the change feed has them).

Versions: AI steps
- **Low** (STEP-1, docs/adr/2180-*) On a large page the chain rule of ADR 1100 still writes a whole row every 10th version, so an agent writing often to a 4 MB page writes (and pruning later deletes) about 4 MB raw per 10 writes. Logs should write child pages (docs/adr/1140-* .. 1142-*) as before. Dropping old steps at the cap merges diffs instead of rebuilding.
- **Info** (STEP-2, docs/adr/2181-*) A conflicting or refused agent write can leave a "Before AI edit" version when someone edited since the last version (it is a real state of the page).
- **Info** (STEP-3, docs/adr/2182-*) Step numbers are computed over the newest 50 rows: once a run's first steps are pruned, its oldest kept step is "AI step 1".
- **Info** (STEP-4, docs/adr/2180-*) Line counts are Markdown lines of the written sections (a replace of a page over 2,000 blocks has none).

search and workspace scope
- **Info** (SEARCH-1, docs/adr/2183-*) search's whole-word test knows letters of Latin, Greek, Cyrillic, Hangul, kana and CJK scripts; letters of other scripts (Arabic, Hebrew, Thai, Devanagari …) count as separators, so a query in those scripts is "whole word" whenever it occurs. Case-insensitive matching of non-ASCII letters still follows the database locale (as ILIKE did).
- **Info** (SEARCH-2, docs/adr/2183-*) Korean whole words allow one fitting particle and one of 는/은/도/만 after it; verb endings and copulas (`해커톤이다`, `배포했다`) are parts of words, and a Japanese or Chinese term is a whole word only next to punctuation or spaces.
- **Info** (SEARCH-3, docs/adr/2183-*) A heading match is found only for pages already matched by title or body text; a heading in the middle of a body over 200 KB (cut in `page_texts`, ADR 1040) is not found by search (find_context sees it).
- **Low** (SEARCH-4, docs/adr/2183-*) A one- or two-character query that matches thousands of pages in one workspace is slower than in 0.16 (all matches are graded before the cut; 5,000 matches ≈ 72 ms vs 51 ms).
- **Info** (SEARCH-5, docs/adr/2184-*) The "more" line names workspaces by id only (names are member text and stay inside the data block); a workspace with matches but none shown has no name in the answer.
- **Info** (SEARCH-6, docs/adr/2183-*) Like the web search route, `GET /api/search` does not record a taint read for its snippets (TAINT-1).
- **Info** (SEARCH-7, docs/adr/2183-*) Each new query term costs one regex compilation on its database connection (≈ 0.5 ms; the word class is written out so the result does not depend on LC_CTYPE).
- **Low** (WS-SCOPE-1, docs/adr/2188-*) find_context without workspaceId still ranks all workspaces together; results of another workspace can take slots. They are labelled (ADR 2185) and the answer says how to narrow, but an agent that ignores the labels can still answer from the wrong workspace. Passing workspaceId (an id or the name) is the fix.
- **Low** (WS-SCOPE-2, docs/adr/2186-*) A workspace name is resolved when the call is made: renaming a workspace changes what a stored name means, and a name prefix that was unique stops resolving when another workspace gets a similar name (the error then lists both). Agents that keep ids are unaffected.
- **Info** (WS-SCOPE-3) `inbox`'s workspaceId takes ids only (built with the shared `uuid()`, whose check is shared with page ids). Other tool descriptions do not mention that names work; the server instructions say it once.
- **Info** (WS-SCOPE-4, docs/adr/2188-*) The several-workspace evaluation has 12 questions; results on them vary run to run by about one question (ties across workspaces). `context-bench.ts` and `context-tune.ts` still build one workspace.
