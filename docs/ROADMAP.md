# Inkling Roadmap

> Goal: a self-hosted notes app that combines Notion (team collaboration, database views) with Obsidian (lightweight, Markdown, your own data).
> The server runs in Docker; you use it through the web/PWA. No per-block or per-member limits.

## M1 — Core skeleton ✅ Done (2026-07-12)

- [x] pnpm monorepo (server / web / shared)
- [x] Sign-up and login (session cookie): verified via the API
- [x] Workspaces + invite codes (e.g. separate personal and team workspaces): verified via the API
- [x] Page tree (create/rename/delete/hierarchy): verified via the API (including a cycle guard)
- [x] BlockNote block editor: slash menu, tables, code blocks (shiki highlighting), checklists, formatting
- [x] **Yjs + Hocuspocus real-time co-editing**: headless E2E passes (two-client bidirectional sync, awareness, rejection of unauthenticated clients, in both dev and production)
- [x] Image/file upload: upload→download byte equality and the auth guard verified
- [x] Dark mode, Pretendard, PWA: manifest/icons/SW build and serving confirmed (installing to the home screen still needs a real-device check)
- [x] Docker Compose (db + app, native ARM64): production image build and startup verified

> Remaining visual check: eyeballing the browser UI (editor/sidebar look and feel). The code passes type checking, builds and contract tests.

## M2 — Markdown & the Obsidian feel ✅ Done (2026-07-12)

- [x] Page → Markdown export / Markdown and zip import (Obsidian-friendly zip conventions)
- [x] Whole workspace → zip (Markdown + images) export
- [x] `[[wiki link]]` autocomplete (internal href convention, converted to `[[]]` on the Markdown round-trip)
- [x] **Right panel**: outline (table of contents), backlinks, outgoing links, tags, properties; collapsible sections + panel toggle
- [x] **Explorer conveniences**: collapse/expand sidebar (⌘\), create folders (kind=folder), auto-reveal the current page, collapse all
- [x] Drag to reorder/move pages (dnd-kit + move modal), trash (restore/permanent delete)
- [x] Title search + ⌘K modal (→ full-text search later)

## M3 — Notion database views ✅ Done (2026-07-12)

- [x] Collections (property schema: text/select/date/checkbox/person)
- [x] Table view (sort, filter, inline editing)
- [x] Kanban view (drag to move)
- [x] Row = page (opens as a document)

## M3.5 — Canvas (Obsidian JSON Canvas compatible) ✅ Done (2026-07-12)

- [x] kind='canvas' pages: React Flow infinite canvas (text cards, page link cards, edges)
- [x] Yjs real-time collaboration (reusing the existing Hocuspocus)
- [x] `.canvas` (JSON Canvas 1.0) export/import: opens as-is in Obsidian
- [x] Dark mode, minimap/zoom controls

## M4 — Fully automated integrations (+ CLI) ✅ Done (2026-07-12)

- [x] Obsidian: one button/CLI command places Markdown + images into the vault folder (`inklingctl pull`)
- [x] Notion: one-click page upload through the Notion API (block mapping, images included); real-account upload works once NOTION_TOKEN is set (dryRun verified)
- [x] Round-trip pipeline: to Notion when a contest ends, to Obsidian for personal notes

## M5 — Operations (deploy pack ✅ ready in deploy/)

- [x] Deploy to an ARM64 VM: same image as-is (multi-arch)
- [x] Caddy HTTPS + domain overlay (`deploy/compose.caddy.yaml`)
- [x] Backups: verified backup sidecar with GFS retention, encryption and off-site copies ([BACKUP.md](BACKUP.md))
- [ ] Invite links (a URL instead of a code), member management UI

## M6 — Shared/private sections + UX pass ✅ Done (2026-07-12)

- [x] Sidebar shared (👥) / private (🔒) sections: private pages are completely invisible to anyone but the author (filtered everywhere: lists, search, backlinks, export, collaboration connections)
- [x] Rules for moving between sections (children inherit; making someone else's subpage private is blocked): drag, move modal, right-panel switch
- [x] Drag from sidebar → drop into the body = insert a wiki link; drop onto a canvas = page card
- [x] UI motion polish: page transitions, sidebar, right panel, modals, accordions; respects prefers-reduced-motion

## M7 — Better search and linking ✅ Done (2026-07-12)

- [x] Full-text body search (page_texts + pg_trgm, ⌘K snippets and highlighting, tag clicks wired in)
- [x] Graph view (/graph, d3-force + React Flow, page_links, private-page visibility filter)

## Security, load and socket hardening ✅ Done (2026-07-12)

Fixed the CONFIRMED items from a three-axis adversarial audit:
- [x] Security: blocked inline SVG XSS (nosniff/CSP/attachment), page visibility for file downloads (an M6 gap) + purge cleanup, login/sign-up rate limits, canvas link scheme validation
- [x] Sockets: authentication at WS upgrade time + maxPayload 2MB + per-IP connection cap (+ protection against crashes on oversized frames), Fastify timeouts, trustProxy tuning
- [x] Load: streaming export (prevents OOM) + total-size guard, 8 indexes on hot columns, import limits tuned for small hosts, compose mem_limit, DB port bound to loopback

## M8 — Invite links · member management · version history ✅ Done (2026-07-12)

- [x] Invite links (/join/:code, respects the login `next`) + code regeneration, sidebar "Copy invite link"
- [x] Member management modal (change role, remove, leave, last-owner guard), cleanup of departed members' private pages (audit L3)
- [x] Version history: Yjs snapshots (automatic every 10 minutes + manual), restores propagate live through DirectConnection (verified with a real editor), history section in the right panel
- [x] Bug fix: body-less POSTs (logout, regenerate, restore) sent with Content-Type json and an empty body returned 500, a latent bug → empty-JSON parser

## M10 — Keyboard & convenience pass ✅ Done (2026-07-12)

- [x] Keyboard selection/navigation in the tree (↑↓←→ Enter F2), selection decoupled from the open page
- [x] ⌘⌫ (Mac) / Del (Windows) deletes → trash + undo toast (fixes a user-reported bug)
- [x] Row right-click context menu (shares the ⋯ actions), shortcut help (?), top breadcrumb
- [x] Platform handling: Mac ⌘/⌫ and Windows Ctrl/Del automatically (key handling via metaKey‖ctrlKey, labels via the shortcut() helper)

## M9 — Calendar view · daily notes · templates (duplication) ✅ Done (2026-07-12)

- [x] Collection calendar view: month grid, placement by date field, drag chips to change the date (dnd-kit)
- [x] Daily notes: 📅 Today button (automatically creates a YYYY-MM-DD page in your private daily folder)
- [x] Page duplication: recursively duplicates descendants + document state + props + collections (fields/views); "Duplicate" in the ⋯/right-click menu

## M11 — Cheap quality-of-life wins ✅ Done (2026-07-13)

- [x] Favorites/bookmarks: toggle, sidebar ⭐ section, star in the top bar and ⋯ menu (bookmarks table)
- [x] Emoji icon picker (250 curated, zero dependencies), cover images (upload→coverUrl)
- [x] Command palette ⌘P/Ctrl+P: actions + page shortcuts
- [x] Global tag index: a store hook fills page_tags, /tags page, case-insensitive merging

## M12 — Obsidian identity ✅ Done (2026-07-13)

- [x] Page embeds ![[transclusion]]: custom block + read-only second provider; safe on the server export round-trip (unknown blocks are silently dropped, no crash, demonstrated)
- [x] Aliases: [[alias]] resolution and search matching, chip editing in the right panel
- [x] Unlinked mentions: page_texts ILIKE title/alias MINUS page_links, right-panel section
- [x] Local graph: reuses useGraph, N-hop neighbors of the current page, embedded in the right panel

## M13 — Notion-style collaboration ✅ Done (2026-07-13)

- [x] Inline comments: block-anchored threads/replies/resolve, right-panel section + 💬 badge, REST polling (15s)
- [x] @mentions: custom inline (user chip/page link), @ autocomplete (members + pages), safe on the server round-trip (dropped)
- [x] Notifications: comments/notifications tables, 🔔 bell + unread count, comment/comment_mention creation and read state

## M14 — Formatting blocks ✅ Done (2026-07-13)

- [x] Toggle lists and quotes: BlockNote built-ins (toggleListItem/quote) exposed in the slash menu, native round-trip
- [x] Callouts: 5 custom block types (note/tip/warning/danger/info), type switching, no server crash (dropped)
- [x] Template variables: POST /pages/:id/instantiate ({{date}}/{{time}}/{{title}} substitution), isTemplate toggle, gallery modal, lossless duplicate when there are no variables — replaced by structure templates and the template gallery (ADR 0920–0925)

## M15 — Public web sharing ✅ Done (2026-07-13)

- [x] Read-only public link /s/<token>: pages.shareToken, owner publishes/stops, unauthenticated viewer (standalone page without a sidebar)
- [x] Security: token-only access, private pages cannot be shared, no internal ids/links leak (wiki links replaced with text), strict CSP, only referenced files are public
- [x] Folder sharing (2026-09-23): a single folder link publishes the live subtree (excluding private and trashed pages), HMAC refs (no internal ids leak), only wiki links inside the subtree become public links, left tree / top drawer on phones in the viewer

## M16 — True real-time collaboration ✅ Done (2026-07-13)

- [x] Comments appear instantly: Hocuspocus stateless broadcast (page document channel {t:comments}), polling→instant
- [x] Notifications appear instantly: per-user inbox:<userId> channel ({t:notifications}), subscribing to someone else's inbox is blocked
- [x] Inbox documents are excluded from page_docs, snapshots and indexing (UUID chokepoint guard)

## M17 — Productivity: due-date reminders ✅ Done (2026-07-13)

- [x] Due-date reminders: collection rows whose date field is due today → notify author and assignees (deduped once a day), M16 real-time push
- [x] Due-soon dashboard /w/:ws/due (today/this week), ⏰ reminders in the bell, entry points from the command palette and sidebar
- [x] Bug fix: with the container on UTC, the server's "today" disagreed with the users' local date and reminders misfired → the server uses `TZ` (configurable)

## M18 — Workspace-wide calendar ✅ Done (2026-07-13)

- [x] Global calendar /w/:ws/calendar: aggregates every collection row (date field) + daily notes into one monthly grid
- [x] Event chips (colored by type), click to navigate, clicking an empty date creates/opens that day's daily note (shared useDailyNote hook)
- [x] Sidebar 📆 Calendar (separate from the daily Today button), non-daily titles excluded, visibleTo, month range
- [x] Completed (2026-09-23): dated checklists inside documents (page_tasks index + backfill), week view, type filter, empty-date popover (task/new page/daily), drag chips to reschedule (rows/pages/tasks), redesigned due section (overdue/today/tomorrow/this week/30 days/done, check + undo, quick add, sidebar badge), task reminders

## M19 — Obsidian settings port + PWA conveniences (2026-09-23)

- [x] Settings screen /w/:ws/settings (⌘, · sidebar ⚙ · palette): per-device localStorage (lib/prefs, applied instantly via usePrefs)
- [x] Editor: readable line length (off = full width; per-page full width takes precedence), spell check (spellcheck), word count status bar (1-second debounce)
- [x] Files and links: startup page (last/home, first visit only), new page location (top level/child/same folder → ⌘N and sidebar), link previews (hover 500ms, Markdown export cache)
- [x] Trash: confirm before deleting (off by default): a shared ConfirmDialog for the tree menu, ⌘⌫ and multi-delete
- [x] Appearance: zoom 80–130% (root font-size; CSS zoom was rejected because it skews popover/drag coordinates), theme
- [x] Shortcuts: ⌘⌥←/→ back/forward, ⌘O quick switcher (titles), ⌘⇧F global search, ⌘N/⌘⌥N new page, ⌘G graph, F2 title, ⌘; properties, ⌘L checkbox, ⌘D delete block
- [x] Palette: yesterday/today/tomorrow daily notes, random page, right panel, trash, back/forward, reload
- [x] PWA: ← → buttons in the top bar in standalone mode (disabled based on history idx), external links open in a new window, safe-area, overscroll and double-tap-zoom prevention, manifest id/scope

## Later

- [ ] **Incremental Rust backend (collab server on yrs first).** Why: the collaboration server's
  store path (Yjs ⇄ document conversion, index extraction, bytea transport) is the heaviest
  per-edit work in server memory and CPU, and `yrs` is the Yjs-compatible Rust implementation, so
  that piece can move without touching clients. Incremental: keep the existing Postgres schema and the WebSocket protocol, port
  one service at a time, and decide each step on measurements. Notes: [ADR 0759](adr/0759-hardware-cache-hot-loops-measured-and-rust-notes.md).
