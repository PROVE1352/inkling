# Inkling API Contract (M1)

The shared contract between the server and web agents. **This document is the source of truth**: implementations must not diverge from it.
Request validation schemas and DTO types are defined in `@inkling/shared` (packages/shared/src/index.ts), and both sides import them. 한국어: [API.ko.md](API.ko.md).

## Common rules

- Every REST endpoint uses the `/api` prefix with JSON in and out. Exceptions: `GET /files/:id` (binary), `WS /collab` (Hocuspocus).
- Authentication: session cookie `inkling_sid` (httpOnly, SameSite=Lax, Path=/, 30 days, Secure when `COOKIE_SECURE=1`). The server stores only the SHA-256 of the token (docs/adr/1060-*).
- Cross-site check: a non-GET/HEAD/OPTIONS `/api` request without an `Authorization` header whose `Origin` (else `Referer`) is not `PUBLIC_URL`/`APP_URL` → 403 `CROSS_SITE_REQUEST`. Clients sending neither header (CLI, curl) are allowed. The `/collab` WebSocket upgrade is checked the same way (docs/adr/1062-*).
- Error response format: `{ "error": { "code": string, "message": string } }` (`ApiErrorBody`).
  - Codes: `UNAUTHORIZED`(401), `FORBIDDEN`(403), `NOT_FOUND`(404), `VALIDATION`(400),
    `EMAIL_TAKEN`(409), `INVALID_CREDENTIALS`(401), `INVALID_CODE`(404), `INVALID_RESET`(400),
    `EMAIL_NOT_VERIFIED`(403), `DELEGATED_ACCOUNT`(400), `RATE_LIMITED`(429, `Retry-After`),
    `MAIL_DISABLED`(501), `MAIL_FAILED`(502), `CROSS_SITE_REQUEST`(403), `INVALID_TOTP_CODE`(401),
    `TOTP_CODE_REUSED`(401), `TOTP_CHALLENGE_EXPIRED`(401), `TWO_FACTOR_ALREADY_ON`(409), `TWO_FACTOR_UNAVAILABLE`(501),
    `PAYLOAD_TOO_LARGE`(413), `UNSUPPORTED_TYPE`(415), `INTERNAL`(500).
  - `message` is English. Clients localize by `code`; the web app translates known codes (and some exact messages)
    and falls back to `message` otherwise. Do not match on message text.
- Permission model: every workspace operation requires being a **member**. Pages and files are authorized through the workspace they belong to.

## Localization

- Supported locales: `en`, `ko`. The operator can set `DEFAULT_LOCALE` (`en` | `ko`; the server falls back to `en` when it is unset).
- The web client sends `Accept-Language: <ui locale>` on every API request.
- **Server-generated content** (built-in templates, default titles of pages the server creates such as the Tasks document,
  default collection fields and views, the sign-up workspace name) uses the user's saved locale, else `Accept-Language`,
  else `DEFAULT_LOCALE`.
- **Emails** use the recipient's saved locale, else `DEFAULT_LOCALE`.
- Error `message`s are not localized (see [Common rules](#common-rules)).
- Related endpoints: `GET /api/auth/mode` (`defaultLocale`), `GET /api/auth/me` (`user.locale`), `PATCH /api/auth/me/locale` (see [Auth](#auth)).

## Auth

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/auth/mode` | - | `AuthModeDTO` `{ delegated, delegatedName, delegatedEmailDomain, signupKeyRequired, mailEnabled, emailVerificationRequired, defaultLocale }` (no auth required). `defaultLocale: 'en' \| 'ko' \| null` is set only when the operator configured `DEFAULT_LOCALE` (otherwise `null`, and the browser language decides) |
| POST | `/api/auth/register` | `registerSchema` | `{ user: UserDTO }` + Set-Cookie. Email is normalized to lowercase. Duplicate → 409 `EMAIL_TAKEN`. Sign-up automatically creates a personal workspace named after the user (the user is its owner; name in the [request locale](#localization)). If there are no admins yet, this user becomes the admin (bootstrap). Mail enabled → a verification email is sent. In enforced-verification mode there is no session: `{ user, verificationRequired: true, mailSent }`. Email in the delegated domain → 400 `EMAIL_RESERVED`. Bad sign-up key → 403 `INVALID_SIGNUP_KEY`. |
| POST | `/api/auth/login` | `loginSchema` | `{ user: UserDTO }` + Set-Cookie. Failure → 401 `INVALID_CREDENTIALS` (never reveal whether the email exists; same message). Unverified account in enforced-verification mode (only when the password is correct) → 403 `EMAIL_NOT_VERIFIED`. If there are no admins, bootstrap promotion applies. |
| POST | `/api/auth/login/totp` | `{ challenge, code }` | Second step for accounts with two-step verification: `POST /api/auth/login` then returns `200 { totpRequired: true, challenge }` without a cookie. `code` is a 6-digit app code or a recovery code. `{ user: UserDTO, recoveryCodeUsed }` + Set-Cookie. 401 `INVALID_TOTP_CODE` / `TOTP_CODE_REUSED` / `TOTP_CHALLENGE_EXPIRED` (5 minutes or 5 failures). 10/min (docs/adr/1061-*) |
| GET | `/api/auth/2fa` | - | `{ enabled, pending, recoveryCodesLeft, available }`. Browser session, local accounts only (also for the other `/auth/2fa*` routes). |
| POST | `/api/auth/2fa/setup` | `{ password }` | `{ secret, uri }` (otpauth://). 409 `TWO_FACTOR_ALREADY_ON`, 501 `TWO_FACTOR_UNAVAILABLE` without `APP_SECRET_KEY`. |
| POST | `/api/auth/2fa/enable` | `{ code }` | `{ recoveryCodes }` (10, shown once). |
| POST | `/api/auth/2fa/disable` | `{ password, code }` | `{ ok: true }` |
| POST | `/api/auth/2fa/recovery-codes` | `{ password, code }` | `{ recoveryCodes }` (replaces the old set). |
| POST | `/api/auth/logout` | - | 204 + cookie cleared. The session row is deleted. |
| GET | `/api/auth/me` | - | `{ user: UserDTO }` / 401. Includes `origin`, `emailVerified` (true for delegated accounts), `locale: 'en' \| 'ko' \| null` (saved UI/email language; `null` = automatic), `twoFactor` (two-step verification on), `sidebar: SidebarPrefsDTO` (sidebar menu order / hidden menus, see [Sidebar menus](#sidebar-menus-per-user-docsadr1020-); `{ order: [], hidden: [] }` when never customized), and `pendingResetRequests` for admins. |
| PATCH | `/api/auth/me/locale` | `{ "locale": "en" \| "ko" \| null }` | `{ "locale": "en" \| "ko" \| null }`. Requires a session. Saves the account's UI and email language (`null` = automatic: browser language / `DEFAULT_LOCALE`). Anything else → 400 `VALIDATION`. |
| POST | `/api/auth/reset-password` | `resetPasswordSchema` `{ email, code, newPassword }` | `{ ok: true }`. Code = a reset code from an admin or automatic email (single use, 24h), or the **maxUses=1** sign-up key that person registered with. On success all of that account's sessions are deleted, remaining codes are revoked and pending requests are resolved. Failure (unknown account, delegated account, wrong code alike) → 400 `INVALID_RESET` with the same message. 10/min + blocking on accumulated failures. |
| POST | `/api/auth/forgot-password` | `forgotPasswordSchema` `{ email, note? }` | Always `{ ok: true }` (never reveal whether the account exists). Only existing accounts are processed: verified email + mail enabled → a reset code email is sent automatically (in the background, at most one per 5 minutes). Otherwise (unverified, mail disabled, delegated account) → merged into a single pending row in `password_reset_requests` (refreshed at most once a minute). Input without `@` is treated as a delegated ID. 5/min. |
| POST | `/api/auth/change-password` | `changePasswordSchema` `{ currentPassword, newPassword }` | `{ ok: true }`. Cookie sessions only (bearer → 403). Delegated account → 400 `DELEGATED_ACCOUNT`. Wrong current password → 400 `INVALID_PASSWORD`. All other sessions are deleted; only the current one remains. |
| POST | `/api/auth/verify-email` | `{ token }` | `{ ok: true, email }`. Token is single use, 24h, and the email at send time must equal the account's email. Invalid → 400 `INVALID_TOKEN`. |
| POST | `/api/auth/verify-email/send` | (cookie session) or `{ email, password }` | `{ ok: true, alreadyVerified? }`. Resend the verification email. Mail disabled → 501 `MAIL_DISABLED`. One per minute (429). |

- Password rule: 8–100 characters (`newPasswordSchema`).
- Brute-force protection: failures on the auth routes above, MCP OAuth and public share tokens are counted per IP; over the limit →
  429 `RATE_LIMITED` + `Retry-After` (uniform wording). Per account there is only backoff (no lockout). Full policy:
  deploy/DEPLOY.md 3-F.

## Sidebar menus (per user, docs/adr/1020-*)

Which top-of-sidebar menus a person shows and in what order, stored on the account (`users.sidebar_prefs`, migration
0033) so every device matches. Browser sessions only: no cookie → 401, an agent's bearer token → 403.

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/me/sidebar` | – | `SidebarPrefsDTO { order: string[], hidden: string[] }`; `{ order: [], hidden: [] }` when never customized (also returned as `user.sidebar` by `GET /api/auth/me`). |
| PUT | `/api/me/sidebar` | `sidebarPrefsSchema` `{ order, hidden }` | The stored value. Replaces the whole value; both lists empty = back to the default (stored as NULL). Ids match `^[a-z][a-z0-9-]{0,31}$`, at most 32 per list, duplicates dropped (first kept); anything else → 400 `VALIDATION` and nothing changes. |

- Built-in ids in default order (`SIDEBAR_MENU_IDS`): `search, later, threads, graph, tags, shared, due, calendar, activity, today` (`later` and `threads` since v0.11.0).
- The server validates the shape, not the vocabulary: well-formed ids it does not know are stored. Clients ignore
  unknown ids when drawing and keep them when saving. A known id missing from `order` (a menu added later) shows at
  its default position, right after the menu that precedes it by default; ids in `hidden` are not shown.

## Admin (`requireAdmin`: cookie session + `isAdmin`, bearer 403)

| Method | Path | Body | Response |
|---|---|---|---|
| DELETE | `/api/admin/users/:id/2fa` | - | `{ ok, wasOn }`. Turns off the member's two-step verification and signs out their sessions. `GET /api/admin/users` rows carry `twoFactor`. |
| GET | `/api/admin/signup-keys` | - | `{ keys: SignupKeyDTO[] }` newest first, including the users who signed up with each key. `SignupKeyDTO.id` is the key hash; `key` is the raw key only while it can still be revealed (unused and sealed), else null; `keyHint` shows the last characters (docs/adr/1110-*) |
| POST | `/api/admin/signup-keys` | `createSignupKeySchema` | `{ key: SignupKeyDTO }` |
| DELETE | `/api/admin/signup-keys/:key` | - | `{ ok: true }` (accounts that signed up with it are kept) |
| POST | `/api/admin/signup-keys/:key/send-invite` | `{ to }` | `{ ok: true }` invite email (`/register?key=`). `:key` here and in DELETE is the id or the raw key; a key that can no longer be revealed 409 `KEY_NOT_REVEALABLE`. Mail disabled 501, failure 502 `MAIL_FAILED`. 20/min |
| GET | `/api/admin/users` | - | `{ users: AdminUserDTO[] }` newest sign-ups first. Includes `signupKeyRecovery` (holds a single-use sign-up key) and `emailVerifiedAt` |
| PATCH | `/api/admin/users/:id` | `setAdminSchema` | `{ user: { id, isAdmin } }`. Revoking yourself or the last admin → 400 |
| DELETE | `/api/admin/users/:id` | - | `{ ok: true }` forced account deletion. Content is kept via SET NULL, sessions and memberships cascade, the sign-up key's used_count −1 (floor 0). Yourself or the last admin → 400 |
| POST | `/api/admin/users/:id/temp-password` | - | `{ password }` (shown once). Deletes all of that user's sessions, resolves pending requests. Delegated account 400 `DELEGATED_ACCOUNT`, yourself 400 |
| POST | `/api/admin/users/:id/reset-code` | - | `{ code, expiresAt }` (shown once, 24h, only SHA-256 stored in the DB). Revokes previous codes, deletes all sessions, resolves pending requests. Delegated account or yourself 400 |
| POST | `/api/admin/users/:id/send-credential` | `sendCredentialMailSchema` `{ to, kind: 'reset-code'\|'temp-password', secret }` | `{ ok: true }`. Sent only after the server confirms the secret is currently valid for that user. 20/min |
| POST | `/api/admin/users/:id/send-verification` | - | `{ ok: true }` verification email to the account's email. Already verified 400 |
| POST | `/api/admin/users/:id/verify` | `{ verified?: boolean }` | `{ user: { id, emailVerifiedAt } }` manually mark as verified (false unmarks) |
| GET | `/api/admin/reset-requests` | - | `{ requests: ResetRequestDTO[] }` newest 200 |
| POST | `/api/admin/reset-requests/:id/dismiss` | - | `{ ok: true }` pending → dismissed. Missing or already handled 404 |
| GET | `/api/admin/ip-bans` | - | `IpBansResponseDTO` `{ bans, yourIp, yourIpAllowlisted, allowlist, policy }` |
| POST | `/api/admin/ip-bans` | `manualBanSchema` `{ ip, minutes, reason? }` | `{ ok, ip, bannedUntil }`. Allowlisted IP or your own IP → 400 |
| DELETE | `/api/admin/ip-bans/:id` | - | `{ ok: true }` lifts the active ban on that IP (the escalation level is kept) |

## Workspaces

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/workspaces` | - | `{ workspaces: WorkspaceDTO[] }` (those you are a member of, including role and `can`, docs/adr/0945-*). An MCP connection blocked in a workspace does not see it (docs/adr/0947-*). `inviteCode` is '' unless you are an owner, or an admin while the invite link is on |
| POST | `/api/workspaces` | `createWorkspaceSchema` | `{ workspace: WorkspaceDTO }` (invite code generated automatically, you are the owner) |
| POST | `/api/workspaces/join` | `joinWorkspaceSchema` | `{ workspace: WorkspaceDTO }`. Codes are compared after uppercase normalization. Unknown code, or the invite link turned off → 404 `INVALID_CODE`. Already a member → plain 200 (idempotent). Audited as `member.joined`. |
| GET | `/api/workspaces/:id/members` | - | `{ members: MemberDTO[] }` |
| PATCH | `/api/workspaces/:id` | `renameWorkspaceSchema { name?, icon? }` (icon ≤ 16 chars, null clears; at least one field) | `{ workspace: WorkspaceDTO }`: **owner only** (otherwise 403). Audited as `workspace.updated` |

- Invite codes: uppercase letters + digits from the alphabet `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (confusable characters removed), length 10, crypto random. Retried up to 3 times on a unique collision.

## Pages

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/workspaces/:id/pages` | - | `{ pages: PageMetaDTO[] }`: only `deleted_at IS NULL`, sorted `sortOrder asc, createdAt asc`. The client assembles the tree from `parentId`. |
| POST | `/api/pages` | `createPageSchema` | `{ page: PageMetaDTO }`. If `parentId` is given it must be a live page in the same workspace (otherwise 400 VALIDATION). `sortOrder` = max among siblings + 1000. |
| PATCH | `/api/pages/:id` | `updatePageSchema` | `{ page: PageMetaDTO }`. When `parentId` changes: same workspace, not itself, **not into its own descendants** (cycle prevention via a parent-chain check). Updates `updatedAt`. |
| DELETE | `/api/pages/:id` | - | 204. Soft delete: sets `deleted_at` on the page and all its descendants (recursive CTE). |

## Files

| Method | Path | Input | Response |
|---|---|---|---|
| POST | `/api/files?workspaceId=<uuid>&pageId=<uuid>` | multipart field `file` (one) | `{ file: FileDTO }`: `url` is `/files/<id>`. `pageId` is required for bearer tokens since 0.16 (see "v0.16.0 additions") |
| GET | `/files/:id` | - | Binary stream. Headers: Content-Type from the row's `mime`, `Content-Disposition: inline; filename*=UTF-8''<encoded>`, `Cache-Control: private, max-age=31536000, immutable`, ETag=id. Unauthenticated 401; not a member or guest of the file's workspace, or a page file you cannot see: 404, the same as an unknown id (docs/adr/1301-*). |

- Physical storage: `DATA_DIR/uploads/<id>` (the bare id, no extension). Size limit 25MB (413 above).
- Allowed MIME types: `image/*`, `application/pdf`, `video/mp4`, `video/webm`, `audio/mpeg`, `audio/mp4`, `audio/wav`, `text/plain`; anything else 415.

## Collab (real-time co-editing)

- `WS /collab`: Hocuspocus protocol. `documentName` = page UUID.
- Authentication: the session is determined from the upgrade request's **cookie** (the provider's token value is ignored, but the client sends a dummy `token: 'cookie'` so Hocuspocus runs the onAuthenticate hook).
- Authorization: documentName must be a UUID, a live page, and the user must be a member of its workspace. Otherwise the connection is refused.
- Persistence: Yjs state is saved to `page_docs.state` (bytea) with a debounce (2s, max 10s). Saving also updates `pages.updated_at`.

## Misc

- `GET /api/health` → `{ ok: true }` (no auth required)
- Every `/api` response carries `X-Inkling-Build: <id>` (the id in `WEB_DIST/build.json`; absent when unknown). A client whose own build differs shows the update banner or reloads (docs/adr/0990-0993).
- `GET /api/version` → `{ build: string | null, version: string, updateMode: 'prompt' | 'force' }` (no auth required)
- `GET /api/version/latest` (admin) → `{ enabled, current, latest: { version, url } | null, updateAvailable }`; `enabled: false` unless `UPDATE_CHECK=github` (docs/adr/0994-*)
- Production (Docker): serves `WEB_DIST` statically + SPA fallback (GET requests outside `/api`, `/files`, `/collab` → index.html)

---

# M2 additional contract (Markdown round-trip · wiki links · trash · search)

## Wiki link representation (convention shared by server and web)

- Wiki links in documents are **standard BlockNote `link` inlines** whose href is an internal path: `/w/<workspaceId>/p/<pageId>`
  (no custom inline type, so Markdown conversion and server parsing work without extending the schema).
- On Markdown **export**, internal links become `[[Title]]` (title = link text).
- On Markdown **import**, `[[Title]]` is resolved to an internal link by title match: ① pages in the same import batch ② live pages in the workspace (case-insensitive, most recent updatedAt first). Unresolved links stay as the literal text `[[Title]]`.
- Backlink index: on document save (store), internal href patterns are extracted from the blocks and `page_links(source_page_id, target_page_id)` is synced (delete all then reinsert, distinct, self-references excluded; the store itself succeeds even if this fails).

## Pages additions

| Method | Path | Response |
|---|---|---|
| GET | `/api/pages/:id/backlinks` | `{ pages: PageMetaDTO[], sections? }`: live pages that link to this page (membership checked, updatedAt desc). `sections` (0.17, only when a source has section links): see "v0.17.0 additions" |
| POST | `/api/pages/:id/restore` | `{ page }`: sets `deleted_at=null` on the page and its descendants. If the parent is still deleted, `parentId=null` (moved to the root). 400 if the target is not deleted |
| DELETE | `/api/pages/:id/purge` | 204: hard delete (cascade). Allowed **only for deleted (trashed) pages**, otherwise 400 |
| GET | `/api/workspaces/:id/trash` | `{ pages: PageMetaDTO[] }`: all deleted pages (flat), deletedAt desc |
| GET | `/api/workspaces/:id/search?q=` | `{ pages: PageMetaDTO[] }`: title ILIKE substring match (escaped), live pages only, limit 20, updatedAt desc. Empty q → empty array |

## Export / Import

| Method | Path | Input/Output |
|---|---|---|
| GET | `/api/pages/:id/export?format=md` | `text/markdown; charset=utf-8` attachment (single page, children excluded). Image links keep their absolute `/files/...` paths. `notation=plain` (default) \| `agent` \| `file` (0.17, see "v0.17.0 additions") |
| GET | `/api/pages/:id/export?format=zip` | zip: the page + its subtree. Structure follows the convention below. Pages are written with `notation=file` unless `notation=plain` (0.17) |
| GET | `/api/workspaces/:id/export` | zip: the whole workspace tree, `notation=file` unless `?notation=plain` (0.17) |
| POST | `/api/workspaces/:id/import?parentId=<uuid?>&source=<auto\|markdown\|notion?>` | multipart `file` = a single `.md` or a `.zip` (≤ `IMPORT_MAX_UPLOAD_MB`, default 25). Response `{ pages: PageMetaDTO[] }` (created pages, in creation order). A Notion export (`source=notion`, or a zip detected as one when `source` is omitted) responds `{ pages, report }`, see [Notion export import](#notion-export-import). `source=notion` with a non-zip file → `415` |

### zip convention (Obsidian-friendly)

```
assets/                  ← all images and files (file name: <fileId><extension inferred from mime>)
Page Title.md
Page Title/              ← a page with children gets a folder of the same name (alongside the file)
  Child Title.md
```

- File name sanitizing: remove `/ \ : * ? " < > |` and control characters, trim; an empty title → `Untitled` (localized); duplicates in the same folder → ` (2)`, ` (3)`…
- Markdown frontmatter: only two lines, `inkling-id: <uuid>` and `updated: <ISO>`.
- Image/file links in Markdown inside the zip are rewritten to relative `assets/<fileId><ext>` paths. Import reverses this (upload assets → rewrite to `/files/<newId>`).
- Import: folder structure = parent relationships. The frontmatter `inkling-id` is **ignored and a new page is always created** (avoids id collisions; M2 scope).
- An imported page's document is stored via `blocksToYDoc` → `Y.encodeStateAsUpdate` → `page_docs.state`. This is a one-time initialization before any collaboration starts, so it is safe.

### Notion export import

Notion → Settings → Export (or a page's ⋯ → Export) → **Markdown & CSV**, include subpages, create
folders for subpages; upload the downloaded zip as is (docs/adr/0960-*).

- Ids (` <32 hex>`) are removed from titles; `Title.md` + folder `Title/` = one page with children;
  sibling title collisions get ` (2)`. The leading `# Title` line becomes the title.
- `X_all.csv` (preferred over `X.csv`) → a collection with a table view; first column = row title;
  fields typed checkbox / number / date / URL / select / multi-select / relation (rows of one
  database in the same import), everything else text. Row pages in the database folder become the
  rows' documents (their property lines are removed).
- Relative links to `.md` / `.csv` / folders and notion.so URLs → internal links; referenced
  images and files are uploaded. Unresolved links keep their href.
- Callouts → quotes, `$$` equations → `latex` code blocks, inline `$x$` → inline code.
- Nested part archives (`Export-…-Part-N.zip`) are unpacked one level deep.
- All-or-nothing: on failure the created pages and uploaded files are removed.

`report`:

```ts
{ source: 'notion', detected: 'explicit' | 'auto',
  pages, documents, folders, collections, rows, attachments: number,
  links: { total, resolved },             // relative links, attachment paths, notion.so URLs
  brokenLinks: { page, href }[], brokenLinkCount,   // lists capped at 200, counts exact
  skipped: { path, reason }[], skippedCount,         // view CSVs, unreferenced attachments, …
  renamed, callouts, equations: number }
```

## Page kinds (kind) — M2

- `pages.kind`: `'doc' | 'folder' | 'canvas'` (default doc). `createPageSchema` gains `kind?` and `title?`.
- **folder**: no document (no collaboration connection). Used to organize the tree. Exported as a directory only; on import, a directory without a Markdown file → a folder page.
- **canvas**: implemented in M3.5 (JSON Canvas). The M2 server only needs to store and return kind.
- PageMetaDTO includes `kind`, returned in every page response.

---

# M3 contract — Collections (Notion-style databases)

Types and validation schemas come from the M3 section of `@inkling/shared` (collectionFieldSchema, viewConfigSchema, updateFieldsSchema, createViewSchema, updateViewSchema, updatePropsSchema, CollectionDTO, CollectionViewDTO, RowDTO).

## Model

- **A collection = a page with kind='collection'.** Field definitions live in `collections` (pageId pk, fields jsonb), views in `collection_views`.
- **A row = a live child page of the collection page** (kind is usually doc). Property values are in `pages.props` jsonb `{ fieldId: value }`.
- Value shapes: text/url→string, number→number, checkbox→boolean, date→'YYYY-MM-DD' string, select→optionId string, multiSelect→optionId string[], person→userId string.
- The page tree (GET pages) also returns the collection's children (rows) as-is; **the web app hides them when assembling the tree if the parent is a collection.**

## Endpoints

| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/api/pages` (kind='collection') | existing createPageSchema | On creation the server automatically creates: a `collections` row (default fields: Status (select: To do (gray) / In progress (blue) / Done (green)), Assignee (person), Due (date)) + a default table view ("Table"). Names follow the [request locale](#localization) |
| GET | `/api/pages/:id/collection` | - | `{ collection: CollectionDTO, rows: RowDTO[] }`: 400 if the target is not of kind collection. rows are live children (sortOrder asc), with props |
| PUT | `/api/pages/:id/collection/fields` | `updateFieldsSchema` | `{ collection }`: full replacement. Duplicate field id → 400. Orphan values of deleted select options are not cleaned up (ignored when rendering) |
| POST | `/api/pages/:id/collection/views` | `createViewSchema` | `{ view }` (sortOrder = max+1000) |
| PATCH | `/api/collection-views/:id` | `updateViewSchema` | `{ view }`: config is **fully replaced** (not merged) |
| DELETE | `/api/collection-views/:id` | - | 204. 400 VALIDATION if it is the collection's last remaining view |
| PATCH | `/api/pages/:id/props` | `updatePropsSchema` | `{ row: RowDTO }`: **merge**; a null value deletes the key. Allowed even if the target page's parent is not a collection (properties are just stored) |

- Permissions: all require membership in the workspace.
- `GET /api/pages/:id/collection` rows include only deletedAt=null.
- Collection page export (.md/zip): instead of a body, **rows are dumped as a GFM table** (header: title + field names; cells: stringified values, with option names for select, user names for person, ✅/⬜ for checkbox). Row pages are included as child Markdown files following the existing tree logic.

---

# M8 contract — Invite links · member management · version history

## Invites
- `GET /api/workspaces/invite-preview?code=<code>` (authentication only, membership not required) → `InvitePreviewDTO { name, icon, memberCount }`. Unknown code 404 INVALID_CODE.

## Members (roles `owner | admin | member`, docs/adr/0945-*)
- `PATCH /api/workspaces/:id/members/:userId` body `updateMemberSchema { role: 'owner'|'admin'|'member' }` (owner only) → `{ member: MemberDTO }`. Demoting the last owner 400.
- `DELETE /api/workspaces/:id/members/:userId` → 204. An owner removes anyone, an admin removes plain members (owner/admin target 403), or you leave. The last owner leaving 400. **On removal, that user's private pages in this workspace are soft-deleted** (audit L3), their document ownerships are cleared and (when someone else is removed) the invite code is regenerated.
- `GET /api/workspaces/:id/member-candidates`, `POST /api/workspaces/:id/members`: only callers the member-add policy allows (default owners and admins; 403 otherwise, docs/adr/0948-*).
- `POST /api/workspaces/:id/invite/regenerate` (owner or admin) → `{ workspace: WorkspaceDTO }` (new code).
- `POST /api/workspaces/:id/transfer` (owner) body `transferOwnershipSchema { userId }` → `{ members: MemberDTO[] }`. The target becomes owner and the caller becomes member in one transaction under the `ws-members` lock (docs/adr/0911-*). Not a member (delegated accounts included as usual) 400; the caller themself 400; caller not an owner 403 (also the loser of two concurrent transfers). Afterwards the old owner can leave normally.

## Workspace deletion (owner, soft delete with a 30-day restore — docs/adr/0910-*)
- `GET /api/workspaces/:id/delete-preview` (owner) → `WorkspaceDeletePreviewDTO { pages, files, publicLinks, members, restoreDays }` for the confirm dialog.
- `DELETE /api/workspaces/:id` body `deleteWorkspaceSchema { name }` → 204. `name` must equal the workspace name (surrounding spaces ignored, case-sensitive), else 400; member 403; not a member / unknown / already deleted 404. Takes effect for everyone at once: the workspace disappears from `GET /api/workspaces`, every `/api/workspaces/:id/*`, page, comment, file (`/files/:id`) and template route answers 404, public links (`/api/public/*`; `/s/*` falls back to the plain app shell) and the invite code stop working, the iCal feed drops its items, query blocks, MCP tools, reminders, webhooks and sheet sync skip it, and open collaboration sockets are closed. Other members get a `workspace_deleted` notification with the workspace name (no webhook is sent).
- `GET /api/workspaces/deleted` → `{ workspaces: DeletedWorkspaceDTO[] }` — workspaces the caller owns that are deleted and still restorable (`deletedAt`, `purgeAt` = deletedAt + 30 days), newest first.
- `POST /api/workspaces/:id/restore` (owner) → `{ workspace: WorkspaceDTO }`. Everything comes back as it was (members, roles, pages, links, invite code). Not deleted or past 30 days 404; member 403. The `workspace_deleted` notifications are removed.
- Housekeeping deletes workspaces deleted more than 30 days ago: all rows by FK cascade, upload blobs after commit (same function as the forced account deletion's personal workspaces).

## Snapshots (version history, doc pages, visibleTo guard)
- `POST /api/pages/:id/snapshots` body `createSnapshotSchema { label? }` → `{ snapshot: SnapshotDTO }`.
- `GET /api/pages/:id/snapshots` → `{ snapshots: SnapshotDTO[] }` newest 50 (`created_at DESC, id DESC`). AI step rows (0.17) add `step` (see "v0.17.0 additions").
- `GET /api/pages/:id/snapshots/:sid/preview` → `{ markdown: string }`.
- `POST /api/pages/:id/snapshots/:sid/restore` → `{ ok: true }` (0.17 adds `before` and `step`, see "v0.17.0 additions"). Applied to the live document (DirectConnection), with an automatic snapshot taken just before restoring. Canvas 400.
- Automatic: in the store hook, if 10+ minutes have passed since the last snapshot, the pre-change state is saved; 50 are kept per page.
- Rows are a full state or a Yjs V2 diff against the previous version (chains of at most 10, docs/adr/1100-*). `SnapshotDTO.bytes` is the stored size. Preview, compare and restore answer 409 `SNAPSHOT_UNAVAILABLE` when a version cannot be rebuilt; restore then writes nothing.

# M9 contract — Calendar view · daily notes · templates

## Calendar view
- `collection_views.type` gains `'calendar'` (reflected in schema/shared). `viewConfigSchema.dateFieldId?` added.
- Server: the existing collection/view APIs as-is (calendar only additionally stores config.dateFieldId). **Rendered by the web app only**: rows are placed on a month grid by their date field value.

## Daily notes
- No server API needed; the web app uses the existing createPage. It ensures a daily folder (kind=folder, scope=private) exists in the private section, then
  finds or creates the page titled `YYYY-MM-DD` and navigates to it. (Looked up by title in usePages.)

## Page duplication (templates: see [Templates](#templates))
- `POST /api/pages/:id/duplicate` → `{ pages: PageMetaDTO[] }` (the duplicated root + descendants).
  - Recursively duplicates the target page and its descendant tree: new ids, under the same parent (root title "Copy of …", localized), page_docs state copied,
    props copied, and for collections the collections/views too. Wiki link hrefs keep pointing at the originals in v1 (not rewritten; reported).
  - visibleTo guard, same scope kept.

---

# MCP remote connector + OAuth 2.1

User guide: [MCP.md](MCP.md). Claude Code / claude.ai connect to `https://<domain>/mcp`, and once each user
allows it on the browser consent screen, notes are read and written **with that user's permissions only**.

## Endpoints (root, not `/api`; CORS `*`; no cookies)

| Method | Path | Description |
|---|---|---|
| GET | `/.well-known/oauth-protected-resource` (same with a `/mcp` suffix) | RFC 9728. `resource=<origin>/mcp`, `authorization_servers=[<origin>]` |
| GET | `/.well-known/oauth-authorization-server` | RFC 8414. code + S256 + `token_endpoint_auth_methods=["none"]` |
| POST | `/oauth/register` | RFC 7591 DCR (public clients). `redirect_uris` must be https or `http://localhost|127.0.0.1|[::1]:<any port>`. 201 `{client_id,…}`. 20/min |
| GET | `/oauth/authorize` | **No server route**: the SPA consent screen (`OAuthAuthorize.tsx`). Goes through `/login?next=` when not signed in |
| POST | `/oauth/token` | form-urlencoded (JSON also accepted). `authorization_code` (code single use, 5 minutes, PKCE S256, redirect_uri must match) / `refresh_token` (rotating; reusing a previous refresh token revokes the whole connection). Access 1 hour, refresh 60 days (sliding). Errors are RFC 6749 `{error,error_description}` |
| POST | `/mcp` | MCP Streamable HTTP (stateless, JSON responses). Missing/invalid token → 401 + `WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource/mcp"`. GET/DELETE → 405 |

## `/api/oauth/*` (session cookie only; 403 with a bearer token)

| Method | Path | Description |
|---|---|---|
| GET | `/api/oauth/authorize/info?client_id&redirect_uri` | `{ client:{id,name}, redirectHost }`. Unregistered client / redirect mismatch → 400 (no redirect) |
| POST | `/api/oauth/authorize` | body = the authorize query + `decision: allow|deny` → `{ redirectTo }` (code+state or error) |
| GET | `/api/oauth/grants` | Connected apps `{ grants: [{id, clientName, createdAt, lastUsedAt}] }` |
| DELETE | `/api/oauth/grants/:id` | 204. Access and refresh tokens are invalidated immediately |

## Token → permissions

- DB: `oauth_clients`, `oauth_codes` (code hashes), `oauth_grants` (SHA-256 hashes of access/refresh tokens + the previous refresh hash). Raw tokens are never stored.
- `requireUser` accepts `Authorization: Bearer`, but **only from the `/mcp` handler's internal inject (a process-secret header)**.
  Calling `/api/*` directly from outside with a token → 401. So what a token can do = the MCP tool surface only (no permanent deletion, member management, public sharing or admin APIs).
- Tools call the existing REST routes as the token's user through `app.inject`, so membership and 🔒 private-page visibility checks are identical to the web. The inject carries the original client IP so rate-limit buckets do not mix.

## Tools

Read: `find_context(query?, queries?, workspaceId?, budget?)` (one of `query` / `queries`), `read_page(pageId, outline?, section?, maxChars?)`, `read_pages(pageIds[], budget?)`,
`list_workspaces`, `list_pages(workspaceId, parentId?|'root', depth?, format?)`, `search(query, workspaceId?, format?)`,
`changes_since(cursor?, workspaceId?, budget?, detail?)`, `query_rows(collectionId, filter?, sort?, fields?, limit?, cursor?, describe?)`, `list_templates`,
`get_instructions(workspaceId, forPageId?)` (docs/adr/0975-*). Text outputs wrap member-written content in `<untrusted_content …>` and print
`can:` / `applies:` / `suspicious:` lines (docs/adr/0976-*, 0977-*).
Write (refused for read-only tokens): `patch_section(pageId, section, markdown?, mode, baseVersion?)`, `update_page(pageId, markdown, mode: append|replace)`,
`create_page(workspaceId, title, markdown, parentId?, private?)`, `import_folder`, `update_row(rowId, properties, baseVersion)`, `create_row(collectionId, title?, properties?)`,
`rename_page`, `move_page(pageId, parentId|null, section?)` (within the same workspace only), `trash_page` (soft delete), `add_comment(pageId, body)` (anchored to the first block), `create_from_template`.
`list_pages` and `search` keep their legacy JSON unless `format: "lines"` or `"compact"` (docs/adr/0928-*, 1541-*). JSON answers clean member-written strings and add a trailing `untrusted` key (objects) or a second text block (arrays) (docs/adr/1525-*). Tools added later: see "v0.12.0 additions", "v0.13.0 additions", "v0.14.0 additions" and "v0.15.0 additions" below and [MCP.md](MCP.md).

- `/.well-known/oauth-*`: `scopes_supported` is `["read","write"]` (`notes` still accepted as full access).
- `GET /api/oauth/authorize/info?…&scope=`: adds `requestedAccess: "read" | "write"`.
- `POST /api/oauth/authorize`: optional `access: "read" | "write"` (never wider than the requested scope; absent = as requested).
- `GET /api/oauth/grants`: each grant adds `access: "read" | "write"`.
- Bearer (MCP) tokens with scope `read` get 403 on every non-GET/HEAD route unless the route sets `config.bearerReadOnlyOk` (docs/adr/0935-*).

## Body edit route (for MCP, but also callable with a cookie)

| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/api/pages/:id/content` | `{ markdown, mode: 'replace'|'append' }` | `{ ok: true }`. Doc pages only (otherwise 400). The same `markdownToBlocks` as import → injected through the same DirectConnection as snapshot restore (applied live; the store hook updates the indexes). append inserts the new blocks after the existing ones (existing blocks untouched); replace preserves the previous state as a "Before AI edit" snapshot. 30/min |

## Agent retrieval and section editing (docs/adr/0926–0930)

Session cookie or MCP bearer (internal inject). Token numbers are estimates (ADR 0926).

| Method | Path | Request | Response |
|---|---|---|---|
| GET | `/api/context` | `q` (1–300 chars; may repeat: up to 5 different values after normalising, ADR 1720), `workspaceId?` (else every live workspace I belong to), `budget?` (≤ 12,000, default 3,500) | `{ fragments: [{pageId, workspaceId, title, anchor, headingPath, sections: [{anchor, headingPath, version}], ords, text, tokens, score, truncated}], more: [{pageId, title, anchor, headingPath, tokens}], titleOnly: [{pageId, title, kind}], budget, usedTokens, candidates }`. Only live, visible pages of live workspaces. With 2+ different `q`: also `queries: string[]` and `fragments[].matched: string[]` (query numbers "1".."5"); one budget for all; each section once. While semantic search is on, one `q` is merged too (v0.14.0 additions) |
| GET | `/api/pages/:id/outline` | – | `{ page: {id, title, kind, workspaceId, updatedAt}, sections: [{anchor, headingPath, level, tokens, version}], tokens }` (non-doc pages: empty `sections`; `tokens` is the sum of the section's index parts; answered from the section index while it is current, docs/adr/1041-*) |
| GET | `/api/pages/:id/section` | `ref` (anchor, heading text, heading path or heading block id), `maxChars?` | `{ page, section: {anchor, headingPath, level, version}, markdown, truncated, totalChars }`; unknown ref → 404 `SECTION_NOT_FOUND` listing valid anchors |
| GET | `/api/pages/read` | `ids` (comma-separated, ≤ 20), `budget?` (≤ 30,000, default 8,000) | `{ pages: [{id, title, workspaceId, kind, updatedAt, markdown, tokens, truncated}], omitted: [{id, title, reason}], missing: [id], budget, usedTokens }`; invisible ids are only listed in `missing` |
| POST | `/api/pages/:id/section` | `{ ref, markdown, mode: replace\|append\|prepend\|insert_after\|delete, baseVersion? }` | `{ ok, section: {anchor, headingPath, version} \| null, sections }`. Doc pages only. Version mismatch → 409 `SECTION_CONFLICT` with `error.current {anchor, headingPath, version, markdown}`, nothing written. replace/delete take a "Before AI edit" snapshot (≤ 1 per page per 2 min). 30/min |

## Collection queries for agents (docs/adr/0934-*)

| Method | Path | Description |
|---|---|---|
| GET | `/api/pages/:id/collection/query` | Rows of a collection filtered/sorted/paged in SQL. Query: `filter` (compact syntax, see ADR 0934), `sort` ("Due desc, Title"), `fields` (JSON array or comma list, `*` = all), `limit` (1–200, default 25), `cursor` (opaque `nextCursor`), `describe=1` (schema only, adds `definitions`). Returns `{collection, workspaceId, fields, columns, rows: [{id, version, cells}], nextCursor}`. 400 `INVALID_QUERY` / `QUERY_TIMEOUT`. |
| GET | `/api/pages/:id/row` | One collection row: `{collection, workspaceId, fields (definitions), columns, row: {id, title, version, cells}}`. 400 `NOT_A_ROW` for a page that is not a collection row. |
| PATCH | `/api/pages/:id/props` | (addition) optional `baseVersion` (row version from the two routes above). Mismatch → 409 `ROW_VERSION_CONFLICT` with `currentVersion`, nothing written. When `baseVersion` is sent the response also has `version`. |

## Edit lock and agent instructions (docs/adr/0970–0978)

Nothing is locked by default. A lock on a page covers its subtree; the nearest locked ancestor governs. Writes by a
member who may not edit return **403 `PAGE_LOCKED`** with `error.lockedPageId` and `error.editors [{id, name}]`
(the page owner first); the message names who can edit. Every write route of pages, collections, tasks, ink,
snapshot restore, document owner/living, sheet sync and vault sync checks it; creation under a locked parent,
moves into or out of a locked subtree and trash/restore/purge of a subtree that holds a lock the caller cannot
edit are refused as well. Comments check a separate permission (people may always comment; a lock can take
commenting away from agents). The collab socket of a member who may not edit is read-only (Hocuspocus
`authenticated` scope `readonly`; updates are answered with SyncStatus false and dropped).

| Method | Path | Body / query | Response |
|---|---|---|---|
| GET | `/api/pages/:id/lock` | – | `PageLockDTO { pageId, locked, own, lockRoot {id,title}\|null, owner, editors, people: editors\|everyone\|null, agents: same\|comment\|read\|null, canEdit, canComment, canManage, instructions }` for the caller (an MCP request is evaluated as an agent) |
| PUT | `/api/pages/:id/lock` | `{ locked, people?, agents?, editorIds? }` | `PageLockDTO`. Browser session only (bearer → 403). Owners/admins, or the page owner while they can edit it. Private pages → 400. Audited: `page.locked`, `page.unlocked`, `page.lock_editors_changed`. Unlocking removes an instruction designation (`instructions.removed`). Live sockets of the subtree are closed so clients re-authenticate |
| PUT | `/api/pages/:id/agent-instructions` | `{ mode: always\|match\|manual, applyTo?: ["page:<id>" \| "Title/**"], description?, sortOrder? }` | `PageLockDTO`. Owners/admins, browser only. Shared doc pages only; locks the page if needed; `match` needs a non-empty `applyTo`. Audited `instructions.set` |
| DELETE | `/api/pages/:id/agent-instructions` | – | `PageLockDTO` (designation removed, lock kept) |
| GET | `/api/workspaces/:id/agent-instructions` | – | `{ instructions: AgentInstructionDTO[] }` (live, locked, shared doc pages only) |
| GET | `/api/workspaces/:id/agent-instructions/bundle` | `forPageId?` | `{ workspaceId, forPageId, always: [..dto, markdown, truncated], matching: [...], otherMatch, manual, version }` (MCP `get_instructions`) |
| GET | `/api/pages/agent-context` | `ids` (≤ 50), `read=1?` | `{ pages: [{id, can: "read,comment,edit", createdBy, lastEdit {name, via}\|null, large, suspicious: [{anchor, rules}]}], applies: [{pageId, title, mode}] }` (`large`: state ≥ 1 MiB or ≥ 50k indexed tokens, docs/adr/1043-*). MCP tools compute the same object in process instead of calling this route (docs/adr/1070-*); `read=1` records `oauth_grants.tainted_at` when flagged content is returned to an agent |
| GET | `/api/pages/:id/suspicious` | – | `SuspiciousSectionsDTO { pageId, sections: [{anchor, headingPath, rules}] }` — injection-like heuristics stored at index time (`page_chunks.suspicious`); a signal only |

`PageMetaDTO.editLocked?: true` marks pages that carry their own lock. New audit actions: `page.locked`,
`page.unlocked`, `page.lock_editors_changed`, `instructions.set`, `instructions.removed`, `content.suspicious`
(first detection per page and rule, no actor).

OAuth: `POST /oauth/register` refuses a `client_name` that folds to a reserved word (Inkling, Admin, System, public form, …;
400 `invalid_client_metadata`); `POST /api/oauth/authorize` refuses the same reserved words (400
`CLIENT_NAME_RESERVED`). A client named exactly like another member is refused per workspace at request time
(403 `CLIENT_NAME_CLASH`, only in workspaces where that member is; common app names such as Claude are exempt), and
`GET /api/oauth/authorize/info` adds `nameNotice: { member, workspaces[], blocking } | null` for the consent screen
(docs/adr/1007-*).


Access changes wait for writes in progress (docs/adr/1071-*): `PUT /pages/:id/lock`, `PUT|DELETE /pages/:id/agent-instructions`, `POST|DELETE /workspaces/:id/agents/blocks`, `PUT /pages/:id/owner`, role changes, member removal and a `PATCH /pages/:id` that changes `parentId` take the workspace access row exclusively; transactional writes in the same workspace hold it shared (lock_timeout 10 s). The next request after such a change sees the new rules.

## Provenance (docs/adr/0936-*)

- `GET /api/pages/:id/snapshots`: each snapshot adds `author: {id, name} | null` and `viaClient: string | null`.
- Comment DTOs add `viaClient: string | null` (OAuth client name when written through MCP).

## Change feed (docs/adr/0932-*, 0933-*)

| Method | Path | Description |
|---|---|---|
| GET | `/api/changes?cursor&workspaceId&budget&detail` | Changes since a cursor (net per-section diffs within a token budget; `detail` = `none` \| `diff` (default) \| `full`). No cursor → current cursor. Returns `{ status: 'start'\|'ok'\|'resync_required', cursor, text, changes, detailed, listedOnly, rows, more }`. 400 `INVALID_CURSOR` / `CURSOR_WORKSPACE`; `workspaceId` → membership required. Only pages visible at change time are reported; pages no longer visible appear as `removed (no longer visible)` without content. Rows are kept `CHANGE_FEED_RETENTION_DAYS` (default 30) |

Since 0.15.1 an anchor that passes from one heading to another is logged as a rename, not a modification: a
`## Decided` inserted above another `## Decided` gives `renamed decided>decided~2` + `added decided` (before:
`modified decided` + `added decided~2`); the text reads `renamed decided → decided~2` (docs/adr/1960-*, "v0.15.1
additions" below).

## Notifications, subscriptions, activity and the agent inbox (docs/adr/1000–1007)

Notification rows are written by a background queue after the write that caused them (comments, body @mentions,
document owner, person cells, followed-page edits). `NotificationDTO` adds `via`, `count` (collapsed repeats),
`excerpt` (≤ 200 plain characters), `anchor` and `quiet` (listed without a badge: agent-written mentions and level
`nothing`). The unread count ignores quiet rows. New types: `comment_reply`, `page_owner`, `task_assigned`,
`page_update`, `agent_digest`, reserved `approval_request` (passes mute) and `approval_result`; `doc_mention` is now
produced.

| Method | Path | Body / query | Response |
|---|---|---|---|
| GET | `/api/me/notification-settings` | – | `NotificationSettingsDTO { emailInstant, emailDigest: 'off'\|'daily'\|'weekly', mailAvailable, subscriptions: SubscriptionDTO[] }` (session cookie only) |
| PATCH | `/api/me/notification-settings` | `{ emailInstant?, emailDigest? }` | same DTO; turning a channel off drops what was waiting for it |
| GET | `/api/pages/:id/subscription` | – | `PageSubscriptionDTO { own, effective: {level, source: page\|ancestor\|workspace\|default, fromPageId, fromTitle}, agentDigest, implicit }` (session only) |
| PUT | `/api/pages/:id/subscription` | `{ level: 'all'\|'mentions'\|'nothing'\|'mute'\|null, subtree?, agentDigest? }` | same; `level: null` removes my row (inherit). "Follow" = `all` |
| GET / PUT | `/api/workspaces/:id/notification-level` | PUT `{ level, agentDigest? }` | `{ level, agentDigest, isDefault }` — my default for the workspace (session only) |
| GET | `/api/workspaces/:id/activity` | `before, limit (≤100), actor=any\|human\|ai, via, userId, rootId, kind=any\|edit\|page, aiPagesOnly=1` | `ActivityPageDTO { items: ActivityItemDTO[], next, clients }` newest first; rows of other people's private pages are never listed, titles only for pages visible now |
| GET | `/api/changes/:seq/diff` | – | `ChangeDiffDTO { before, after, ops: [{t:'='\|'-'\|'+', s}] \| null, large, … }`; 404 unless the page is visible now and the row was visible when logged; also 404 when you are not a member of the workspace (docs/adr/1301-*) |
| GET | `/api/pages/:id/snapshots/:sid/diff` | `against=current\|<snapshot id>` | `SnapshotDiffDTO { from, to, ops, large }` (Markdown of both versions, line diff) |
| GET | `/api/pages/:id/provenance` | – | `PageProvenanceDTO { createdVia, createdByName, lastAgentEdit: {at, via, actorName} \| null }` |
| GET | `/api/inbox` | `workspaceId?, cursor?, kinds=mention,reply,comment,assigned,…` | `{ items: InboxItem[], more, unacked }` — unacknowledged direct items of the caller in `seq` order (MCP `inbox`) |
| POST | `/api/inbox/ack` | `{ ids?: string[], cursor?: string, workspaceId?: uuid, kinds?: InboxKind[] }` | `{ acked }` — sets `acked_at`; does not touch `read`. `ids`: exactly those items. `cursor`: the items up to it that `GET /api/inbox` with the same `workspaceId`/`kinds` lists (visibility, range, membership, agent access and the two-step rule included); without them, the unfiltered inbox (docs/adr/1922-*) |

`PATCH /api/comments/:id` with `resolved` from an agent (bearer) request: 403 `AGENT_RESOLVE_NOT_ALLOWED` unless the
thread root was written by the token's user. `PageMetaDTO`s are unchanged; `pages.created_via` is set for pages
created through MCP (`POST /api/pages`, import, import-folder, from-template). Webhook events add `assigned` and
`agent_digest` (daily). Mail needs SMTP; links use APP_URL/PUBLIC_URL; `NOTIFY_MAIL_DELAY_MS` (default 120000)
delays instant mail so a burst becomes one message and reading in the app first cancels it.

# Public folder sharing (2026-09-23)

Shares a folder (`kind='folder'`) through a single public link: anyone with the link can browse and read the folder's **current subtree** without signing in.
Publish/stop rules are the same as single-page sharing (workspace owner only; `scope='private'` → 400). Existing single-page sharing behavior is unchanged.

- **Subtree = computed at request time** (recursive CTE). Pages added or moved in later are included automatically; pages moved out are excluded automatically.
  Descent stops at trashed (`deleted_at`), private (`scope='private'`) and template pages → that whole subtree is excluded. Same workspace only, depth guard of 64.
- **ref (opaque identifier)**: the first 22 characters of `ref = base64url(HMAC-SHA256(key=shareToken, msg=pageId))`. Internal page UUIDs never appear in public responses or URLs (the M15 no-leak principle).
  It is one-way, so ref→pageId cannot be reversed; stopping and re-sharing changes the token, so every ref changes too. The server recomputes the subtree on every request to look refs up (no mapping table, no migration).
- Outside the subtree / trashed / private / nonexistent / non-viewable kind → always **404** (not 403).

| Method | Path | Response |
|---|---|---|
| GET | `/api/pages/:id/share` · same for POST | `ShareStatusDTO` + for folders `exposedCount` (number of currently viewable doc/collection descendants, excluding the folder itself) |
| GET | `/api/public/:token` (folder token) | `PublicFolderDTO { kind:'folder', title, icon, tree: PublicTreeNodeDTO[], updatedAt }`. Node = `{ ref, title, icon, kind, children }`. Collection rows are hidden from the tree (same as the app sidebar). A single-page token returns the existing `PublicPageDTO` (no kind field) |
| GET | `/api/public/:token/p/:ref` | Body of a descendant doc/collection as `PublicPageDTO` (server-rendered HTML). folder/canvas ref → 404. Wiki links: targets inside the subtree → `/s/<token>/p/<ref>` (the root folder → `/s/<token>`), outside → plain text. Attachment URLs → the path below |
| GET | `/api/public/:token/p/:ref/f/:fileId` | Only files referenced by that **descendant page**'s blocks/cover/icon (same workspace). A fileId from another page → 404 |
| GET | `/api/public/:token/f/:fileId` | Existing route. For a folder token, only the folder's own icon/cover |

Common to public routes: 60/min per route, `Content-Security-Policy: default-src 'none'…` + nosniff, bodies `Cache-Control: no-store`, files `public, max-age=300`.
Web: `/s/:token` (tree + reading pane for folders), `/s/:token/p/:ref`. "Share to web" in the tree row ⋯/right-click menu (doc, collection, folder; shared section only).

# Calendar · due dates completed — tasks inside documents (2026-09-23)

To fill the calendar and due list for users who only write regular documents, **checklists inside documents** are pulled in as dated items.

## Task index (`page_tasks`, migration `0020_page_tasks`, additive only)

- `page_tasks(id, page_id FK cascade, workspace_id FK cascade, block_id, text, due 'YYYY-MM-DD', checked, updated_at)`, indexes `(workspace_id, due)` and `(page_id)`.
  `page_task_index(page_id PK FK cascade, indexed_at)` = an "indexing done" marker (so the boot backfill picks only new documents).
- Extraction points: the collab store hook (next to `reindexPageText/Tags`), import, template creation/instantiation, duplication. Per page, delete+insert in one transaction (per-page advisory lock).
  At boot, live docs without a marker are backfilled 25 at a time (yielding 50ms between batches, per-page error isolation, counts logged). Extraction never writes the document (`stateToBlocks` read only).
- Targets: BlockNote `checkListItem`s (including children) with a date in their text. Date syntax (by priority, one per block, the token is removed from the displayed text):
  1. `📅 2026-09-30` (Obsidian Tasks) 2. with a year: `2026-09-30`, `2026.9.30`, `2026/9/30`, `2026년 9월 30일`
  3. without a year: `9/30`, `9월 30일` → the upcoming date (this year, or next year if it passed more than 60 days ago). Ties go to the earlier one.
  Numeric boundary checks (versions like `1.2.3` and paths like `a/9/30` excluded), nonexistent dates (`2/30`) ignored. Relative words (`오늘/내일/모레`, today/tomorrow/the day after) are not parsed. There is no date mention in the schema.

## Dated items (`md/dateItems.ts` → `DateItemDTO`)

`{ kind: 'row'|'page'|'daily'|'task', pageId, title, icon, date, done, collectionTitle?, fieldId?, doneFieldId?, blockId?, parentPath?, pageTitle? }`
- row: date fields of every collection. done = a checked checkbox field, or a select option whose name matches `/완료|done|끝|complete/i`. `doneFieldId` = a checkbox with a done-like name (else the first checkbox; if neither exists it is omitted → cannot be checked).
- page: `properties` with type='date' (`fieldId` = property id). done = a `done` checkbox property. daily: title is `YYYY-MM-DD`. task: `page_tasks` (done = checked).
- All are scoped to the workspace + `visibleTo` + trash excluded.

| Method | Path | Description |
|---|---|---|
| GET | `/api/workspaces/:id/calendar?month=YYYY-MM` or `?from=&to=` (≤62 days) | `{ events: CalendarEventDTO[] }` = DateItemDTO + a legacy-compatible `type` (=kind). For rows, every date field is its own item |
| GET | `/api/workspaces/:id/due` | `DueResponseDTO { today, items: (DateItemDTO & {section})[], counts }`. Sections: `overdue` (not done, last 60 days), `today`, `tomorrow`, `week` (the rest of the 7 days), `next30`, `done` (done + dated from 7 days ago to 30 days ahead). row/page/task only (daily excluded). One per row: the value of a date field named `마감|due|deadline|기한` first, else the first date field with a value. `?range=` is accepted but ignored |
| PATCH | `/api/pages/:id/tasks/:blockId` | `{ checked?, due? }` → toggle done / change the date of one checklist item inside a document. `{ ok, task }`. 120/min. 404 = no such block, 400 = no date token or validation failed |
| POST | `/api/workspaces/:id/tasks` | `{ title, date }` → appends `- [ ] title 📅 date` to the end of the workspace's Tasks document (top level of the shared section, created if missing (an advisory lock guarantees only one); its title follows the [request locale](#localization)), then reindexes immediately. `{ ok, pageId, blockId }`. 60/min |
| POST | `/api/pages` | existing + `date?: 'YYYY-MM-DD'` → creates a doc with a date property (`{id:'date', name:<"Date", localized>, type:'date'}`) |
| PATCH | `/api/pages/:id` | existing + `dateProperty?: { id?, value: 'YYYY-MM-DD'|null }` (added as the "Date" property if missing, removed when null) · `done?: boolean` (the 'done' checkbox property) |

**Safe document-write paths**: only the PATCH tasks / POST tasks routes above write documents (explicit user actions).
- Task edit: Hocuspocus `openDirectConnection` → changes only the `checked` attribute of an existing `checkListItem` element, or only the characters of the date token inside an existing `Y.XmlText` (formatting kept, no new nodes). The same edit is first applied to a cloned Y.Doc and verified through BlockNote conversion (block count unchanged, target checked/date as expected, body outside the date unchanged); only if it passes is it applied live. Editors with the page open see it live; the store hook saves and reindexes. Date tokens keep their original shape (`9/30`→`10/2`, ISO when the year changes).
- Quick add: `md/docWrite.appendBlocksToDoc` inserts only a deep clone of the blockContainer built by BlockNote `blocksToYDoc` from the `markdownToBlocks` result at the end of the top-level blockGroup (no existing blocks are rewritten → callouts, embeds and mentions absent from the server schema are preserved). Applied after verifying on the clone that "existing blocks are unchanged + count +1".
  (The append of `POST /pages/:id/content` rewrites everything, so such blocks disappear there; it was moved to `writeBlocksToDoc` in the same module with the behavior unchanged.)

Reminders: the hourly scan adds "pages with an unfinished task due today → the page's author (if a workspace member)". Same once-a-day-per-page dedupe as row reminders, per-page error isolation.

Web: calendar month/week view (prefs `calendar.view`), kind filter and show-done toggle (doubling as the legend), clicking an empty date / Enter on the day number → popover (add a task · ⌘/Ctrl+Enter new page on this date · open/create the daily note; a bottom sheet on phones), chip drag (rows/pages/tasks, not dailies; MouseSensor 5px, TouchSensor 250ms), clicking a task chip → `?block=<id>` scrolls to and highlights the block.
Due list: sections, counts, checking (optimistic + undo toast), source, relative dates, quick add at the top, sidebar badge (overdue + today, red when anything is overdue).

## Plugins (experimental)

Registered only with `EXPERIMENTAL_FEATURES=plugins` (otherwise 404). `GET /api/auth/mode` gains
`experimental: string[]` (enabled experiment names). Design: [PLUGINS.md](PLUGINS.md), ADR 0400–0405.

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/admin/plugins` | Admin (cookie). Fresh scan of `PLUGINS_DIR` merged with approvals: `{ pluginsDir, appVersion, plugins: [{ id, status: 'invalid'\|'missing'\|'not-approved'\|'needs-reapproval'\|'enabled'\|'disabled', error, manifest, hash, install }] }` |
| POST | `/api/admin/plugins/:id/approve` | Admin. `{ hash, permissions: string[] }` → enables exactly that content hash with `permissions ∩ manifest.permissions`. 409 `PLUGIN_CHANGED` if files changed since `hash` was read, 400 for unrequested permissions / invalid plugin |
| POST | `/api/admin/plugins/:id/disable` | Admin. `{ ok }` |
| DELETE | `/api/admin/plugins/:id` | Admin. Forgets the approval and deletes every user's `plugin_storage` rows for it |
| GET | `/api/plugins` | User. Active plugins `{ plugins: [{ id, name, version, description, permissions, commands, blocks, frameUrl }] }` (approved + enabled + on-disk hash unchanged) |
| GET | `/api/plugins/:id/pages/:pageId` | `read:pages`. `{ page: { id, workspaceId, title, kind, updatedAt, markdown } }` — same visibility/membership as the user; canvas/folder → 400. 120/min |
| GET | `/api/plugins/:id/search?workspaceId=&q=` | `read:pages`. Proxies `/api/workspaces/:id/search` as the user → `{ pages: [{ id, title, kind, updatedAt, snippet }] }`. 120/min |
| POST | `/api/plugins/:id/pages/:pageId/content` | `write:pages`. `{ markdown, mode: 'replace'\|'append' }` → proxies `POST /api/pages/:id/content` as the user (the web app asks the user to confirm first). 30/min |
| GET | `/api/plugins/:id/storage` | `storage`. `{ keys }` (this plugin, this user) |
| GET / PUT / DELETE | `/api/plugins/:id/storage/:key` | `storage`. `PUT { value }` (JSON ≤ 64 KB; 500 keys / 1 MB per plugin per user → 413 `PLUGIN_STORAGE_QUOTA`); `GET` → `{ value \| null }` |
| GET | `/api/plugin-sdk/v1.js` | Unauthenticated. In-frame SDK (`text/javascript`, `nosniff`) |
| GET | `/api/plugin-frame/:id/:hash/index.html` | Unauthenticated (opaque-origin frames send no cookies). 404 unless active with that exact hash. CSP `default-src 'none'; script-src 'nonce-…'; connect-src 'none'; … frame-ancestors 'self'; sandbox allow-scripts`, `no-store` |
| GET | `/api/plugin-frame/:id/:hash/main.js` | Unauthenticated. The approved bundle bytes, `immutable` |

Errors: unknown/inactive plugin → 404 `PLUGIN_NOT_FOUND`; missing permission → 403
`PLUGIN_PERMISSION`; MCP bearer tokens → 403 (browser sessions only).

## Link previews, embeds, share unfurl, workspace webhooks

Server-side fetches of user URLs go through `safeFetch` (SSRF guard, docs/adr/0500).

| Method | Path | Notes |
|---|---|---|
| GET | `/api/link-preview?url=` | Session required. 30/min per session. `{ preview: LinkPreviewDTO }` (`url` final URL, `title`, `description`, `siteName`, `image` (https only), `favicon` (https only)). Unreachable, blocked or non-2xx → 422 `PREVIEW_UNAVAILABLE` (generic). Cached in memory 6 h (failures 10 min). `Cache-Control: private, max-age=3600`. docs/adr/0502 |
| GET | `/s/:token`, `/s/:token/p/:ref` | Only when `WEB_DIST` is set. SPA shell with `og:*` / `twitter:*` meta + `<title>` for live shared (`scope='shared'`) pages; otherwise the plain shell. 120/min/IP, `no-store`. docs/adr/0503 |
| GET | `/api/workspaces/:id/webhooks` | Owner (or site admin member). `{ webhooks: WebhookDTO[] }`, URL masked (`urlMasked`) |
| POST | `/api/workspaces/:id/webhooks` | Owner. `{ url, events: WebhookEvent[] }` → `{ webhook }`. `url` must be `https://hooks.slack.com/services/…` or `https://discord.com|discordapp.com/api/webhooks/<id>/<token>`, else 400 `VALIDATION`. Max 10 → 409 `LIMIT_REACHED`. 20/min |
| PATCH | `/api/webhooks/:id` | Owner. `{ events?, enabled? }` → `{ webhook }`. Re-enabling resets `failureCount` and `autoDisabledAt` |
| DELETE | `/api/webhooks/:id` | Owner. 204 |
| POST | `/api/webhooks/:id/test` | Owner. 5/min. Sends a fixed test message now → `{ ok, status, error, webhook }` |

`WebhookEvent` = `mention` (comment @mentions) · `comment` · `reminder` (due today) · `page_created` (shared section, sent after 20 s) · `review_due` (once a day: shared documents due for review by priority, docs/adr/0952-*).
Webhook create/update/delete are audited (`webhook.*`, masked URL).
Events on pages that are not `scope='shared'` are never sent. After 5 consecutive failed events a hook is disabled and owners get a
`webhook_disabled` notification (`NotificationDTO.workspaceId` set). docs/adr/0504.

HTML responses without their own CSP get `Content-Security-Policy: frame-src 'self' <embed providers>` (docs/adr/0501).

## Collections: relations, rollups, batch rows, gallery/timeline, Sheets sync, iCal

View types: `table | board | calendar | gallery | timeline`. `ViewConfig` adds `cardCover`
(`none|cover|firstImage`), `cardFieldIds`, `cardSize` (`sm|md|lg`), `startFieldId`, `endFieldId`,
`zoom` (`day|week|month`). Field types add `relation` (`relation: { targetPageId, twoWay?, pairFieldId? }`,
value = `string[]` of row ids) and `rollup` (`rollup: { relationFieldId, targetFieldId | 'title', fn }`,
`fn` = `count|sum|avg|min|max|earliest|latest|percentChecked|showUnique`, computed, never stored).
Up to 200 fields per collection. docs/adr/0300, 0301.

| Method | Path | Notes |
|---|---|---|
| GET | `/api/pages/:id/collection` | Now also returns `refs: Record<rowId, RowRefDTO>` (visible linked rows only). Relation cells contain only visible, live links; rollup values are injected into `props`. `?rows=0` → definition only (`rows: []`) |
| PUT | `/api/pages/:id/collection/fields` | Validates relation targets (visible collection in the same workspace) and rollups (relation of this collection; target may not be a rollup/relation except `count`) → 400 with a message. A new `twoWay` relation creates the paired field on the target collection (`pairFieldId` filled in) |
| PATCH | `/api/pages/:id/props` | Rollup keys are ignored. Relation values: invalid/hidden ids dropped, existing hidden links preserved, two-way pair mirrored |
| GET | `/api/pages/:id/collection/row-options?q=&limit=` | Relation picker: visible rows of the collection `{ rows: RowRefDTO[], more }` (limit ≤ 200, default 50, title ILIKE) |
| GET | `/api/pages/:id/collection/covers` | Gallery "first image": `{ covers: { rowId: '/files/<id>' } }` (first uploaded image per visible row) |
| POST | `/api/pages/:id/collection/rows/batch` | `{ rows: [{ title?, props? }] }` 1–1000 rows, body ≤ 16 MB, one transaction. Values type-checked against fields; relation/rollup/unknown keys dropped. Collection cap 100 000 live rows → 400. → `{ rows: RowDTO[] }` |
| PATCH | `/api/pages/:id/collection/rows/batch` | `{ rows: [{ id, title?, props? }] }` 1–1000. Merge like PATCH props (`null` deletes) in one SQL statement; only visible children of `:id` are touched → `{ updated }` |
| GET / PUT / DELETE | `/api/pages/:id/collection/sheet-sync` | **Experimental `sheets-sync`** (404 when off). `PUT { url, keyColumn, titleColumn?, intervalMinutes? (5–1440, default 15), enabled? }`; `url` must start with `https://docs.google.com/spreadsheets/`. → `{ sync: SheetSyncDTO \| null }`. docs/adr/0306 |
| POST | `/api/pages/:id/collection/sheet-sync/run` | **Experimental.** Sync now (6/min). Sheet errors → 400 with message; already running → 409 `SYNC_RUNNING` → `{ sync, stats: { inserted, updated, unchanged } }` |
| GET | `/api/me/ical` | `{ ical: { active, createdAt, lastUsedAt } }` (never the token) |
| POST | `/api/me/ical` | Issue/regenerate → `{ ical: { …, url } }` — the URL with the secret token is returned once |
| DELETE | `/api/me/ical` | Revoke. 204 |
| GET | `/ical/<token>.ics` | **Root path, no session.** RFC 5545 feed of every dated item the token owner can see (all workspaces, −90/+400 days). `text/calendar`, `ETag` + `If-None-Match` → 304, `Cache-Control: private, max-age=300`, 30/min/IP. Unknown token → 404. docs/adr/0303, 0304 |

## Admin: backups

Admin + browser session only (MCP tokens → 403). Data comes from the `backup` sidecar through shared
volumes (`BACKUP_DIR`, default `/backups`, read-only; `BACKUP_CTL_DIR`, default `/backup-ctl`).
Restore has no HTTP endpoint (CLI `deploy/restore.sh`). docs/BACKUP.md, docs/adr/0600–0607.

| Method | Path | Notes |
|---|---|---|
| GET | `/api/admin/backups` | `{ configured, status, alert, stale, pending, sets }`. `configured:false` (everything else empty) when `BACKUP_DIR` does not exist. `status` = sidecar `status.json` (`running`, `heartbeatAt`, `nextRunAt`, `lastSuccess`, `lastFailure`, `lastVerify`, `lastRestoreTest`, `remote`, `config` …). `alert` = `{ kind, message, at }` or null. `pending` = `queued \| processing \| null`. `sets` newest first: `{ id, kind, createdAt, totalBytes, encrypted, appVersion, migration, migrationsApplied, files[{ name, bytes }] }` |
| POST | `/api/admin/backups/run` | Queue a backup now (6/min). 202 `{ queued: true }`. 409 `BACKUP_QUEUED` / `BACKUP_RUNNING` / `BACKUP_DISABLED` / `BACKUP_NOT_CONFIGURED`, 503 `BACKUP_SIDECAR_DOWN` (no heartbeat for 10 min) |
| GET | `/api/admin/backups/:id/download` | Streams the set as an uncompressed `application/x-tar` (`inkling-backup-<id>.tar`), files as stored (encrypted sets stay encrypted). `:id` must match `^\d{8}-\d{6}$` → else 404 `BACKUP_NOT_FOUND` |

`NotificationType` gains `workspace_deleted` (docs/adr/0910-*; `pageId` null, `workspaceName` set, not clickable) and `backup_failed` (sent to every admin when a backup, restore test or remote
copy fails, or the sidecar stops reporting; no page/workspace).

## Query blocks

Dataview-style queries (syntax: [QUERY.md](QUERY.md)). docs/adr/0203, 0204.

| Method | Path | Notes |
|---|---|---|
| POST | `/api/workspaces/:id/query` | `{ source, today?: 'YYYY-MM-DD', tzOffsetMinutes?: -840..840 }` (member only, 120/min). → `QueryResultDTO { type: 'TABLE'\|'LIST'\|'TASK', withoutId, columns: string[], rows: [{ pageId, title, cells: unknown[], task?: { blockId, text, due, checked } }], truncated, elapsedMs, cached? }`. Only pages visible to the caller (shared + own private), no trashed pages or templates. Syntax / unknown field → 400 `QUERY_SYNTAX` (message ends with `(line L, col C)`); > 3 s → 400 `QUERY_TIMEOUT`. Rows ≤ 500 (`LIMIT`, default 200) |

## Vault sync (experimental `vault-sync`)

Registered only when `EXPERIMENTAL_FEATURES` contains `vault-sync` (otherwise 404). Used by
`inklingctl sync <vaultDir> --workspace <name|id>`. Revision tokens are opaque strings
(state-vector hash + delete-set hash + metadata hash since 0.15.1, docs/adr/1920-*); `contentHash` is SHA-256 of the normalized canonical
markdown (frontmatter `inkling-id`, `aliases`, `tags`, page properties + body; attachments as
`/files/<id>`; wikilinks as `[[Current Title]]` / `[[Current Title|shown]]`). docs/adr/0200–0202.

| Method | Path | Notes |
|---|---|---|
| GET | `/api/workspaces/:id/sync/changes?since=<cursor>` | → `{ cursor, pages: [{ id, parentId, kind, title, updatedAt, revision, contentHash }], trashed: [{ id, deletedAt }] }`. All visible live pages (≤ 20 000, else 413 `TOO_MANY_PAGES`); `revision` only for docs changed since `since` (and docs linking to pages renamed/trashed since then), `null` = unchanged; `contentHash` when cached for that revision. Pass the returned `cursor` next time (overlaps by 5 s) |
| POST | `/api/workspaces/:id/sync/read` | `{ ids: uuid[] }` (1–100) → `{ pages: [{ id, revision, contentHash, markdown }], missing: uuid[] }`. Reads the live document when a browser has it open |
| PUT | `/api/pages/:id/sync/md` | `{ markdown (≤ 1.5M chars), expectedRevision }` → `{ revision, contentHash, markdown (canonical), droppedFrontmatterKeys }`. Revision mismatch (incl. unsaved live edits) → **412** `{ error: { code: 'REVISION_MISMATCH' }, current: { revision, contentHash, markdown } }`. Frontmatter replaces page properties/aliases (internal `fullWidth` kept). Applied through the collaboration server — open editors update live |
| POST | `/api/workspaces/:id/sync/pages` | `{ parentId?: uuid\|null, title, kind: 'doc'\|'folder', markdown? }` → `{ page: { id, parentId, kind, title, updatedAt }, revision?, contentHash?, markdown? }` (doc fields only for `kind: 'doc'`). Scope inherits the parent |
| DELETE | `/api/pages/:id/sync?expectedRevision=` | Trash one leaf page (204). Docs require `expectedRevision` → 412 with `current` on mismatch; live sub-pages → 409 `HAS_CHILDREN` |

## Fix phase changes (docs/adr/0800–0815)

**Errors may carry extra fields.** `AppError.details` is merged into the `error` object:
`{ "error": { "code": "...", "message": "...", ...details } }`. Clients must ignore unknown keys.

**`DELETE /api/admin/users/:id` — 409 `SOLE_OWNER`.** Refused while the user is the only owner of
any workspace:

```json
{ "error": { "code": "SOLE_OWNER", "message": "…", "workspaces": [{ "id": "uuid", "name": "Team" }] } }
```

The admin UI should list `workspaces` and ask to promote another member to owner first
(`PATCH /api/workspaces/:id/members/:userId { role: "owner" }` by that workspace's owner, or the
admin as a member/owner there). On success the user's private pages go to the trash with no author:
nobody (admins included) can see, restore or purge them; the 30-day trash purge removes them.

**Visibility.** A private page whose author no longer exists (`created_by IS NULL`) is visible to
nobody. When a shared subtree containing such pages is moved to the private section, the mover
becomes their author.

**Page tree changes** (`POST /pages` with `parentId`, `PATCH /pages/:id` with `parentId`/`scope`,
restore/purge, duplicate/expand-canvas, `POST /pages/from-template`, vault-sync create,
imports, collection batch rows):
- `400 VALIDATION` — parent missing / in the trash / in another workspace, cycle, or the result
  would be deeper than 64 levels.
- `403 FORBIDDEN` — the parent is inside a folder/page with an active public link and the caller is
  not a workspace owner (moves within the same public folder and new rows of a public collection
  stay allowed).

**`GET /api/workspaces`, `POST /api/workspaces/join`** — `inviteCode` is `""` unless the caller is an
owner of that workspace. **`DELETE /api/workspaces/:id/members/:userId`** by an owner (removing
someone else) regenerates the invite code.

**`PATCH /pages/:id/props`, collection batch rows** — `400` when a person cell references a user who
is not a member of the workspace.

**`POST /pages/:id/publish/notion`** — real uploads (non-dry-run) are owner-only (`403`) and rate
limited to 10/min.

**Templates** — templates saved from a private page (or with `private: true`) are listed/usable by
their creator only; `DELETE /templates/:id` needs the creator or a workspace owner. See [Templates](#templates).

**Imports** — folder depth ≤ 32, at most `IMPORT_MAX_PAGES` (default 5000) created pages, zip entries
measured by real decompressed bytes (`IMPORT_MAX_ENTRY_MB` per entry, default 25; `IMPORT_MAX_UNPACKED_MB`
total, default 50), at most `IMPORT_MAX_FILES` (default 300) files → `400` otherwise. Imported
attachments get `pageId` of the first page that references them.

**Login** — `401` (the password was just changed) when a password reset committed while the login was
being verified. A password reset also revokes the iCal feed token.

**`GET /api/health/ready`** — `200 {ok:true, db:true}` / `503 {ok:false, db:false}` (DB `select 1`,
2 s timeout, cached 5 s). `/api/health` stays a liveness check.

**Collab** — upgrades during shutdown or a DB failure get `503`. When access is revoked the server
sends a Hocuspocus `PermissionDenied` message with reason `permission-changed` and then closes the
socket with code 4403.

**Static** — a missing `/assets/*` file is a 404 (not the SPA shell).

---

# Templates

Guide and file format: [TEMPLATES.md](TEMPLATES.md). Decisions: ADR 0920–0925. All routes need a
session and workspace membership (a deleted workspace answers `404`). `:tid` is a built-in key
(`meeting`, `standup`, `meetingSeries`, `project`, `kickoff`, `brainstorm`, `retro`, `readingList`,
`weeklyReview`) or a custom template uuid. Built-in text follows the request locale (`users.locale`
→ `Accept-Language` → `DEFAULT_LOCALE`).

| Method | Path | Description |
|---|---|---|
| GET | `/api/workspaces/:id/templates` | `{ templates: TemplateDTO[] }` — built-ins, then custom templates visible to the caller (newest first). `TemplateDTO { id, builtin, name, description, icon, category: 'docs'\|'projects'\|'meetings'\|'personal'\|'custom', kind: 'doc'\|'structure', pageCount, scope: 'shared'\|'private', mine, withDate, inputs: { name, default }[] }` |
| POST | `/api/workspaces/:id/templates` | Save a page as a template. `{ fromPageId, name ≤60, description? ≤300, icon? ≤16, category?, includeSubpages?, includeRows?, private? }` → `{ template }`. A private source page always gives a private template. More than 200 pages / 12 levels / 20 MB → `400 TEMPLATE_TOO_LARGE`. 30/min |
| GET | `/api/workspaces/:id/templates/:tid/preview` | `{ preview: { blocks: { type, text, depth, checked? }[] (first 14 blocks of the root document, plain text), truncated, outline: { kind, title, icon, depth, fields?, views?, rows? }[] } }` |
| GET | `/api/workspaces/:id/templates/:tid/export` | `.md` (document template, frontmatter meta) or `.zip` (structure: `inkling-template.json` + `pages/*`). 20/min |
| POST | `/api/workspaces/:id/templates/import[?private=1]` | multipart `file` (.md / .zip, ≤ 25 MB) → `{ template }`. Bodies go through the Markdown / JSON Canvas importers; invalid archive → `400 TEMPLATE_INVALID`. 20/min |
| DELETE | `/api/templates/:id` | 204. Built-in key → 403; creator, owner or admin only; a template of a workspace you are not a member of → 404 `TEMPLATE_NOT_FOUND` (docs/adr/1301-*) |
| POST | `/api/pages/from-template` | `{ workspaceId, builtinKey \| templateId, parentId?, scope?, title? ≤300, date?: 'YYYY-MM-DD', inputs?: { [question]: answer }, tz?: IANA zone }` → `{ page, pages: PageMetaDTO[] (root first, depth-first), cursor?: { pageId, blockId, offset } }`. Creates the whole tree in one transaction under the workspace tree lock (placement and depth checks as for page creation; under a parent the parent's section wins). Variables are substituted at this moment; `withDate` templates also set a `date` property on the root. 30/min |

`POST /api/pages/:id/instantiate` and the page `isTemplate` flag were removed (ADR 0920); save the
page with sub-pages as a template instead.

# Workspace settings (docs/adr/0945–0953)

All routes in this section need a browser session (a bearer token gets 401 from outside /mcp, 403 through it). `WorkspaceDTO.can`
(`manage`, `editSettings`, `addMembers`, `inviteLink`, `export`, `publish`) is the server's view of
what the caller may do; every route re-checks.

| Method | Path | Who | Body / query | Response |
|---|---|---|---|---|
| GET | `/api/workspaces/:id/settings` | member | - | `{ settings: WorkspaceSettingsDTO, role, can }` |
| PATCH | `/api/workspaces/:id/settings` | owner | `updateWorkspaceSettingsSchema` (strict): `inviteLinkEnabled`, `memberAddPolicy`/`exportPolicy` (`owners`\|`admins`\|`members`), `publicSharingDisabled` (+ `unpublishExisting: true` removes every public link in the same transaction), `trashRetentionDays` 7–365, `auditRetentionDays` 30–730, `reviewIntervalDays` 7–730 or null | `{ settings, role, can, unpublished }`; audited as `settings.updated` with changed fields |
| GET | `/api/workspaces/:id/audit` | owner, admin | `action` (exact, or a group such as `member`), `actorId`, `cursor` (id), `limit` ≤ 100 | `AuditPageDTO { events, nextCursor, retentionDays }`, newest first |
| GET | `/api/workspaces/:id/agents` | owner, admin | - | `{ connections: AgentConnectionDTO[], blocks: AgentBlockDTO[] }` — OAuth connections of current members that reached this workspace (`access`, `firstUsedAt`, `lastUsedAt`, `blocked`) |
| POST | `/api/workspaces/:id/agents/blocks` | owner, admin (not owners' agents) | `{ userId, clientId? }` (no client = all agents of that member) | `{ block: { id } }`; idempotent |
| DELETE | `/api/workspaces/:id/agents/blocks/:blockId` | owner, admin | - | 204 |
| POST | `/api/workspaces/:id/shared/unpublish` | owner, admin | `{ pageIds? }` (omit = all) | `{ unpublished }` |
| GET | `/api/workspaces/:id/review-due` | member | `mine=1` | `ReviewDueDTO { intervalDays, today, items, archive, living }`; items by priority score |
| POST | `/api/pages/:id/view` | member who sees the page | - | 204; counts one web read (page total only) |
| GET | `/api/pages/:id/review` | member who sees the page | - | `{ review: PageReviewDTO }` |
| PUT | `/api/pages/:id/owner` | member who sees the page | `{ ownerId \| null }` (a member; private page: its author) | `{ review }` |
| POST | `/api/pages/:id/review` | member who sees the page | - | `{ review }`; "Mark reviewed" now, by the caller |
| PUT | `/api/pages/:id/living` | member who sees the page | `{ living: true\|false\|null }` | `{ review }` |

Changed rules:
- `POST /api/pages/:id/share`, `DELETE /api/pages/:id/share`: owners and admins; publishing a page
  that is not public yet answers 403 `PUBLIC_SHARING_DISABLED` while the workspace forbids public
  links. Both are audited (`share.*`). `GET /api/workspaces/:id/shared` → `canManage` for owners and admins.
- `GET /api/workspaces/:id/export`: 403 when the export policy excludes the caller; audited
  (`export.downloaded`). Per-page `/api/pages/:id/export` is unchanged.
- Agent (MCP) requests: any workspace route answers 403 `AGENT_BLOCKED` (single-page routes 404)
  when that connection is blocked in the workspace; cross-workspace tools skip it.
- MCP `read_page` header adds `owner`, `reviewedAt`, `reviewDue: YYYY-MM-DD (stale, p=0.62)` or
  `living: yes` when known; `find_context` adds `owner X, reviewed YYYY-MM-DD, stale p=0.62` to a
  fragment header. Values come from stored dates and the daily batch only.
- Trash purge uses each workspace's `trashRetentionDays`; audit events past
  `auditRetentionDays` and page read counters older than 90 days are purged hourly.

## v0.5.0 additions

### Workspace two-step requirement (docs/adr/1112-*)
- `PUT /api/workspaces/:id/settings/two-factor` (owner or admin) body `{ required: boolean, graceDays?: 0–30 }` → `{ twoFactor }`. No `APP_SECRET_KEY` → 501 `TWO_FACTOR_UNAVAILABLE`; turning it on before you use two-step verification yourself → 403 `TWO_FACTOR_SELF_REQUIRED`. Audited.
- `GET /api/workspaces/:id/settings` gains `twoFactor { required, graceDays, requiredAt, deadline, available, selfSatisfied, membersWithout? { count, members (≤50) } }` (`membersWithout` for owners and admins).
- `WorkspaceDTO.twoFactor { required, deadline, state: 'off' | 'ok' | 'grace' | 'blocked' }`.
- After the deadline every workspace route, MCP call and collaboration socket of a member without two-step verification answers 403 `TWO_FACTOR_REQUIRED { workspaceId }`. Accounts that sign in through another service count as verified.
- Invite codes are matched case-insensitively against their hash (docs/adr/1110-*). `AdminUserDTO.signupKey` is masked.

### Large pages (docs/adr/1103-*)
- `GET /api/pages/:id/size` (page access) → `{ stateBytes, tokens, large }`. `stateBytes` is in V1 terms (V2 bytes × 1.46) so the threshold matches the agent hint (≥ 1 MiB or ≥ 50k tokens).
- `GET /api/workspaces/:id/large-pages` (owner or admin, else 403) → `{ pages: [{ id, title, icon, stateBytes, tokens, updatedAt, snapshotBytes, snapshotCount }], thresholds }`. Other members' private pages are left out.

### Link islands (docs/adr/1123-*)
- `GET /api/workspaces/:id/graph/islands` (members) → `{ pages, links, islands: [{ size, hub: { id, title }, pageIds (≤200) }], unlinked: [{ id, title, icon, kind, updatedAt }] (≤500, newest first, folders excluded), unlinkedTotal }`. Islands have 2+ pages, largest first. Nodes follow `/graph` (visibleTo, no trash, no database rows); a link to a page you cannot see is not an edge. ETag = user + workspace version + index epoch → 304. 60/min.

### Former titles (docs/adr/1121-*)
- `[[Title]]` resolves current title, then alias, then a former title of a page you can see (newest holder wins). Former titles are recorded by `PATCH /api/pages/:id` renames only.

### Imports (docs/adr/1122-*)
- zip and folder import responses add `duplicateAttachments`; the Notion report adds `merged: { pages, attachments }` and `attachments` counts files actually stored.

## v0.6.0 additions

### OpenID Connect sign-in (docs/adr/1160–1162)
- `GET /api/auth/oidc/start?returnTo=/path` (no auth) → 302 to the provider; sets `inkling_oidc` (httpOnly, Lax, Path=/api/auth/oidc, 10 min). `returnTo` must be a same-origin path, else `/`. Not configured → 404 `OIDC_DISABLED`.
- `POST /api/auth/oidc/link { returnTo? }` (browser session only, bearer 403) → `{ url }`. Delegated accounts 400 `DELEGATED_ACCOUNT`; provider down 503 `OIDC_UNAVAILABLE`.
- `GET /api/auth/oidc/callback?code&state` (called by the provider) → always 302: success → `returnTo` with the session cookie; Inkling two-step on → `/login?next=<returnTo>#totp=<challenge>` (finish with `POST /auth/login/totp`); failure → `/login?oidc_error=CODE` (link flow: `returnTo?oidc_error=CODE`).
- Codes: `OIDC_DISABLED`, `OIDC_STATE_INVALID`, `OIDC_CANCELLED`, `OIDC_PROVIDER_ERROR`, `OIDC_UNAVAILABLE`, `OIDC_TOKEN_INVALID`, `OIDC_NO_EMAIL`, `OIDC_EMAIL_UNVERIFIED`, `OIDC_DOMAIN_NOT_ALLOWED`, `OIDC_NO_ACCOUNT`, `OIDC_EMAIL_TAKEN`, `OIDC_MFA_REQUIRED`, `OIDC_ALREADY_LINKED`, `OIDC_LINK_CONFLICT`, `OIDC_LINK_SESSION`, `EMAIL_NOT_VERIFIED`, `RATE_LIMITED`. 30/min/IP on all three routes.
- `GET /api/auth/mode` adds `oidc: { name } | null`. `GET /api/auth/me` adds `user.logins: [{ provider: 'oidc', name, email, linkedAt, lastUsedAt }]`; `user.origin` may be `'oidc'` (no password: reset/change/verification answer `DELEGATED_ACCOUNT`, `POST /auth/login` answers `INVALID_CREDENTIALS`).

### Splitting pages and log rotation (docs/adr/1140–1142)
- `POST /api/pages/:id/split` (edit right, document pages, 60/min) `{ level: 1–6, sections?: headingBlockId[] (≤200), preview?: boolean }` → `{ pageId, level, levels: number[6], sections: [{ blockId, anchor, title, blocks, bytes, comments, pageId? }], remainingBlocks, openBy, preview }`. 400 no section / not a document / more than 200; 403 `PAGE_LOCKED`; 409 `SPLIT_CONFLICT` (a moved section changed meanwhile, nothing changed). Subpages are indexed shortly after the response.
- `GET /api/pages/:id/rotation` (page access) → `{ mode: 'off'|'month'|'size', maxBytes, current: { id, title } | null }`; `PUT` (edit right) `{ mode, maxBytes? (65536–8388608) }` → same.
- `POST /api/pages/:id/rotation/target` (edit right, 60/min) → `{ pageId, title, rotated, created, mode }`: where an append should go; may create the month or size subpage; sends the one-time `large_page` notification for a large page that does not rotate.
- Notification type `large_page` (owner, else creator; once per page; no mail). `[[Title#Heading]]` in Markdown input resolves to the subpage of Title named Heading, else to Title.

### Public link expiry and passwords (docs/adr/1170–1172)
- `POST /api/pages/:id/share` body optional `{ expiresAt?: ISO|null, expiresInDays?: 1–3650, password?: 4–128 chars }` (not both expiry forms), applied only when a new link is made. No expiry given → the workspace `shareDefaultExpiryDays`. No password while the workspace requires one → 403 `SHARE_PASSWORD_POLICY`.
- `PATCH /api/pages/:id/share` (owners/admins) `{ expiresAt?: ISO|null, expiresInDays?, password?: string|null }`: omitted = unchanged, null = remove. Expiry must be more than 1 minute and at most 10 years ahead (400). 409 `NOT_SHARED`; removing a required password 403 `SHARE_PASSWORD_POLICY`. → `ShareStatusDTO`.
- `ShareStatusDTO` adds `expiresAt`, `expired`, `hasPassword`, `policy { defaultExpiryDays, passwordRequired }`. `GET /api/workspaces/:id/shared` items add `expiresAt`, `expired`, `hasPassword`; expired links stay listed. The hash is never returned.
- `POST /api/public/:token/unlock { password }` → 204 + `inkling_share` cookie (Path=/api/public/<token>, HttpOnly, Lax, 12 h, never past the link expiry). Wrong 401 `SHARE_PASSWORD_INVALID`, unknown 404, expired 410. Every answer takes at least 300 ms with one argon2 verify. 10/min/IP plus per-link backoff and IP ban (429 `RATE_LIMITED`).
- Public routes (`/api/public/:token`, `/f/:fileId`, `/p/:ref`, `/p/:ref/f/:fileId`): expired → 410 `SHARE_EXPIRED` (not counted as a guess); password without a valid cookie → 401 `SHARE_PASSWORD_REQUIRED`; both `no-store` and `X-Robots-Tag: noindex, nofollow`. `/s/…` of such links is a plain shell with a noindex meta and no og/twitter tags.
- Workspace settings add `shareDefaultExpiryDays` (1–365|null) and `sharePasswordRequired`. Audit actions `share.expiry_changed`, `share.password_set`, `share.password_changed`, `share.password_removed`.

### Events and the write gate (docs/adr/1150–1151)
- `POST /pages/:id/comments`, `PATCH /comments/:id`, `POST /pages/:id/content` and the section edit wait for a lock change, agent block or member change in progress and answer by its result (403 `PAGE_LOCKED`, 403, 403 `AGENT_BLOCKED`). If the event cannot be written the request answers 500 and nothing is saved.

## v0.7.0 additions

### Row templates (docs/adr/1180–1184)
- `GET /api/pages/:id/collection/row-templates` (anyone who can see the database) → `{ templates: RowTemplateDTO[], defaultId }`; `RowTemplateDTO { id, collectionId, name, icon, title, props, isDefault, sortOrder, inputs, hasBody, updatedAt }`.
- `POST /api/pages/:id/collection/row-templates` (database editable; edit lock → 403 `PAGE_LOCKED`) `{ name, icon?, title?, props?, fromRowId?, isDefault? }` → `{ template }`. At most 20 (400). Props by field id; dates `YYYY-MM-DD`, `today`, `today±N`; person = member id or `me`; relation/rollup and invalid values dropped.
- `GET /api/collection-row-templates/:id` → `{ template, state }` (base64 Yjs update of the body, '' when empty). `PATCH` `{ name?, icon?, title?, props?, update? (base64 Yjs update merged into the body; damaged 400 `TEMPLATE_INVALID`, > 2 MiB 400 `TEMPLATE_TOO_LARGE`), schema? (0.20, see "v0.20.0 additions"), isDefault?, sortOrder? }` → `{ template }`. `DELETE` → 204.
- `POST /api/pages/:id/collection/rows` `{ template?: uuid|null, title?, props?, inputs?, tz? }`: omitted template → the default (none → empty row), `null` → empty row, unknown → 404 `TEMPLATE_NOT_FOUND`. Given props override the template; a typed title wins over the pattern. → `{ row, templateId, cursor? }`. Placement and edit lock as for page creation; `page_created` webhook and assignment events.

### Webhooks (docs/adr/1190–1192, [WEBHOOKS.md](WEBHOOKS.md))
- `POST /api/workspaces/:id/webhooks` (owner) `{ url, events, kind? }` → `{ webhook, secret }`. Slack/Discord are inferred from the host (`secret: null`); `kind: 'generic'` must be explicit: https, port 443, no credentials or fragment, every DNS answer public, else 400. The `whsec_…` secret is returned only here and on rotation. At most 10 (409 `LIMIT_REACHED`).
- `WebhookDTO` adds `failingSince`, `hasSecret`, `previousSecretUntil`. `PATCH /api/webhooks/:id { events?, enabled? }` (re-enabling resets the failure state); `DELETE` → 204.
- `POST /api/webhooks/:id/test` (5/min) → `{ ok, status, error, webhook }`, signed `type: "test"` for generic hooks.
- `POST /api/webhooks/:id/secret { keepPrevious? = true }` (generic only, 10/min) → `{ webhook, secret }`; the old secret also signs for 24 h unless `keepPrevious: false`.
- `GET /api/webhooks/:id/deliveries?limit=` (default 30, max 100) → `{ deliveries: [{ id, event, status, attempts, statusCode, error, durationMs, responseExcerpt (non-2xx, ≤ 200 chars), nextAttemptAt, createdAt, updatedAt, canResend }] }`.
- `POST /api/webhooks/:id/deliveries/:deliveryId/resend` (10/min) → 202 with the same delivery id; 409 `WEBHOOK_DISABLED` / `DELIVERY_IN_FLIGHT`; 410 `DELIVERY_GONE`.

### API tokens and connection ranges (docs/adr/1200–1204)
- Every `/api` route accepts `Authorization: Bearer ink_pat_…`. Read-only tokens get 403 on non-GET. Routes in the browser-only table (ADR 1204) answer 403 to any bearer token. OAuth `ink_at_` tokens stay for `/mcp`.
- `GET /api/tokens` → `{ tokens }`; `POST /api/tokens { name, expiresInDays: 30|90|365|null, access: 'read'|'write', range }` → 201 `{ token, secret }` (`no-store`; more than 50 → 409 `TOO_MANY_TOKENS`); `PATCH /api/tokens/:id { name?, range? }`; `DELETE /api/tokens/:id` → 204. Session only.
- Admin (cookie): `GET /api/admin/users/:id/api-tokens`, `DELETE /api/admin/users/:id/api-tokens` → `{ revoked }`, `DELETE /api/admin/api-tokens/:id` → 204.
- OAuth: `POST /api/oauth/authorize` takes an optional `range` (default everything); `GET /api/oauth/grants` items add `range`; `PATCH /api/oauth/grants/:id { range }` (session only).
- `AccessRange = { kind: 'all' } | { kind: 'workspaces', workspaceIds (1–20) } | { kind: 'subtree', pageId }`. Errors: 403 `OUT_OF_RANGE`, 400 `INVALID_RANGE`, 401 for an invalid or expired token.

### find_context (docs/adr/1210–1212)
- `GET /api/context` sections add `short` (the shortest anchor tail unique in the page) and `heading` (last heading); `more` items add the same fields. Existing fields are unchanged; `read_page` and `patch_section` accept the short anchor.

## v0.8.0 additions

### Admin: status (docs/adr/1230–1233)
- `GET /api/admin/status` (admin, browser session only; bearer tokens 403; 30/min). `?refresh=1` recomputes the heavy probes (else cached 5 min). → `{ level: 'ok'|'warn'|'error', generatedAt, groups: [{ id: 'backup'|'storage'|'app'|'security'|'update', level, summary, items: [{ key, group, level: 'ok'|'warn'|'error'|'off', data }] }], issues, cache: { hit, ageSec, ttlSec } }`. `off` means not configured, switched off or not applicable and is never an issue. `data` never holds secret values, paths or the database URL.
- `GET /api/version/latest` adds `securityFix: boolean | null` (a newer release has a Security section; null when there are no notes to read).

### Heavy jobs (docs/adr/1240)
- `GET /api/pages/:id/export?format=zip`, `GET /api/workspaces/:id/export`, `POST /api/workspaces/:id/import`, `POST /api/workspaces/:id/import-folder` and `POST /api/pages/:id/duplicate` may wait up to `HEAVY_JOBS_WAIT_MS` for a slot, then answer 503 `HEAVY_JOBS_BUSY` (queue full or no slot in time) or 429 `HEAVY_JOBS_PER_USER` (the caller already has `HEAVY_JOBS_PER_USER` jobs running or waiting), both with `Retry-After` in seconds.

## v0.9.0 additions: guests and page levels (docs/adr/1250–1253)
All routes below are browser session only.
- `GET /api/pages/:id/access` (members; guests 403) → `{ access: { pageId, people: [{ userId, name, email, level, guest, inheritedFrom: { pageId, title } | null }], invites, myLevel, canManage, canInviteGuests, guestPolicy, private } }`.
- `PUT /api/pages/:id/access { userId | email, level: 'view'|'comment'|'edit'|'full' }` → `{ access, invite?, mailed? }`. An exact email match finds an account; no account → an invitation (`invite.link` when no mail was sent). Owners and admins → 400; guests never `full` → 400; members only by people with full access; new guests per `guestInvitePolicy` (403); nobody above their own level. Bumps the access version and closes the person's sockets in the subtree. Audited.
- `DELETE /api/pages/:id/access/:userId` → `{ access }` (own row = leave, or as for PUT). `DELETE /api/pages/:id/invites/:inviteId` → `{ access }`.
- `GET /api/pages/:id/access/candidates?q=` → `{ candidates: [{ userId, name, email, guest }] }`: members by name or email (people with full access), outsiders only by exact email (guest policy).
- `GET /api/workspaces/:id/guests` (owners, admins) → `{ guests: [{ userId, name, email, pages: [{ pageId, title, level }] }] }`. `POST /api/workspaces/:id/guests/remove { userIds (1–200) }` → `{ removed }`; closes their sockets; audited `guests.removed`.
- `GET /api/page-invites/:token` → `{ invite: { workspaceName, pageTitle, level, invitedBy, emailMatches } }` (404 `INVALID_INVITE`). `POST /api/page-invites/:token/accept` → `{ workspaceId, pageId }` (403 `INVITE_EMAIL_MISMATCH`, 404 `INVALID_INVITE`; rate-limited).
- `PATCH /workspaces/:id/settings` accepts `guestInvitePolicy: 'off'|'owners'|'admins'|'members'`.
- Guests may call only: `GET /workspaces` (`role: 'guest'`, `can` all false, empty `inviteCode`), `GET /workspaces/:id/pages` (shared subtrees, tops with `parentId: null`), `GET /pages/:id/lock` (`level`, `guest`, no editor names), `GET /pages/:id/backlinks`, comments (list, add, edit and delete own), `POST /pages` under an editable shared page, `PATCH /pages/:id` (title, icon, coverUrl, fullWidth; else 403 `GUEST_OUTSIDE`), `POST /files` with an editable `pageId`, `GET /files/:id`, and the collaboration socket. Everything else answers 403.
- New error codes: `PAGE_ACCESS` (`details.level`), `GUEST_OUTSIDE`, `INVITE_EMAIL_MISMATCH`, `INVALID_INVITE`.

## v0.10.0 additions

### Workspace boundaries (docs/adr/1300–1302)
- Someone who is not a member or guest of a workspace gets 404 for its pages, comments, change rows (`GET /api/changes/:seq/diff`), templates (`DELETE /api/templates/:id` → 404 `TEMPLATE_NOT_FOUND`), row properties (`PATCH /api/pages/:id/props` → 404 `NOT_FOUND`), files (`GET /files/:id`), webhooks (`/api/webhooks/:id` and its test, secret, deliveries and resend routes), trash restore and purge, and vault sync write and delete, the same as for an id that does not exist. It was 403 for an existing id, and 403 `TWO_FACTOR_REQUIRED { workspaceId }` for a page of a workspace that requires two-step verification. Moving a page under a page of another workspace answers the same 400 "Parent page is invalid" as a missing parent (docs/adr/1301-*).
- Cross-workspace reads leave a workspace whose two-step requirement blocks the caller out instead of refusing: `GET /api/changes` and `GET /api/inbox` without `workspaceId`, `GET /api/context` without `workspaceId`, `GET /api/pages/read` (such pages are listed under `missing`), `GET /api/pages/agent-context`, member candidates and the subscription list in notification settings. Notification mail (instant and digest) drops its items; they stay in the app. `DELETE /api/workspaces/:id` and `POST /api/workspaces/:id/restore` by an owner blocked by the requirement → 403 `TWO_FACTOR_REQUIRED` (docs/adr/1300-*).
- `DELETE /api/comments/:id` needs the comment right on the page, like posting and editing: 403 `PAGE_LOCKED` or 403 `PAGE_ACCESS` otherwise (docs/adr/0971-*, 1251-*).
- Public file routes (`/api/public/:token/f/:fileId`, `/api/public/:token/p/:ref/f/:fileId`): the file's own page must be the shared page, or the folder or a page of its subtree; otherwise 404 (docs/adr/1302-*).

### Query blocks (docs/adr/1320, 1352)
- `POST /api/workspaces/:id/query`, `rows[].cells`: a column that names a collection person field holds the member's display name (`null` when the stored id is not a member of the workspace); a column that names a relation field holds `QueryPageRef[]` (`[{ ref: 'page', pageId, title }]`) for the linked rows the caller can see, in stored order (hidden, trashed and other-collection links are left out, and their ids are not sent). Other columns are unchanged. Only bare field columns are converted (`TABLE Owner`, `LIST Owner`). `elapsedMs` now includes this display pass (docs/adr/1320-*).
- In `WHERE`, `SORT`, `contains()` and comparisons, a person field of a collection row compares as the member's name (no value for a non-member) and a relation field as the list of titles of the linked rows the caller can see (in stored order; `SORT` uses them joined with ", "). `=`, `!=` and `contains()` with a string also match the stored id of a member or of a visible linked row. Other values compare as stored. Matching is exact and case-sensitive (docs/adr/1352-*).

### Collections (docs/adr/1351, 1353)
- `ViewConfig` (table) adds `columnWidths: { [fieldId]: number }`, the width of a field's column in px (integer 150–1600, at most 200 entries; a field without an entry is sized by the pane), and `titleWidth`, the width of the title column in px (integer 240–1600). Out-of-range values are a 400 `VALIDATION` like any other invalid config. `PATCH /api/collection-views/:id` still replaces the whole config: a client that sends a config without these keys removes the widths. Template export and import carry them (docs/adr/1351-*).
- `PUT /api/pages/:id/collection/fields`: 400 `VALIDATION` "Relation target collection not found" when a relation that is new, re-targeted or switched to two-way points at a collection that does not exist or that the caller cannot see (the two cases answer the same), or when a new or changed rollup uses such a relation. Relation fields and rollups sent back unchanged pass even when the caller cannot see their target (docs/adr/1353-*).

### Ink (docs/adr/1340)
- `GET /api/pages/:id/ink` → `{ ink: InkDTO { pageId, strokes, updatedAt | null } }`. `PUT /api/pages/:id/ink { strokes, expectedUpdatedAt?: ISO | null }` → `{ ink }` (edit lock applies). With `expectedUpdatedAt` a version mismatch answers 412 `INK_CONFLICT` with the current ink in `error.ink` (docs/adr/0815-*). New: a PUT without `expectedUpdatedAt` that would replace non-empty ink with `[]` also answers 412 `INK_CONFLICT` and writes nothing. Versioned clears and unversioned saves of non-empty lists behave as before (last write wins).

## v0.11.0 additions

### Later list and followed threads (docs/adr/1410–1413)
Migration `0039_v011_later_threads` adds `later_items`, `thread_follows` and two columns on `user_notification_settings`.

| Method | Path | Body / query | Response |
|---|---|---|---|
| GET | `/api/later` | `workspaceId?, state=open\|done` | `{ items: LaterItemDTO[], open, due }` — the caller's items, newest first (≤ 200). `accessible: false` items carry no title, preview, actor, anchor or notification type. Items of workspaces outside a token's range or blocked for the agent are left out. Read-only tokens may call it (MCP `later`) |
| GET | `/api/later/target` | exactly one of `pageId`, `threadId`, `notificationId`, `id` | `{ item: LaterItemDTO \| null }` — is this target on my list |
| POST | `/api/later` | `{ kind: 'page'\|'thread'\|'notification', pageId?, threadId?, notificationId?, anchor?, remindAt?: ISO \| null, remindTz? }` | 201 (new) / 200 (already saved: reopened; a `remindAt` in the body replaces the reminder) `{ item }`. 404 when the caller cannot see the target (outsiders included); 400 for a workspace-level notification, a reminder in the past (more than 1 min) or more than 732 days ahead; 409 `LATER_FULL` at 500 open items |
| PATCH | `/api/later/:id` | `{ done?: boolean, remindAt?: ISO \| null, remindTz? }` | `{ item }` — own items only (404 otherwise). A new `remindAt` re-arms the reminder |
| DELETE | `/api/later/:id` | | 204 |
| GET | `/api/threads` | `workspaceId, all=0\|1` | `{ threads: ThreadSummaryDTO[], unread }` — followed threads with replies by others since `lastReadAt` (all=1: every followed thread), newest activity first (≤ 100); pages the caller cannot see are left out. Guests: inside their shared trees |
| GET | `/api/pages/:id/thread-follows` | | `{ follows: ThreadFollowDTO[] }` — the caller's rows on this page |
| GET | `/api/threads/:id/follow` | | `ThreadFollowDTO` (`source: null` = no row) |
| PUT | `/api/threads/:id/follow` | `{ following: boolean }` | `ThreadFollowDTO`. Following by hand reads the thread up to now. 404 for a reply id or a thread the caller cannot see |
| POST | `/api/threads/:id/read` | `{}` | `{ ok, notificationsRead }` — reads the thread and marks the caller's unread bell rows of it (`cr:`/`c:`/`cm:` group keys) read |

Changed:
- `GET/PATCH /api/me/notification-settings`: `NotificationSettingsDTO` adds `threadAutoFollow` (default true) and `threadReplies` (default true); PATCH accepts both.
- `POST /api/notifications/read` with `ids`: comment, reply and mention items also mark their thread read in `GET /api/threads`. Without `ids` ("mark all read") threads are not touched.
- `NotificationType` adds `later_reminder` (no actor; passes mute and the hourly caps; instant mail; not an agent inbox item).
- `POST /api/pages/:id/comments`: the author follows the thread (unless `threadAutoFollow` is off; an earlier unfollow stays) and has it read up to now. `comment_reply` goes to the thread's followers with `threadReplies` on, instead of everyone who wrote in the thread; the agent inbox `reply` kind follows the same rule. The migration makes every earlier author of a thread follow it, so the recipients are the same right after the upgrade.
- Sidebar menu ids (`SIDEBAR_MENU_IDS`) add `later` and `threads`, after `search`. A saved order without them shows them at their default place.
- MCP: `later(workspaceId?, state?, budget?)`, read ([MCP.md](MCP.md), docs/adr/1413-*).

## v0.12.0 additions

Migrations `0040_v012_agent_ink_setting` (`workspaces.agent_ink_read`) and `0041_v012_suggestions_leases`
(`section_suggestions`, `section_leases`, `agent_edit_policies`, `catch_up_markers`; catch_up markers move out of
`plugin_storage`).

### Agent notation and renamed sections (docs/adr/1500–1501)
- `GET /api/pages/:id/export?format=md&notation=agent`: new optional `notation` (`plain` default | `agent`), the round-trip notation MCP `read_page` uses (callouts `> [!type]`, mentions `@[Name](user:<id>)`, embeds, plugin, file and audio blocks as `<!-- inkling:… -->` lines). Plain Markdown exports now carry callouts as `> [!type] text` and mention chips as `@Name`; embeds and plugin blocks are still left out (docs/adr/1500-*).
- `GET /api/pages/:id/section`: the answer may carry `movedFrom: "<ref as given>"` when the reference was an anchor from before a heading rename; `section.anchor` is the new one. An old name that now leads to several sections → 409 `SECTION_AMBIGUOUS` ("Section "x" was renamed and now matches several sections: a, b. Use one of these anchors.") (docs/adr/1501-*).
- `POST /api/pages/:id/section`: success and 409 `SECTION_CONFLICT` bodies may carry `movedFrom`; the same 409 `SECTION_AMBIGUOUS`.
- `POST /api/pages/:id/content` (`mode=replace`): a minimal edit of the document (block ids kept); the response is unchanged.

### Handwriting, versions, trash and files for agents (docs/adr/1510–1514)
- `GET /api/workspaces/:id/settings`: `settings.agentInkRead: boolean` ("Agents can read handwriting", default false).
- `PUT /api/workspaces/:id/settings/agent-ink { enabled: boolean }` (strict): owners and admins, browser sessions only (tokens 403). Audited as `settings.updated` with `{ agentInkRead }` before and after. Answers `{ settings, role, can }` like `PATCH /settings`; 403 for members, 404 for a workspace that does not exist (docs/adr/1510-*).
- `GET /api/pages/:id/ink`: for agent (OAuth/MCP) requests in a workspace where the setting is off, 403 `AGENT_INK_OFF`. Browser sessions and personal API tokens are unchanged.
- `GET /api/files/:id/meta` (new) → `{ file: { id, url, name, mime, size, workspaceId, pageId, createdAt } }`. Same checks as `GET /files/:id` (member or guest; the file's page visible now; guests only files of pages shared with them; 404 otherwise, also when the stored file is missing). A connection limited to a subtree gets 403 `OUT_OF_RANGE` for legacy files without a page. Read-only tokens may call it (docs/adr/1514-*).
- `POST /api/pages/:id/snapshots/:sid/restore`: checked with the workspace access state and applied under the write gate (docs/adr/1151-*, 1513-*): an edit lock or member removal committed while the restore runs answers 403 `PAGE_LOCKED` / 403 and leaves the page untouched. The "Before restore" snapshot carries `viaClient` for agent requests, and the change feed records the restoring person (and client).

### catch_up, collection structure and MCP requests (docs/adr/1520–1526, 1537)

| Method | Path | Request | Response |
|---|---|---|---|
| GET | `/api/catch-up` | `since?`, `workspaceId?`, `budget?` (≤ 12,000, default 4,000), `advance?` (`0` leaves the marker) | `{ text, cursor, since: { at, source: 'given'\|'connection'\|'person'\|'default' }, counts: { pages, comments, forYou, due, later, listed, hidden }, tokens }`. Ranked "while you were away" text for the caller: inbox items created after `since`, due items (today − 14 days … + 7 days, undone), Later reminders due or within 7 days, comments created after `since`, change-log rows after `since` grouped per page (edits, people and clients, section diffs). `since`: a catch_up cursor, a `changes_since` cursor or an ISO time; omitted → the caller's last catch_up marker (per OAuth grant or API token, and per `workspaceId`, in `catch_up_markers`), else the person's, else 24 hours. 400 `INVALID_SINCE`; `workspaceId` requires membership. Read-only tokens may call it (it writes only the caller's marker). Same visibility as `/changes`, `/inbox`, `/later` and the due view. 30/min |

- `POST /api/pages/:id/collection/rows`: relation values in `props` are stored in the row's transaction with the rules of `PATCH /props`: ids that are not live rows of the target collection visible to the caller are dropped; for a two-way relation the target rows must be editable (else 403 `PAGE_LOCKED` / `PAGE_ACCESS` and no row is created) and the paired field is mirrored (docs/adr/1524-*).
- `PUT /api/pages/:id/collection/fields` runs under the write gate (docs/adr/1071-*): a lock, agent block or role change committed after the edit-lock check is re-checked in the transaction (docs/adr/1523-*).
- `POST /mcp`: the bearer token is checked before the body is read (no valid token: 401 without parsing, also for a body that is not JSON); bodies with more than 20,000 JSON values → 413 `TOO_MANY_VALUES`. Body limit 12 MB (docs/adr/1526-*).
- JSON-output MCP tools clean member-written strings and add a trailing `untrusted` key (objects) or a second text block (arrays); `create_page`, `rename_page` and `move_page` add `applies` when agent instructions apply (docs/adr/1525-*).

### Suggestions and section claims (docs/adr/1530–1539)

| Method | Path | Request | Response |
|---|---|---|---|
| GET | `/api/pages/:id/suggestions` | `preview=1`, `all=1` | `{ suggestions: SuggestionDTO[], claims: SectionClaimDTO[], canDecide }`. Open suggestions of the page (`all=1`: also accepted, rejected, withdrawn), live section claims, and whether the caller may accept or reject. `preview=1` adds to each open suggestion `preview { found, currentAnchor, currentVersion, changed, before, after, ops: DiffOpDTO[] \| null, large }`. Members only (guests: 404); visible page, agent blocks and the connection's range apply |
| GET | `/api/suggestions` | | `{ suggestions }`: the caller's own, open and decided in the last 7 days |
| GET | `/api/suggestions/:id` | `preview=1` | `{ suggestion }` |
| POST | `/api/suggestions/:id/accept` | `{ confirmChanged?: boolean }` | `{ suggestion }`. People only (browser session or personal API token; OAuth/MCP → 403 `PEOPLE_DECIDE`), edit access. 409 `SUGGESTION_CHANGED { preview }` when the section changed since the agent read it and `confirmChanged` is not set; 409 `SECTION_GONE { preview }`; 409 `SUGGESTION_DECIDED`. 30/min |
| POST | `/api/suggestions/:id/reject` | | `{ suggestion }`. People only, edit access |
| POST | `/api/suggestions/:id/withdraw` | | `{ suggestion }`. The author (agents too) |
| POST | `/api/pages/:id/claims` | `{ section, ttlSeconds? }` (30–1800, default 300) | `{ claim: SectionClaimDTO }`. Bearer connections only (400 for browser sessions); doc pages; the caller must be able to edit or suggest there. 409 `SECTION_CLAIMED` when another connection holds it; 429 `TOO_MANY_CLAIMS` above 20 live claims per connection. 60/min |
| DELETE | `/api/pages/:id/claims` | `section` | `{ released: boolean }` |

`SuggestionDTO { id, pageId, workspaceId, anchor, headingPath, blockId, mode: replace|append|prepend|insert_after|delete|page_replace|page_append, origin: 'asked'|'lock'|'policy', status: open|accepted|rejected|superseded|withdrawn, markdown, baseVersion, author { id, name }, via, createdAt, decidedBy, decidedAt, rule, reviewReason, autoAt, applied?, preview? }`. `SectionClaimDTO { pageId, anchor, blockId, by, userId, mine, expiresAt }`. At most 100 open suggestions per page.

Changed:
- `POST /api/pages/:id/section` takes `suggest?: boolean`. Answers `202 { suggestion }` when the change was kept as a suggestion (asked, or the agent edit policy or lock of the page). For bearer connections, 409 `SECTION_CLAIMED { claim }` when another connection claims the section (suggestions are not stopped by claims).
- `POST /api/pages/:id/content` answers `202 { suggestion }` where agent edits become suggestions (`page_replace` / `page_append`); `mode: replace` gets 409 `SECTION_CLAIMED` while another connection claims a section of the page.
- `GET /api/pages/:id/outline` adds `claims` and `GET /api/pages/:id/section` adds `claim` when there are live claims.
- `NotificationType` `approval_request` (to the page's owner, else its creator, for a new suggestion) and `approval_result` (to the author of a decided suggestion; an agent inbox kind) now have producers (docs/adr/1534-*).

### Saving tokens (docs/adr/1540–1543)

| Method | Path | Request | Response |
|---|---|---|---|
| POST | `/api/pages/:id/sections` | `{ edits: [{ ref, markdown, mode: replace\|append\|prepend\|insert_after\|delete, baseVersion? }], suggest? }` (1–20 edits, ≤ 2,000,000 characters of Markdown in total) | `{ ok, results: [{index, section: {anchor, headingPath, version} \| null, movedFrom?}], sections }`. Doc pages only; edits apply in order, all or nothing. Any failure → 409 `SECTIONS_CONFLICT` with `error.conflicts: [{index, ref, anchor?, reason: version\|not_found\|ambiguous\|duplicate\|empty\|claimed\|invalid, message, baseVersion?, version?, markdown?}]` and `error.anchors` (first 50), nothing written. With `suggest`, or where agent edits become suggestions: `202 { suggestions: SuggestionDTO[] }`, all or none (a bad section answers the single error of `POST /section`, e.g. 404 `SECTION_NOT_FOUND`) (docs/adr/1538-*). One "Before AI edit" snapshot when any edit is replace/delete (≤ 1 per page per 2 min). 30/min (docs/adr/1542-*) |

- `GET /api/pages/read` takes `known?` (`id:version,…`, the page versions the caller has). Each page adds `version` (hash of kind, title, properties and body); with `known`, `unchanged: [{id, title, kind, updatedAt, version}]` lists known pages whose version is the same, without body or budget (docs/adr/1540-*).
- `GET /api/workspaces` is ordered by creation time, then id (docs/adr/1543-*).

### Agent edit policy and auto-accept rules (docs/adr/1544–1545)

| Method | Path | Request | Response |
|---|---|---|---|
| GET | `/api/workspaces/:id/agent-policy` | | `{ policy: AgentPolicyDTO }`. Members |
| PUT | `/api/workspaces/:id/agent-policy` | `{ level: 'direct'\|'auto'\|'review', rules }` | `{ policy }`. Owners and admins, browser session only; audited as `agent_policy.changed` |
| GET | `/api/pages/:id/agent-rules` | | `{ policy }`: the rules of an "Accept by rules" lock node (defaults when unset) |
| PUT | `/api/pages/:id/agent-rules` | `{ rules }` | `{ policy }`. Who may manage the page's lock, browser session only; audited |

`rules = { modes: ('append'|'insert_after'|'prepend'|'replace'|'delete')[], connections: ('grant:<id>'|'token:<id>')[], maxLines: number|null, maxChars: number|null, graceMinutes: 0–10080 }` (defaults: append, insert_after, prepend; every connection; no limits; no wait). `AgentPolicyDTO { level, rules, canManage, updatedBy, updatedAt }`.

Changed:
- `PUT /api/pages/:id/lock`: `agents` takes `'same' | 'direct' | 'auto' | 'suggest' | 'comment' | 'read'`; `'same'` now means "follow the workspace default". `GET` returns it.
- `POST /api/pages/:id/section`, `/sections` and `/content` may answer 202 with a suggestion that was accepted at once by a rule (`status: 'accepted'`, `rule`, `applied`), or one that waits (`autoAt` for a grace period, `reviewReason` when no rule matched).

### Several agents at once (docs/adr/1550–1552)
- `GET /api/context`: unchanged contract; answers may come from a per-person cache keyed by the permission state and index markers of the searched workspaces (docs/adr/1550-*).
- `GET /api/workspaces/:id/agents` → `{ connections: AgentConnectionDTO[], blocks: AgentBlockDTO[], usageSince }`; each connection adds `usage: { calls, errors, tokens, cacheHits, lastUsedAt } | null` for the calls that reached this workspace since `usageSince` (server start, per process). Numbers only (docs/adr/1552-*).
- `GET /api/admin/status` adds `agents: { since, totals: { connections, calls, errors, tokens, cacheHits }, cache: { hits, misses, entries, bytes }, waiting, connections: [{ kind: 'agent'|'token', id, name, user: { id, name } | null, calls, errors, tokens, cacheHits, avgMs, p95Ms, waitSec, lastUsedAt }], more }`: live (not part of the 5-minute probe cache), the 50 most recently used connections since the server started.
- `GET /api/changes` is unchanged; the long-poll `wait` exists only on the MCP tool (docs/adr/1551-*).

### MCP tools
New: `catch_up(workspaceId?, since?, budget?, peek?)`, `read_ink(pageId, top?, height?, scale?)`, `list_versions`, `diff_versions`, `read_file`, `list_trash`, `list_suggestions(pageId?)` (read); `patch_sections(pageId, edits, suggest?)`, `create_collection(workspaceId, title, fields[], parentId?, private?)`, `update_fields(collectionId, add?, change?, remove?, order?)`, `restore_version`, `restore_page`, `withdraw_suggestion(id)`, `claim_section(pageId, section, minutes?)`, `release_section(pageId, section)` (write, refused for read-only connections). New arguments: `read_page(…, known?, knownSections?)`, `read_pages(…, known?)`, `list_pages` / `search` `format: "compact"`, `patch_section(…, suggest?)`, `changes_since(…, wait?)` (0–25 s, only with a cursor; over the per-process (256) or per-connection (4) limit of waiting calls, or during shutdown, the answer comes at once and starts with `wait skipped: …`). Details: [MCP.md](MCP.md).

## v0.13.0 additions

No migration. `collection_views.type` may be `chart` and `section_suggestions.status` may be `accepted_partial` (text
columns without a CHECK). Stored suggestion bases live in `plugin_storage` under the plugin id `inkling:suggestion_base`.

### Charts (docs/adr/1600–1606)

| Method | Path | Request | Response |
|---|---|---|---|
| POST | `/api/workspaces/:id/charts/aggregate` | `ChartAggregateInput` (below) | `ChartDataDTO` (below). Groups and measures the rows of a collection, or of a query block query, as the caller, with the collection query's access rules. Read-only tokens may call it. 240/min (docs/adr/1602-*) |

`ChartAggregateInput`:

| Field | Type | |
|---|---|---|
| `source` | `{ "type": "collection", "collectionId": uuid, "viewId"?: uuid }` or `{ "type": "query", "query": string }` | `viewId`: a view of that collection; its saved filters choose the rows |
| `groupBy` | `{ "field": string, "bucket"?: "day" \| "week" \| "month" }` | field id or `"title"` (collection); column name (query) |
| `series` | same as `groupBy`, optional | second grouping |
| `measure` | `{ "fn": "count" \| "sum" \| "avg" \| "min" \| "max", "field"?: string }`, optional | default count; `field` (a number or rollup field / a column) for the others |
| `sort` | `"auto" \| "label" \| "valueDesc" \| "valueAsc"`, optional | auto: option / date order, else largest first; "no value" last |
| `limit` | 1–100, optional | groups returned (the rest are counted in `omittedGroups`) |
| `today`, `tzOffsetMinutes` | optional | query sources, as `POST /query` |

`ChartDataDTO`: `source` (`{type:'collection', id, title, viewName?}` or `{type:'query'}`), `group` / `series`
(`{field, name, type, bucket?}`), `measure` (`{fn, field?, name?}`), `groups` (`[{key, label, special?}]`, `key` null
for "no value", `special` `empty` / `checked` / `unchecked`), `seriesKeys?`, `values` (`(number|null)[]`, or
`[group][series]`), `rowCount`, `omittedGroups`, `omittedSeries`, `truncated?` (the query returned part of its rows),
`elapsedMs`, `cached?`.

Groupable field types: select, multi-select, person, date, checkbox, relation, text, URL, number and the title;
measurable: number and rollup. People are member names (a non-member's id is "no value"); relations are the titles of
visible linked rows. Errors: 404 `NOT_FOUND` (workspace, collection or view missing, hidden, of another workspace, or
not a collection), 403 for non-members / guests / out-of-range tokens, 400 `INVALID_CHART` (unknown field, a field that
cannot group or measure), 400 `QUERY_SYNTAX` / `QUERY_TIMEOUT`.

Changed:
- `POST /api/pages/:id/collection/views` takes `config` (optional, `ViewConfig`, same shape as `PATCH`). View `type`
  may be `chart`; `ViewConfig.chart` = `{ kind, groupBy, series?, measure?, sort?, limit?, title?, options? }`
  (docs/adr/1603-*).
- Page blocks: a `chart` block has one prop, `config` (canonical JSON of `{ source, kind, groupBy, … }`, `''` while
  being set up). Agent notation: `<!-- inkling:chart {config} -->`; `read_page` adds `<!-- inkling:chart-data … -->`
  under it, which writes ignore (docs/adr/1604-*).
- Markdown export (`GET /api/pages/:id/export?format=md`) writes a chart as a table of its numbers; public folder links
  show a table only for charts whose database is inside the link (docs/adr/1605-*).

### Suggestions in parts (docs/adr/1621, 1622, 1626)

| Method | Path | Request | Response |
|---|---|---|---|
| GET | `/api/pages/:id/suggestions` | `preview=1`, `status?`, `all=1` | As in 0.12. `status` = `open` (default) \| `decided` (accepted, accepted_partial, rejected) \| `all` \| one status; `all=1` is still the web history (everything but superseded). With `preview=1`, an open `replace` suggestion's `preview` adds `merge: { baseKnown, key, hunks: [{ id, conflict, same, before, after, ours, context }] }` (absent when the section is gone or too large to split) |
| GET | `/api/suggestions` | `status?` | `{ suggestions }`: the caller's own, the same filter, default `open`, newest 50 |
| POST | `/api/suggestions/:id/accept` | `{ confirmChanged?, hunks?: number[], mergeKey?: string }` | `{ suggestion }`. `hunks` (ids from `preview.merge`, with its `key` as `mergeKey`) applies only those hunks: the server recomputes the merge and writes the merged section; a stale `mergeKey` → 409 `SUGGESTION_CHANGED` with `error.preview`. `status` is `accepted` or `accepted_partial` (`partial: { applied, total }`). Without `hunks` it behaves as in 0.12 |
| POST | `/api/suggestions/:id/withdraw` | | `{ suggestion }`. A suggestion that is no longer open answers 409 per state (below) |

`SuggestionDTO` adds `supersededBy?` (the newer suggestion of the same connection for the same section) and `partial?`
(`{ applied, total }`). `status` adds `accepted_partial`. 409 codes of accept and withdraw: `SUGGESTION_SUPERSEDED`,
`SUGGESTION_WITHDRAWN`, `SUGGESTION_DECIDED`, `SUGGESTION_UNSPLITTABLE` (too large to split into hunks), `SECTION_GONE`;
each message says the state, by whom, and for a replaced one the id of the newer suggestion.

### Reverting changes (docs/adr/1620, 1623, 1624)

People only (browser session or personal API token; agent connections → 403 `PEOPLE_DECIDE`). Every revert route takes
`dryRun` for the preview.

| Method | Path | Request | Response |
|---|---|---|---|
| GET | `/api/pages/:id/changes` | `before?` (seq), `limit?` (1–100, default 20) | `{ items: ActivityItemDTO[], next }`: the page's own change log, newest first; each item has `revert` (below) |
| POST | `/api/changes/:seq/revert` | `{ dryRun? }` | `RevertResultDTO`. One change; edit access to its page. 404 when the change or its page is not visible. 30/min |
| POST | `/api/pages/:id/revert` | `{ seqs? (1–200) \| via, actorId?, since?, until?, dryRun? }` | `RevertResultDTO`. Given changes, or one agent's (`via` = client name, `actorId` narrows to one member's connection) on the page in a period; `seqs` or `via` is required (400 otherwise). 30/min |
| POST | `/api/workspaces/:id/revert` | `{ via, actorId?, since, until?, dryRun? }` | `RevertResultDTO`. One agent's changes in the workspace; owners and admins. Each page is written all or nothing; locked pages are reported. 10/min |

`RevertResultDTO { dryRun, pages: [{ pageId, title, written, error?: { code, message }, changes: [{ seq, kind, anchor,
headingPath, via, actor, changedAt, outcome, applied, conflicts: [{ wanted, now, reason: 'overlap' | 'no_source' }],
plainText, reason? }] }], totals: { pages, changes, applied, partial, conflicts, unsupported, noop }, truncated }`.
`outcome`: `applied` | `partial` | `conflict` | `noop` | `unsupported`; `reason` (unsupported): `large` | `page_event` |
`moved` | `heading_only` | `section_gone` | `section_exists` | `no_source` | `too_complex`. At most 300 changes per call
(`truncated` when more matched; call again). Each written page gets a "Before revert" version first; the revert is an
ordinary change of the person, audited as `page.changes_reverted` (`before.seqs`, `before.via`, `after.seqs`,
`after.conflicts`).

`GET /api/workspaces/:id/activity` and `GET /api/pages/:id/changes` items gain `revert: { revertable, revertedBy: { name,
at } | null, isRevert }`.

### Change feed (docs/adr/1625, 1650–1653)
- `page_changes.kind` and activity `kind` gain `page_props` (row properties changed; `after` = the changed field names).
  The activity filter `kind=page` includes it, `kind=edit` does not (docs/adr/1650-*).
- `GET /api/changes` text has new line forms: `collection added:`, `row added:`, `rows added: N to collection …` (ten or
  more rows of one collection in one answer), `  properties: …` and `  trashed, then restored` (docs/adr/1650–1652).
- `PATCH /api/pages/:id/collection/rows/batch` runs in one transaction also without person cells and logs title changes
  (`page_renamed`) and `page_props`.
- Editor typing rows carry the typist as actor when one person typed since the last index pass; a REST/MCP write logs
  pending typing before its own change (docs/adr/1625-*).
- `GET /api/catch-up`: "Pages changed by others" means changes by another identified person; edits without an actor are
  counted as `unattributed edits N` (docs/adr/1653-*).

### MCP tools
New: `create_chart(pageId, section?, placement?, collectionId? | query?, view?, kind, groupBy, bucket?, series?, seriesBucket?, measure?,
measureField?, sort?, limit?, title?, options?, suggest?)` and `create_view(collectionId, type, name, config?, chart?)` (write,
refused for read-only connections). New arguments: `list_suggestions(…, status?)`. Changed output: `read_page` shows
chart tokens with a data line and section claims on every read form; `changes_since` and `catch_up` list collections,
rows and row properties; `query_rows describe=true` is wrapped in `<untrusted_content>`. Details: [MCP.md](MCP.md).

## v0.14.0 additions

One migration, `0042_v014_semantic_vectors`: table `page_chunk_vectors` (`page_id`, `text_hash`, `workspace_id`,
`model`, `dims`, `embedding real[]`), written only while semantic search is on (docs/adr/1741-*). No other schema
change.

### find_context with several queries (docs/adr/1720–1723)
- `GET /api/context`: `q` may repeat (`?q=a&q=b`, at most 5 different values after NFKC / lower case / space
  normalisation, else 400). One distinct value: unchanged contract and output. Two or more: the merged result adds
  `queries` and a `matched` array per fragment; `fragments[].score` is the RRF score; `more` and `titleOnly` keep
  their shape (a `more` item from an extra ranked list may have `anchor: ""` (whole page) and `tokens: 0`)
  (docs/adr/1720-*, 1722-*).
- While semantic search is on (docs/adr/1740-*), one `q` also returns `queries` and `fragments[].matched`; fragments
  may come from semantic candidates (`matched` names the query number) (docs/adr/1723-*).
- Ranking (no shape change): Korean query words also match their forms with particles and endings ("백업을" → 백업,
  "팀을" → 팀/팀에/팀의 as whole words), and a compound written without a space also matches the spaced words
  ("팀구성" → "팀 구성"). Page aliases count as the page title; heading weight is 0.3 (docs/adr/1700-*, 1701-*).

### Admin: semantic search state (docs/adr/1744)
`GET /api/admin/status` gains an optional field, present only while semantic search is on (`EMBEDDING_URL` and
`EMBEDDING_MODEL` set); off, the response is unchanged:

```json
"semantic": {
  "enabled": true,
  "model": "bge-m3",
  "endpoint": "http://192.168.0.10:11434/v1/embeddings",
  "dims": 1024,
  "sections": { "indexed": 980, "pending": 20 },
  "chunks": { "indexed": 1210, "pending": 30, "rejected": 0 },
  "lastError": { "at": "2026-11-10T03:00:00.000Z", "message": "http://…/embeddings: timeout after 30000 ms" },
  "lastSuccessAt": "2026-11-10T03:01:00.000Z",
  "backoffUntil": null,
  "cache": { "workspaces": 2, "bytes": 5242880 }
}
```

`endpoint` is scheme, host and path only; the API key never appears. Counts are cached 30 s. When the counts cannot be
read the field is `{ "enabled": true, "error": "status query failed" }` (or `"unavailable"`), and the rest of the
status answers as usual.

### MCP tools
New arguments: `find_context(…, queries?)` (up to 5 phrasings; `query` becomes optional, one of the two is required).
Changed output: with several queries the header names them by number and each fragment's paren line ends with
`; matched: 1,3`; with semantic search on, a section found only by meaning is shown with its text. Details:
[MCP.md](MCP.md).

## v0.15.0 additions

Four migrations: `0043_v015_slack` (`slack_integrations`, `slack_user_links`, `slack_link_codes`,
`slack_request_nonces`), `0044_wave13_forms` (`collection_form_links`), `0045_wave13_verify_present_status`
(`pages.share_starts_at`, `page_verifications`, `user_statuses`) and `0046_wave13_team_agents`
(`notifications.connection`, `notifications.person_too`, `user_notification_settings.agent_handoff_copy`). Formula
fields and form views live in the existing jsonb columns (`collection_fields`, view `config`); `collection_views.type`
may be `form`.

### Slack app (docs/adr/1800–1806)

Settings (session cookie, workspace owners; others 403):

| Method | Path | Request | Response |
|---|---|---|---|
| GET | `/api/workspaces/:id/slack` | – | `SlackSettingsResponse { integration: SlackIntegrationDTO \| null, setup: SlackSetupInfo }`. Never contains the token or the secret (`botTokenHint` is `xoxb-…` + the last 4 characters) |
| PUT | `/api/workspaces/:id/slack` | `{ botToken?, signingSecret?, channelId, events: SlackEventKind[], enabled? }` | `{ integration }`. Token and secret are required the first time (400 `SLACK_SECRETS_REQUIRED`), omitted later = keep. Runs Slack's `auth.test`: 400 `SLACK_AUTH_FAILED` with `error.slackError` (Slack's code). Clears a pause. Audit: `settings.updated`, target `slack` |
| DELETE | `/api/workspaces/:id/slack` | – | Disconnect; removes links, link codes and pending Slack jobs |
| POST | `/api/workspaces/:id/slack/test` | – | Posts a test message → `{ ok, error }` (Slack's code). A pass clears a pause |
| GET | `/api/workspaces/:id/slack/links` | – | `{ links: SlackLinkDTO[] }` |
| DELETE | `/api/workspaces/:id/slack/links/:userId` | – | Removes one member's link |

Event kinds (`SLACK_EVENT_KINDS`): `mention`, `assigned`, `suggestion`, `reply`, `digest`. Bot scopes
(`SLACK_BOT_SCOPES`): `chat:write chat:write.public commands links:read links:write users:read users:read.email`.

Linking (signed-in member; the `/slack/link` page of the web app calls these):

| Method | Path | Request | Response |
|---|---|---|---|
| POST | `/api/slack/link/preview` | `{ code }` | `SlackLinkPreviewDTO`; 404 unknown, expired or used code, 403 not a member of the workspace |
| POST | `/api/slack/link/confirm` | `{ code }` | `{ ok, workspaceId }`; the code works once |

From Slack (no session; the body is checked against the v0 signature, a 5-minute timestamp window, the team ID and the
replay table; a failed check is 401 without detail):

| Method | Path | Request | Response |
|---|---|---|---|
| POST | `/api/slack/w/:workspaceId/commands` | Slash command (form-encoded). Text: `<words>`, `help`, `link`, `unlink` | Always `response_type: ephemeral`. Slack's `ssl_check=1` answers 200 |
| POST | `/api/slack/w/:workspaceId/events` | Events API JSON: `url_verification`, `event_callback` with `link_shared`, `app_uninstalled`, `tokens_revoked` | `{ challenge }` for `url_verification` (unsigned only while no app is saved for a live workspace); otherwise 200 at once, unfurls are answered later through the outbox. A body that is not JSON is 400 |

### Form views and public forms (docs/adr/1820–1822, 1870)

- `viewTypeSchema` gains `form`; `ViewConfig.form = { title?, description?, fields: [{ fieldId, required?,
  description? }], submitLabel?, successMessage? }` (`fieldId: "title"` = the row title; up to 50 questions). A form
  asks text, number, select, multiSelect, date, checkbox, url and (members only) person properties.

| Method | Path | Request | Response |
|---|---|---|---|
| GET | `/api/collection-views/:id/form-link` | – | `{ shared, token, canPublish }` for members who see the collection; 400 when the view is not a form |
| POST | `/api/collection-views/:id/form-link` | – | Turn the public link on (owners and admins; 403 otherwise; 400 private collection or not a form; 403 `PUBLIC_SHARING_DISABLED`). Idempotent. Audit `form.published` |
| DELETE | `/api/collection-views/:id/form-link` | – | Turn it off (owners and admins, or anyone who can edit the collection). Audit `form.unpublished` |
| GET | `/api/public/forms/:token` | – (no session) | `PublicFormDTO { title, description, submitLabel, successMessage, fields: [{ key, name, type, required, description, options? }], honeypot }`. 60/min per IP. `Cache-Control: no-store`, `X-Robots-Tag: noindex, nofollow`, `Referrer-Policy: no-referrer` |
| POST | `/api/public/forms/:token` | `{ values: { [key]: answer }, website?: "" }` (strict; `website` is the honeypot) | `{ ok: true }`. 400 `FORM_INVALID` (`fields: { key: "required" \| "invalid" }`), 404 closed or unknown link, 413 over 32 KiB, 429 `RATE_LIMITED` (10/min per IP, or 300/hour for the form) |

Answers: text string ≤ 5,000 characters; number (or a numeric string); select/multiSelect option id or name; date
`YYYY-MM-DD`; checkbox `true`/`"on"`; url ≤ 2,000 characters without spaces. Person, relation and formula properties
are never taken from a public answer. The web page is `/f/:token`; it shares no route or gate with page links
(`/api/public/:token`). A guessed token counts as a failure for the IP ban (reason `form-token`).

A public answer is made as the member who turned the link on, with `via = "public form"` (`pages.created_via`,
`page_changes.via_client`). It counts as a person's input (docs/adr/1870-*):
- `GET /api/workspaces/:id/activity?actor=human` includes public form answers; `actor=ai`, `aiPagesOnly=1` and the
  clients list leave them out.
- `GET /api/pages/:id/provenance` gives `createdVia: null` and no `lastAgentEdit` for them.
- Labels still say it: catch_up, the change feed, mail, webhooks and the inbox print "<publisher> via public form".
- `POST /oauth/register` and `POST /api/oauth/authorize` refuse the client name "public form" (folded) like the
  other reserved words (400).

### Formula fields (docs/adr/1823–1827)

- `CollectionField.type` gains `formula`; `CollectionField.formula = { expression: string }` (≤ 2,000 characters).
  `PUT /api/pages/:id/collection/fields`: a new or edited formula must parse, name existing properties and not be
  circular, else 400 `Formula "<name>": <reason>`. Unchanged formulas follow renamed properties (the stored
  expression is rewritten). A rollup cannot aggregate a formula of the target collection (only `count`).
- Formula values are in `rows[].props[fieldId]` of every read (`GET /api/pages/:id/collection`,
  `PATCH /api/pages/:id/props` response, `GET /api/pages/:id/row`, `GET …/collection/query` cells): number, string,
  boolean or a date string (`YYYY-MM-DD` / `YYYY-MM-DDTHH:mmZ`, UTC); `null` when empty or on an error. Writes to a
  formula id are ignored (props, batch, row templates, sheet sync, import); MCP `update_row` refuses them.
- `GET /api/pages/:id/collection/query`: formulas can be filtered and sorted with the operators of their result type
  (number, text, checkbox, date). The summary has `fields[].formula = { expression, result }`. Error cells read
  `#error(<code>)` (codes: `syntax`, `unknownProp`, `ambiguousProp`, `unknownFunction`, `args`, `cycle`, `type`,
  `divZero`, `tooLong`, `tooComplex`, `badDate`, `badUnit`).
- Chart aggregate: `groupBy` / `series` accept a formula; `measure.field` accepts a formula that yields a number.

### Page verification (docs/adr/1840–1842)

| Method | Path | Who | Request / response |
|---|---|---|---|
| GET | `/api/pages/:id/verification` | members (sessions and tokens) | `{ verification: PageVerificationDTO \| null, canVerify }` |
| POST | `/api/pages/:id/verification` | browser session; people who can edit the page; when the page has an owner, that owner or a workspace owner/admin | `{ expiresInDays (1–365) \| expiresAt, note? (≤ 200) }` (one of the two expiry forms); also sets the page's review time |
| DELETE | `/api/pages/:id/verification` | same as POST | `{ verification: null, canVerify }` |
| GET | `/api/workspaces/:id/verified?days=1..90&mine=1` | members | `{ expiringDays, expired[], expiring[], verified[] }`, visible pages only, at most 500 |

`PageVerificationDTO`: `state ('verified' | 'expired'), expiringSoon, verifiedAt, verifiedBy { id, name } | null,
expiresAt, note, changedSections, changedMuch`. Errors: 403 (`Pages are verified in the web app`, `Only the page's
owner or a workspace admin can verify this page`, `PAGE_LOCKED`), 400 (`Folders are not verified`, expiry out of
range). Audit: `page.verified`, `page.unverified`.

### Scheduled public links (docs/adr/1844)

- `POST /api/pages/:id/share` body gains `startsAt?: ISO | null` (before the expiry, at most 10 years ahead; a past
  instant = at once). `PATCH /api/pages/:id/share` gains `startsAt: ISO | null` (null = open now). 400 `Pick a start
  before the expiry`. Audit: `share.start_changed`.
- `ShareStatusDTO` and the items of `GET /api/workspaces/:id/shared` gain `startsAt: string | null` and
  `notStarted: boolean`.
- Public routes (`/api/public/:token`, `…/f/:fileId`, `…/p/:ref`, `…/p/:ref/f/:fileId`, `…/unlock`) and `/s/…`: before
  `startsAt` → 404 `NOT_FOUND`, identical to an unshared token, `Cache-Control: no-store`, not counted as a failure.
  Expired → 410 `SHARE_EXPIRED` (unchanged).

### Member status (docs/adr/1845–1846)

| Method | Path | Who | Request / response |
|---|---|---|---|
| GET | `/api/me/status` | signed in | `{ status: MemberStatusDTO \| null }` |
| PUT | `/api/me/status` | browser session | `{ emoji? (≤ 16), text (≤ 80), clearAt?: ISO \| null }`; at least emoji or text; `clearAt` in the future, at most a year |
| DELETE | `/api/me/status` | browser session | `{ status: null }` |

`GET /api/workspaces/:id/members`: each member gains `status: { emoji, text, clearAt } | null` (a status past `clearAt`
is null). One status per account, the same in every workspace.

### Team agents (docs/adr/1860–1866)

New routes (members only; guests 403):
- `GET /api/workspaces/:id/agent-connections` → `{ connections: WorkspaceConnectionDTO[] }` with `{ ref, key, userId,
  userName, client, kind: 'grant' | 'token', lastUsedAt }`: live connections of members (not expired, range includes
  the workspace, not blocked there). `ref` = `<userId>/grant:<id>`.
- `GET /api/workspaces/:id/team-agents?since=<ISO>` → `TeamAgentsDTO { since, now, totals: { claims, openSuggestions,
  edits, created, suggestions, reverted }, people: [{ userId, name, claims[], suggestions[], agents[] }] }`; `since`
  defaults to 24 h, at most 7 days back. Claims `{ pageId, pageTitle | null, anchor | null, hidden, connection, client,
  expiresAt, ttlSeconds }`; suggestions `{ id, pageId, pageTitle | null, anchor | null, hidden, mode, client,
  createdAt }`; agents `{ client, connections[], edits, created, suggestions, reverted, recentPages[{ pageId,
  title | null, hidden, at }], lastAt }`. Rate limit 60/min.

Changed (additive):
- `POST /api/pages/:id/comments` body: `mentionConnections?: string[]` (≤ 10; `<userId>/grant:<id>`, `grant:<id>`,
  `token:<id>` or `g:xxxxxxxx`). Not a live connection of a member → 400 `AGENT_NOT_AVAILABLE`, nothing written.
- `PATCH /api/pages/:id/props`: a key `agent:<fieldId>` next to a person field (same value forms; `null` clears). The
  cell is set to the connection's person; a cell set to someone else in the same write → 400 `AGENT_NOT_AVAILABLE`.
  A write that moves the cell to another person drops the agent key. Batch create and update routes ignore `agent:`
  keys.
- Row `properties` may carry `agent:<fieldId>` (`<userId>/grant:<id>`); it counts only while that person is in the
  cell and the connection is live.
- `GET /api/notifications`: items handed to one of my connections are listed only with my copy setting on, and carry
  `forAgent: "<client name>"`.
- `GET|PATCH /api/me/notification-settings`: `agentHandoffCopy` (default false).
- `GET /api/inbox` (MCP): items include `handoff: true` when handed to the calling connection; the result adds
  `handoffs` (count). Items handed to another connection of the person are not listed; `POST /api/inbox/ack` never
  acknowledges them.
- `GET /api/catch-up?team=1` adds the team group.
- `GET /api/pages/:id/collection/query` filter: person `= this connection` (agent connections only).

### Member statuses in row answers (docs/adr/1846, 1870)

`GET /api/pages/:id/collection/query` gains `people?: string[]`: the sorted user ids of the person cells shown on that
page of rows, absent when there are none, so an answer without a person column is byte-identical to 0.14.

### MCP tools
New arguments: `create_view(…, type: "form", form?)`, field specs `type: "formula"` with `expression`
(`create_collection`, `update_fields`), `add_comment(…, handoffTo?)`, `reply_comment(…, handoffTo?)`,
`catch_up(…, team?)`; `update_row` / `create_row` person values `"this connection"`, `grant:<id>`, `g:xxxxxxxx`.
Changed output: `read_page` verified / stale line and the owner's status; `find_context` verified marks; a last
`status: …` line after writes that mention or assign people with a status and after `query_rows`; `inbox` marks
items handed to this connection. Details: [MCP.md](MCP.md).

## v0.15.1 additions

One migration, `0047_v0151_index_stamp`: column `page_chunk_index.doc_updated_at` (timestamptz, NULL), filled from
`page_docs.updated_at` for existing rows. No route was added or removed. This release follows an outside evaluation of
the agent tools and reports from a production server.

### find_context (docs/adr/1900–1909)
- `GET /api/context`: unchanged shape except `fragments[].fullTokens?: number`, present on a fragment whose text was
  cut (`truncated: true`): the estimated tokens of the whole section (all its index parts).
- Ranking (no shape change): sections that are only a line of links, or that match only through the page title, do
  not take a page's slot when another section of the page matches by itself; link targets and bare URLs are not
  matched; a fragment above 40% of the budget is cut around its best lines (a table keeps its column row); English
  plural/-ed/-ing forms and Korean words with two particles in the query also match the base form; repeated `q`
  merge with RRF k = 10 (was 60).
- Page ids stay full in REST. The MCP text prints 8-character prefixes (docs/adr/1906-*).

### Section writes (docs/adr/1960–1961)
- `POST /api/pages/:id/section` and `POST /api/pages/:id/sections` resolve the section reference before any write.
  A reference that fits several sections, or that another still-existing section answered to before (change log, or
  the section index while typing is not logged yet), needs a `baseVersion` that picks one section; otherwise 409
  `SECTION_AMBIGUOUS` (details: `anchors`) and nothing is written. This applies to exact anchors too when another
  existing section held the anchor before. `/sections` lists such an edit as `reason: 'ambiguous'` in its 409
  `SECTIONS_CONFLICT`, also in suggestion mode.
- The claim route answers the same 409 for a short anchor or heading text that became ambiguous (it takes no
  version: exact anchors are used as they are). The comment route is unchanged; the MCP `add_comment` resolves the
  section before it calls the route.
- `patch_section` over REST still accepts a missing `baseVersion` for `replace`/`delete` (scripts with a person's own
  token); the MCP tool requires it (docs/adr/1961-*).

### Change feed (docs/adr/1960-*)
- A heading inserted above another with the same name (`## Decided` above `## Decided`) passes the anchor to the new
  heading. It is logged as a rename of the old section and an added one: before 0.15.1 `modified decided` +
  `added decided~2`, now `renamed decided>decided~2` + `added decided` (rows: `kind: 'renamed'` with anchor
  `decided~2` and `prev_anchor` `decided`, then `kind: 'added'` with anchor `decided`; the `changes_since` text reads
  `renamed decided → decided~2`). Deleting the first of two gives `removed decided` + `renamed decided~2>decided`. `GET /api/changes`, catch_up,
  activity and revert see these kinds for that pattern. A heading retyped as a new block stays `modified`.

### Inbox (docs/adr/1922-*)
- `POST /api/inbox/ack` takes `workspaceId` and `kinds` next to `cursor`: a cursor acknowledges only what
  `GET /api/inbox` with the same filters lists, including the visibility, range and access rules of the listing.
  Before 0.15.1 it also acknowledged older items of other workspaces and kinds, and items the caller could not see.
- `inboxAckSchema` (`@inkling/shared`) gains `workspaceId` and `kinds`.

### Vault sync (docs/adr/1920-*)
- `revision` is `<state vector hash>-<delete set hash>.<metadata hash>` (opaque to clients), so a pure deletion
  changes it. A token without `-` comes from an older server: a `PUT` with it gets 412 with the current version (the
  CLI merges), a `DELETE` with it succeeds when nothing was inserted or reformatted since.
- `PUT /api/pages/:id/sync/md` applies the Markdown as a minimal edit of the document (the `update_page` replace
  path): blocks the note did not change keep their ids and non-Markdown properties, and typing that reaches the
  server just after the write merges into them. When the minimal edit does not validate, the whole document is
  rewritten as before (logged as `[vault-sync] minimal replace not applied`).

### Other behaviour
- `POST /api/pages/:id/duplicate` stores (and indexes) the open documents of the subtree before copying, so the copy
  includes the last seconds of typing (docs/adr/1923-*).
- Ownership transfer bumps the workspace access version like any role change, so cached permissions refresh
  (docs/adr/1923-*).
- `GET /api/catch-up?since=<time>` starts at the first change-log row at or after that time also when one batch of
  rows straddles a power of ten in `seq` (it sorted the seqs as text and could start a few rows late).

### MCP tools
New arguments: `read_page(…, backlinks?)`, `create_page(…, kind?)` (`doc`, `canvas`, `folder`), `update_page(…,
baseVersion?)` for `replace`. `workspaceId` may be left out of `list_pages`, `create_page`, `import_folder`,
`create_from_template`, `create_collection` and `get_instructions` when a page id names the workspace or the
connection has one workspace. Every id argument takes an 8-character (or longer) prefix. Changed defaults and
output: `list_pages` / `search` default to `format: "compact"`; text outputs print 8-character ids; outline lines are
`- §<anchor> ~N tok v=…` indented per level, with an outline version; owner status, verified/stale and claims come
after the page text; `find_context` prints `can:` once when all results share it, `; truncated, section ~N tok` on a
cut fragment and a last `Verification:` line; an `inbox` cursor of a filtered listing carries the filter
(`<seq>;ws=<id>;kinds=a,b`). The tool list no longer carries a UUID pattern per id field or the SDK's `execution` and
`$schema` defaults (docs/adr/1940–1948). Details: [MCP.md](MCP.md).

## v0.16.0 additions

Three migrations, all additive: `0048_wave16_taint` (table `connection_taints`, column
`workspaces.agent_taint_demote boolean not null default true`), `0049_wave16_agent_tokens` (`oauth_grants.kind text
not null default 'oauth'`, `oauth_grants.token_prefix`), `0050_wave16_agent_uploads` (`workspaces.agent_uploads`,
`files.uploaded_via` and a partial index on `files`). This release is about MCP and working with AI agents.

### MCP endpoint (docs/adr/2000-*, 2060-*, 2065-*)
- `POST /mcp?profile=core|full`: no profile = full. Any other value, or the parameter twice, is HTTP 400
  `{"jsonrpc":"2.0","error":{"code":-32602,"message":"Unknown profile: use /mcp?profile=core or /mcp?profile=full (no profile = full)."},"id":null}`.
  The OAuth `resource` indicator may be `<origin>/mcp?profile=core|full` (treated as `/mcp`).
- `/mcp` accepts `Authorization: Bearer ink_agt_…` (agent connection tokens) as well as OAuth access tokens; both are
  agent connections. `ink_pat_` (personal API tokens) stays 401. An `ink_agt_` token from a banned IP gets 429
  `{ error: { code: 'RATE_LIMITED' } }` with `Retry-After` before any lookup; an unknown one counts towards the IP ban.
  An agent connection token on any `/api` route is 401.
- Body limit 12 MB as before. When `AGENT_UPLOAD_MAX_MB` makes a larger upload possible, only a `tools/call` of
  `upload_file` (direct or through `more_tools`) is accepted above 12 MB, up to base64(`AGENT_UPLOAD_MAX_MB`) + 1 MB;
  other large bodies are 413 `PAYLOAD_TOO_LARGE`.
- New capabilities `resources` (template `inkling://page/{id}`, a list of at most 50 pages) and `prompts`
  (`catch-up`, `meeting-notes`, `memory-review`) (docs/adr/2001-*, 2002-*).

### Agent connection tokens (docs/adr/2060–2063)
Browser session only; a bearer token gets 403 (API tokens) or 401 (MCP tokens).

| Method | Path | Body | Answer |
|---|---|---|---|
| GET | `/api/agent-tokens` | – | `{ tokens: AgentTokenDTO[] }` newest first: `{ id, name, prefix ('ink_agt_' + 4), access: 'read'\|'write', range, createdAt, expiresAt, lastUsedAt, suggestOnly: { until, sources } \| null }`. Never the token. `id` is the grant id (connection key `grant:<id>`) |
| POST | `/api/agent-tokens` | `{ name (1–60), expiresInDays: 7\|30\|90\|365, access: 'read'\|'write', range }` (strict) | `201 { token: AgentTokenDTO, secret: 'ink_agt_…' }`, `Cache-Control: no-store`; the only time the secret is returned. 400 `CLIENT_NAME_RESERVED`, `CLIENT_NAME_CLASH`, `VALIDATION`, `INVALID_RANGE`; 409 `TOO_MANY_TOKENS` (20 live per account). Rate limit 20/min. Audits `agent.token_created` in each workspace in range |
| DELETE | `/api/agent-tokens/:id` | – | 204; 404 when not the caller's agent token. Revokes at once, hands back hand-offs, audits `agent.token_revoked` |
| PATCH | `/api/oauth/grants/:id` | `{ range }` | (changed) also changes an agent token's range; audits `agent.token_range_changed` in every workspace the old or new range reaches |
| DELETE | `/api/oauth/grants/:id` | – | (changed) also revokes an agent token, with the same effects |
| GET | `/api/oauth/grants` | – | (changed) only connections made by OAuth (`kind = 'oauth'`); agent tokens are in `/api/agent-tokens` |

Audit actions `agent.token_created` (target `connection` `grant:<id>`, label = name; `after: { access, range,
expiresAt }`), `agent.token_revoked`, `agent.token_range_changed` (`before.range`, `after.range`: kinds). Never the
token.

### Suggest-only connections (docs/adr/2040–2043)
- A bearer connection (OAuth, agent token, API token) handed flagged content is suggest-only for 60 minutes after the
  last such read, in every workspace with `agentTaintDemote` on (the default). Content is "handed" by the MCP read
  tools and resources and, for API tokens, by `GET /pages/:id/section` (the returned section only), `GET /pages/read`,
  `GET /context` (the returned sections only) and `GET /pages/:id/export`.
- While suggest-only: `POST /pages/:id/section`, `/sections`, `/content` answer `202 { suggestion }` with
  `origin: 'taint'` and a `reviewReason`; comments, threads (follow/read), claims, `POST /suggestions/:id/withdraw`,
  `POST /inbox/ack`, Later and `POST /notifications/read` work (a comment with `mentionConnections` is refused with the
  same code: no hand-offs while suggest-only); every other write answers
  `403 { error: { code: 'CONNECTION_SUGGEST_ONLY', message, suggestOnlyUntil } }`.
- `PUT /api/workspaces/:id/settings/agent-taint` `{ enabled }` — owners/admins, browser only → `{ settings, role, can }`.
  `WorkspaceSettingsDTO.agentTaintDemote` (additive).
- `POST /api/workspaces/:id/agent-connections/release` `{ connection: 'grant:<id>' | 'token:<id>' }` — workspace
  owners/admins, or the connection's owner; browser only; lifts the connection's sources in this workspace →
  `{ released: n, suggestOnly: SuggestOnlyDTO | null }`. 403 for other members; 404 unknown connection.
- `POST /api/connections/release` `{ connection }` — the connection's owner, browser only; lifts every source →
  `{ released: n, suggestOnly: null }`. 404 when it is not the caller's.
- `GET /api/connections/suggest-only` — browser only: `{ connections: [{ key, until, sources }] }` of the caller's own
  connections that are suggest-only now.
- Additive fields: `suggestOnly: { until, sources } | null` on `GET /oauth/grants`, `GET /agent-tokens` and
  `GET /tokens` items; `suggestOnly: { until, sources, sourcesHere } | null` on `GET /workspaces/:id/agent-connections`
  items (null when the workspace has the switch off); `suggestOnly: { [connectionKey]: { until, sources, sourcesHere } }`
  on `GET /workspaces/:id/team-agents`. `SuggestionDTO.origin` adds `'taint'`.
- Audit actions `agent.tainted` (target `connection`, `after: { source, rules, until }`, never text) and
  `agent.taint_released` (`before: { sources }`, `after: { scope: 'workspace' | 'all' }`).

### Files and uploads by agents (docs/adr/2044–2046, 2065)
- `POST /api/files` with a bearer token (MCP, agent token, API token): `pageId` required (400 otherwise); the
  connection must be allowed to edit or suggest on the page (`PAGE_LOCKED` / `PAGE_ACCESS` otherwise); at most
  `AGENT_UPLOAD_MAX_MB` (default 5 MB; 413 `PAYLOAD_TOO_LARGE` naming the limit); the type comes from the file name and
  must match the bytes (png, jpg/jpeg, gif, webp, pdf by magic number; txt, log, tsv, csv, md, markdown, json as UTF-8
  without NUL), else 415 `UNSUPPORTED_TYPE` with the reason; 429 `UPLOAD_BUDGET` once the account's connections
  uploaded `AGENT_UPLOAD_DAILY_MB` (default 200 MB) in 24 hours (browser uploads do not count; 0 = no budget); 403
  `AGENT_UPLOADS_OFF` when the server or the workspace turns agent uploads off; 403 `CONNECTION_SUGGEST_ONLY` while
  suggest-only. The file row records `uploaded_via`.
- Browser uploads: unchanged (25 MB, no budget) except that `text/csv`, `text/markdown` and `application/json` are
  accepted.
- `PUT /api/workspaces/:id/settings/agent-uploads` `{ value: 'default' | 'on' | 'off' }` — owners/admins, browser
  only → `{ settings, role, can }`; 409 `AGENT_UPLOADS_NEVER` for `on` under `AGENT_UPLOADS=never`; audited
  `settings.updated` (`before/after: { agentUploads }`). `WorkspaceSettingsDTO` adds `agentUploads: 'on' | 'off' | null`
  and `agentUploadsServer: 'on' | 'off' | 'never'`.
- `GET /api/admin/status`: new item `security.agentUploads` with `data: { mode, maxMb, dailyMb (null = no budget),
  mcpBodyMb, warnings }`.

### Memory check and instruction length (docs/adr/2003-*, 2004-*)

| Method | Path | Who | Answer |
|---|---|---|---|
| GET | `/api/workspaces/:id/notes-check?parentId=&limit=1..50` | members (tokens too) | `NotesCheckDTO { workspaceId, rootId, checked, broken { total, pages, items[{ pageId, title, count, links[{ text, state: missing\|exists\|trashed, targetId?, trashedOn? }] }] }, duplicates { total, items[{ title, pageIds }] }, unlinked { total, items[{ pageId, title, updatedOn }] }, verification { total, items[{ pageId, title, state: lapsed\|changed, until, changedSections }] }, quietLarge { total, minTokens, before, items[{ pageId, title, tokens, updatedOn }] } }`; visible pages only; `parentId` not visible → 404 |
| GET | `/api/workspaces/:id/agent-instructions/length` | members | `{ limits: { lines: 200, bytes: 25000 }, always: { lines, bytes, tokens, long, pages }, pages: [{ pageId, mode, lines, bytes, tokens, long, truncated }] }`; measured on the Markdown get_instructions sends (cut at 12,000 characters, `truncated`); sizes only |

### MCP tools
New tools: `upload_file(pageId, name, text | base64, section?, attachOnly?)`, `check_notes(workspaceId?, parentId?,
limit?, budget?)`, `more_tools(tool?, arguments?)` (core profile only). `read_file` takes `pages` (`"2-5"`) for PDFs and
reads more text files by extension; returned text is scanned for injection-like content. `get_instructions` ends with
a `note:` line when the instructions are over 200 lines or 25 KB. `can:` lines say `suggest` while the connection is
suggest-only. Tool lists: full 47 tools (~12,370 tokens), core 32 (~7,437). Details: [MCP.md](MCP.md).

## v0.17.0 additions

Migrations 0051 (`pages.row_number`, `edited_by`, `edited_via`, `collections.row_seq`, ID triggers), 0052
(`page_links.sections`) and 0053 (`page_snapshots.digest`, `step`), all additive. Existing answers keep their shape
unless noted; new fields are additive.

### Section links (docs/adr/2100–2103)
- Internal links are BlockNote `link` inlines with href `/w/<workspaceId>/p/<pageId>`. A section link adds a fragment
  `#h=<heading>&b=<heading block id>&p=<page title>` (URL-encoded; `b` and `p` optional, in this order). Markdown:
  `[[Page#Heading]]`, `[[Page#Heading|shown]]`. Imports and MCP writes turn `[[Page#Heading]]` into a section link
  when `Page` is visible and no page or split subpage is titled `Page#Heading`; `[[…]]` inside a code block stays code.

| Method | Path | Answer |
|---|---|---|
| GET | `/api/pages/:id/backlinks` | (changed) adds `sections` only when a source has section links: `{ <sourcePageId>: [{ heading, status }] }`, `status` `found` \| `renamed` (the heading is called `heading` now) \| `missing` ([ADR 2101](adr/2101-section-refs-in-page-links.md)) |
| GET | `/api/pages/:id/headings` | `{ headings: [{ blockId, text, level, anchor }] }`: the page's section headings (top-level headings, ADR 0926), for the `[[Page#` menu. Documents only (others: `[]`). Membership as `/pages/:id/outline`; guests 403 ([ADR 2100](adr/2100-section-links-are-page-links-with-a-heading-fragment.md)) |
| GET | `/api/pages/:id/section-link?heading=&block=` | Which heading a section link means now: `{ status: 'found' \| 'renamed' \| 'missing', heading, blockId, anchor }`, by block id, then name, then the change log's rename trace. `heading` 1–500 characters, `block` an optional block id. Read-only; no agent read recorded ([ADR 2102](adr/2102-following-section-links-through-renames.md)) |

- `NotesCheckDTO`: `broken.items[].links[].state` adds `'noHeading'` (`targetId` = the page, `text` = `Title#Heading`).

### Database views, public pages and the Markdown download (docs/adr/2120–2123, 2190)
- Block props: `pageEmbed` has `viewId` (string, default `''`). When `pageId` is a collection the block is an inline
  database view; `''` = the collection's first view.
- `GET /api/pages/:id/export?format=md&notation=file`: the download form. A chart is its `<!-- inkling:chart {…} -->`
  line, a database view its `<!-- inkling:pageEmbed {"pageId":"…","viewId":"…"} -->` line, each followed by
  `<!-- inkling:snapshot -->`, a table of the numbers for the exporting member (at most 1000 rows) and
  `<!-- /inkling:snapshot -->`; a ```dataview fence is followed by a snapshot of its results; page embeds become
  `[[Title]]`, link embeds links. Zip exports default to it (`notation=plain` gives the 0.16 output). On import
  (`POST /api/workspaces/:id/import`, zip and folder imports) a snapshot directly after a block line or a code fence is
  dropped and the block restored; elsewhere only the markers are removed.
- Public pages (`GET /api/public/:token`, `/api/public/:token/p/:ref`) render page embeds, link embeds, database views
  and query blocks from pages inside the link only (anything else: "Embedded content that is not part of this
  link."). The response shape is unchanged. Database tables there and in the download fill the automatic properties
  (IDs as `TASK-12`, ISO UTC times, member names, `-` for non-members; `Name (via Client)` in member downloads only)
  and put sub-items under their parent with `↳` in table and list views; at most 200 rows on public pages.
- MCP `read_page` adds a `view-info` line under a database view ([MCP.md](MCP.md)).

### Collections (docs/adr/2140–2147, 2192)
- Field types `email`, `phone`, `createdTime`, `editedTime`, `createdBy`, `editedBy`, `uniqueId` (`{ uniqueId:
  { prefix } }`); `relation.subItems: true` marks a collection's Parent item relation to itself. One ID and one Parent
  item per collection (400). `PUT /pages/:id/collection/fields` validates them.
- `GET /pages/:id/collection` (and the other row answers): rows' `props` include automatic values (`createdTime` /
  `editedTime` as ISO UTC strings, `createdBy` / `editedBy` user ids with `via:<fieldId>` = the client name when an
  agent made the change, `uniqueId` a number). Page guests may call it (404 outside their shared trees); their answer
  adds `people: { [userId]: name }`.
- Opened to page guests (edit level for writes): `GET /pages/:id/collection/row-options`, `GET …/covers`,
  `GET …/row-templates`, `POST …/collection/rows`, `PATCH /pages/:id/props`. A guest's person value is 403
  `GUEST_PERSON`. Properties, views, bulk paste and import, charts and the member list stay member-only.
- `PATCH /pages/:id/props`: automatic values and `via:` keys are ignored; a Parent item keeps one id; a loop is 400
  `SUBITEM_CYCLE`.
- `GET /pages/:id/collection/query`: `under` (a row id, an ID like `TASK-3` or an exact title) and `depth` (1–8,
  default 1); field summaries carry `prefix` (uniqueId) and `subItems: true`. Automatic values are computed in SQL
  only for the fields the filter or sort names; the returned rows get theirs from a second read of those rows
  ([ADR 2192](adr/2192-query-rows-computes-automatic-values-only-when-read.md)). The answer's shape is unchanged.
- View config: `filter` (a tree: `{ mode: 'and' | 'or', items: (condition | group)[] }`, condition `{ fieldId, op,
  value?, not? }`, group `{ mode, not?, items: condition[] }`, one level of groups, 10 items per level) next to the
  old flat `filters`; a plain AND filter is still saved as `filters`. `subItems: 'nested' | 'flat'`. View type `list`.
- Built-in template key `agentBoard`.

### First-admin setup and the local trial (docs/adr/2160–2161)
- `GET /api/auth/mode`: adds `setupPending: boolean` (no account yet and a setup link was printed).
- `POST /api/auth/register`: body adds `setupCode?: string`. With it no `signupKey` is needed; the account is created
  as admin only while the server has no account. 403 `INVALID_SETUP_CODE` (not the code in the log; counts towards the
  IP ban), 403 `SETUP_CLOSED` (an account exists, or no code is open). The setup account is not subject to
  `REQUIRE_EMAIL_VERIFICATION`.
- Web route `/setup?code=…`: the sign-up screen in setup mode.

### Imports by connections and zip safety (docs/adr/2162–2163)
- `POST /api/workspaces/:id/import` with a bearer token and a zip: the file is at most
  `min(IMPORT_MAX_UPLOAD_MB, AGENT_UPLOAD_MAX_MB)` (413 `PAYLOAD_TOO_LARGE`); if it has `assets/` attachments, 403
  `AGENT_UPLOADS_OFF` / 429 `UPLOAD_BUDGET` before anything is created; attachments are typed like `POST /api/files`
  and capped per file, and refused ones are listed as `skippedAttachments: [{ name, reason }]` (also on a bearer
  `import-folder`). A Notion export is 415 `NOTION_IMPORT_IN_APP` unless `?source=markdown`. Attachments stored this
  way have `uploaded_via` set and count towards the daily budget. Browser imports are unchanged.
- Every zip import: 400 for an archive with a `..` entry ("Unsafe path in the archive"), a symbolic link, or an entry
  inflating more than 200 times its packed size past 1 MB (`ZIP_RATIO`). Names are NFC; names that are not UTF-8 are
  read as CP949.

### Versions: AI steps (docs/adr/2180–2182)
- `GET /api/pages/:id/snapshots`: AI step rows add `step: { n, tool, mode?, sections, more?, added?, removed?,
  restoredFrom? }` (`SnapshotStepDTO`); `n` counts consecutive step rows of one client from 1; `sections` are at most 3
  anchors (`more` = how many others, empty = the whole body); `added` / `removed` are Markdown lines.
- `POST /api/pages/:id/snapshots/:sid/restore` → `{ ok: true, before: string | null, step: string | null }`. A person's
  restore stores a "Before restore" snapshot first (`before`). An agent's restore (a bearer request with a client) is
  an AI step: `before` is the newest version when it equals the page (the agent's previous step), else a new "Before
  restore" snapshot; `step` is the restored page's step row.
- Each client keeps its newest 20 step rows per page, a page at most 30; the 50-version cap is unchanged and step rows
  are pruned first. Autosaves ignore step rows when deciding whether one is due.

### Agent search (docs/adr/2183–2184)

| Method | Path | Query | Answer |
|---|---|---|---|
| GET | `/api/search` | `q` (1–200 chars), `workspaceId?` (else every live workspace I belong to that does not block this agent, in the connection's range), `limit?` (1–50, default 10) | `{ results: [{id, workspaceId, title, kind, scope, updatedAt, match: 'title'\|'heading'\|'body', exact, anchor?, shortAnchor?, headingPath?, snippet?}], total, workspaces: [{id, name, matches}], limit }`. Match set as `/api/workspaces/:id/search` (title or body text contains `q`, case-insensitive; live, visible pages). Order: title equal to `q` → title with `q` as a whole word → title containing it → heading whole word → heading containing it → body whole word → body containing it, then `updatedAt` desc, then id. Whole word: no letter or digit (ASCII, Latin, Greek, Cyrillic, Hangul, kana, CJK) or `_` right before or after; a query ending in a Hangul syllable may be followed by a fitting particle (+ 는/은/도/만). `snippet` only for body matches. `total` and `workspaces[].matches` count every match, shown or not. Read-only tokens allowed. With `workspaceId`: the errors of the workspace search route (403/404, `OUT_OF_RANGE`, `AGENT_BLOCKED`, `TWO_FACTOR_REQUIRED`) |

The web app's `GET /api/workspaces/:id/search` is unchanged.

### Vault sync (experimental `vault-sync`, docs/adr/2166–2169)
- `POST /api/workspaces/:id/sync/pages`: `clientKey?: uuid`; the page id is derived from the workspace and the key, and a retry with
  the same key (same workspace, author, live page) answers the same page with `replayed: true`.
- `PUT /api/pages/:id/sync/md`: 200 without writing when the page already equals the note despite a stale revision;
  `droppedFrontmatterKeys` includes reserved and over-limit keys; the Markdown carries block tokens
  (`<!-- inkling:pageEmbed … -->` and the like); the revision's meta half carries the format marker `md2`.
- `DELETE /api/pages/:id/sync`: accepts a pre-0.17 meta half; logged as `page_trashed` in the change feed.

### MCP tools
New tool: `import_zip(base64, workspaceId?, parentId?, source?)` (hidden group `files`). New arguments:
`search(…, limit?)`, `list_versions(…, all?)`, `query_rows(…, under?, depth?)`, `create_row(…, parent?)`;
`create_collection` and `update_fields` take the new field types, `prefix` and `subItems`. `workspaceId` arguments take
a workspace name (inbox excepted). `search` output and `find_context` across workspaces changed (docs/adr/2184-*,
2185-*). Tool lists: full 48 tools (~12,777 tokens), core 32 (~7,533). Details: [MCP.md](MCP.md).

## v0.18.0 additions

Migrations 0054 (`push_subscriptions`, `push_vapid_keys`, `push_settings`), 0055 (`collection_automations`,
`automation_runs`), 0056 (`pages.doc_gen`), 0057 (`workspace_list_groups`, `workspace_listings`) and 0058 (a new
body for the row-number trigger function), all additive. Existing answers keep their shape unless noted; new fields
are additive. "Browser session only" means a cookie session: bearer tokens (API tokens, MCP and agent connection
tokens) get 403.

### Offline copies (docs/adr/2200–2204)

| Method | Path | Answer |
|---|---|---|
| GET | `/api/pages/:id/sync-check` | `{ gen: number, canEdit: boolean, trashed: boolean, sv: string, needs?: number }` (`needs` and `?schema=` since 0.20, see "v0.20.0 additions") for the browser before it syncs a device copy. `gen` the page's document generation; `canEdit` whether the caller may edit the body now (lock, people rows, guest level; false when trashed); `trashed` the page is in the trash (a trashed page the caller could see answers 200 instead of 404); `sv` the base64 Yjs state vector of the live document (or of `page_docs`). Browser session only (403 for tokens); members and guests, as on the collaboration socket. 404 when the page is not visible or not a document; 403 not a member or guest of the workspace, or `TWO_FACTOR_REQUIRED`. `Cache-Control: no-store` |

- Collaboration socket: right after authentication the server sends the stateless message `{"t":"gen","gen":<n>}` on
  the page's channel, and again to every open client when the generation changes. Clients ignore unknown `t`.
- The generation goes up on a version restore, an AI-edit revert, a split and a full-body rewrite
  ([ADR 2201](adr/2201-document-generation-and-the-sync-gate.md)).

### Web push (docs/adr/2220–2223)

Browser session only.

| Method | Path | Body / answer |
|---|---|---|
| GET | `/api/push/key` | `{ available, publicKey }`: the VAPID public key (base64url, a 65-byte point), or `available: false` (`WEB_PUSH=off`, key problem) |
| GET | `/api/push/settings` | `PushSettingsDTO` `{ available, enabled, kinds[], hideContent, devices[] }`; a device: `{ id, label, createdAt, lastSuccessAt, lastFailureAt, failureCount, current, stale }` |
| PATCH | `/api/push/settings` | `{ enabled?, kinds?: ('mention'\|'assigned'\|'reply'\|'comment'\|'approval'\|'reminder'\|'updates')[], hideContent? }` → `PushSettingsDTO`. Default kinds: all but `updates` |
| POST | `/api/push/subscriptions` | `PushSubscription.toJSON()` (`{ endpoint, expirationTime?, keys: { p256dh, auth } }`) and an optional `label` → 201 `{ id, device }`. The same endpoint again is the same row (refreshed, bound to this session); another account registering it takes it over. 400 `PUSH_SERVICE_NOT_ALLOWED` (endpoint host not an allowed push service), 400 `PUSH_SUBSCRIPTION_INVALID` (the URL or key checks), 503 `PUSH_UNAVAILABLE`; a body of the wrong shape (missing keys, endpoint over 1,024 characters, label over 80) is the usual validation error. 20/min. At most 20 devices per person (the one longest without a delivery is dropped) |
| DELETE | `/api/push/subscriptions` | `{ endpoint }` → 204; removes this browser's row if it is the caller's (no error otherwise) |
| DELETE | `/api/push/devices/:id` | 204, or 404 when not the caller's |
| POST | `/api/push/test` | `{ deviceId? }` → `{ queued }`; 404 for a device that is not the caller's; 503 when unavailable. 5/min |

- Push payload (inside the encrypted message, for people writing their own service worker):
  `{ v: 1, title, body, url, tag, id, ts }`; `url` is a same-origin path, `tag` is `p:<pageId>`, `n:<id>` or `test`.
- A subscription belongs to the session that registered it and is deleted with it (logout, password change, an
  admin's revoke, expiry).

### Buttons and database automations (docs/adr/2240–2245)

| Method | Path | Body / answer |
|---|---|---|
| GET | `/api/collections/:id/automations` | `{ automations: AutomationDTO[], canEdit }`; members who can see the database (not guests). Tokens may read; `canEdit` is true only for a browser session with edit access |
| POST | `/api/collections/:id/automations` | `{ name (1–80), enabled?, trigger, condition?, actions }` → `{ automation }`. Browser session only; edit access to the database (as `PUT /pages/:id/collection/fields`); 400 when a field, database or webhook does not fit; at most 20 rules per database; 30/min. The saver becomes the author |
| PATCH | `/api/collections/:id/automations/:ruleId` | a partial body → `{ automation }`. `{ enabled: false }` alone keeps the author; anything else (turning on included) makes the caller the author and checks the rule again; turning on resets the failure streak. Browser session only |
| DELETE | `/api/collections/:id/automations/:ruleId` | 204. Browser session only |
| GET | `/api/collections/:id/automations/runs?automationId=&limit=` | `{ runs: AutomationRunDTO[] }`, newest first, `limit` 1–100 (default 50): `status` `ok` / `failed` / `skipped`, `failedAction` (0-based), `error`, `actorName`, `depth`, `rowTitle` (null when the row is gone) |
| GET | `/api/workspaces/:id/webhook-targets` | `{ targets: [{ id, kind, label, enabled }] }` (`label` is the host); members |
| POST | `/api/pages/:id/button-webhook` | `{ blockId, webhookId }` → `{ ok: true }`; members who can see the page; 10/min. 409 `BUTTON_NOT_SAVED` when the stored page has no such button with that hook (the collaboration store writes a few seconds after typing), 409 `WEBHOOK_OFF`, 429 `RATE_LIMITED` when the workspace's webhook queue is full |

- trigger: `{ type: 'rowAdded' }` | `{ type: 'fieldChanged', fieldId, to? }` | `{ type: 'dateReached', fieldId,
  daysBefore: 0..30 }`. condition: a view filter tree (`{ mode, items }` with groups and `not`).
- actions (at most 5): `setFields { props }`, `assign { fieldId, to: ['me' | 'creator' | userId] }`,
  `notify { fieldId?, creator?, userIds?, message? }`, `webhook { webhookId, message? }`,
  `addRow { collectionId, templateId?, title?, props? }`, `assignAgent { fieldId, connection }`. A button block has
  the same actions without `assign`/`assignAgent`/`notify` and with `open`; its block props carry `label`, `color`
  and `actions`.
- Writes by a rule carry `via` = `automation: <rule name>` (cut at 80 characters).
- Change log: `page_props` events carry `keys` (the changed property ids, at most 100). Webhooks may deliver the
  event type `automation` (not subscribable; only to the hook a button or rule names; generic payload
  `type: "automation"`, `field`, `message`).
- Markdown: a button is `<!-- inkling:button {"actions":[…],"color":"…","label":"…"} -->` in agent reads,
  downloads and vault sync, and `**[label]**` in plain Markdown.

### Web clipper (docs/adr/2260–2263)

| Method | Path | Body / answer |
|---|---|---|
| POST | `/api/clip` | `{ workspaceId, parentId?, url? (http(s), ≤ 2,048), title? (≤ 300), text? (≤ 20,000), mode?: 'link' \| 'article' (default link), tags?: string[] (≤ 10, each ≤ 40 letters, digits, _, - or /, a leading # allowed) }`, at least one of `url` and `text` → `200 { page: PageMetaDTO, mode: 'link' \| 'article', fallback?: 'fetch_failed' \| 'not_html' \| 'no_content', truncated?: true }` |
| GET | `/api/clip/lookup?workspaceId=&url=` | `{ pages: [{ id, title, workspaceId, createdAt }] }`: up to 5 live pages in that workspace, visible to the caller, whose `source` property is this URL (normalized), newest first. `workspaceId` is required. Members and guests (their visible pages only); tokens allowed |

- `POST /api/clip` checks as `POST /pages`: membership (guests only under a page shared with them for editing),
  connection range, the edit lock on the parent (`403 PAGE_LOCKED`), suggest-only connections refused (`403
  CONNECTION_SUGGEST_ONLY`), read-only tokens refused. A URL that is not http(s): `400 CLIP_INVALID_URL`.
- `mode: 'article'` needs a browser session: any bearer token gets `403 CLIP_ARTICLE_SESSION_ONLY`. Article fetches
  are limited (10 per person per minute, 2 at once per person, 8 per server): `429 CLIP_RATE_LIMITED`. Route limit
  30/min.
- An article that cannot be fetched or has no article text is saved as a link with `fallback`; the page is created
  either way. The body: a link card for the URL, the text as quotes, `#tags`, a "Saved … UTC from host" line, then
  the article (cut at 100,000 characters, at the 2 MiB read limit or by the block conversion; any cut sets
  `truncated`). Page properties `source` (the URL) and `clipped` (`YYYY-MM-DD HH:MM UTC`), named "Source" / "Clipped"
  (Korean "출처" / "저장한 날") after the creator's language.
- Web route `/clip?title=&text=&url=`: the save screen. It saves nothing by itself.

### Workspace groups and archive (docs/adr/2300–2305)

Browser session only, reads included. A workspace id must be one the caller can open (a member of a live workspace,
or a guest), else 404. Another person's group is 404.

| Method | Path | Body | Answer |
|---|---|---|---|
| GET | `/api/me/workspace-groups` | – | `{ groups: [{ id, name, collapsed }] }` in the person's order |
| POST | `/api/me/workspace-groups` | `{ name }` (1–40 characters, trimmed; at most 50 groups) | `{ group }` |
| PATCH | `/api/me/workspace-groups/:id` | `{ name?, collapsed? }` | `{ group }` |
| DELETE | `/api/me/workspace-groups/:id` | – | 204; its workspaces become ungrouped (appended), their archive state is kept |
| PUT | `/api/me/workspace-groups/order` | `{ ids }` (≤ 50) | `{ groups }`; groups not listed keep their order after the listed ones |
| POST | `/api/me/workspace-groups/:id/archive` | `{ archived }` | `{ count }` (every workspace in the group) |
| PATCH | `/api/me/workspaces/:id/listing` | `{ archived?, groupId? }` (null = no group; moving appends) | `{ listing }` |
| PUT | `/api/me/workspace-order` | `{ groupId, ids }` (≤ 500) | 204; the listed workspaces join the group at these positions |

- `GET /api/workspaces`: each workspace the caller arranged adds `listing?: { archived?: true, groupId?, group?,
  position? }`. The list order is unchanged.
- `GET /api/search` and `GET /api/context` without `workspaceId` add `archived: [{ id, name }]` when they left the
  caller's archived workspaces out. A connection limited to some workspaces searches its range; the archive does not
  apply to it.

### OAuth: Client ID Metadata Documents (`OAUTH_CIMD=1`, docs/adr/2280–2282)

- `GET /.well-known/oauth-authorization-server`: `client_id_metadata_document_supported: true` only when
  `OAUTH_CIMD=1`.
- `/oauth/authorize` (the consent screen), `GET /api/oauth/authorize/info` (browser session) and
  `POST /api/oauth/authorize`: `client_id` may be an https URL (up to 2,000 characters; other ids still up to 200).
  For such a client `info` adds `metadataDocument: { host, loopbackRedirect }`. Errors: `400 INVALID_CLIENT` (switched
  off, with the same message as an unknown id; URL not acceptable; host not allowed; document refused, with the
  reason), `400 INVALID_REDIRECT` (`redirect_uri` not in the document's `redirect_uris`; loopback http may use any
  port), `400 CLIENT_NAME_RESERVED` (the document's `client_name`), `503 CLIENT_METADATA_UNAVAILABLE` (the document
  could not be fetched now; `Retry-After: 60`). None of them redirects to the client.
- Every authorization response to a metadata-document client (code or error, deny included) carries
  `iss=<issuer>` (RFC 9207). Responses to registered clients do not change.
- `POST /oauth/token`: `authorization_code` for a URL client answers `400 invalid_client` when CIMD is off or the host
  is no longer allowed; the document is not fetched on the code exchange. `refresh_token` for a URL client reads the
  document again (cached): `400 invalid_client` when off, not allowed or the document is refused; if the document
  now names another `client_id` the grant is revoked; `503 temporarily_unavailable` when it cannot be fetched and no
  usable copy is cached (a copy that was valid is used for up to 7 days while the host fails).
- `GET /api/oauth/grants`: grants of URL clients add `clientHost`.
- Reserved client names: a name that folds to a word starting with "automation", or to "public form", is
  `CLIENT_NAME_RESERVED` at registration, at consent (also from a metadata document) and for agent connection tokens.

### MCP tools
No new tool and no description change: full 48 tools (~12,777 tokens), core 32 (~7,533), server instructions ~492.
find_context, search and catch_up without `workspaceId` leave the caller's archived workspaces out and say so in a
closing line; `list_workspaces` adds `group` and `archived`; `query_rows describe=true` lists enabled automations;
buttons read as `<!-- inkling:button … -->`. Details: [MCP.md](MCP.md).

## v0.19.0 additions

Migration 0059 (`pages.share_allow_download boolean not null default false`), additive. Existing answers keep their
shape; new fields are additive.

### Public page downloads (docs/adr/2360–2363)

| Method | Path | Answer |
|---|---|---|
| GET | `/api/public/:token/export.md` | Markdown of a single-page link's page, only when the link allows downloads (`allowDownload`). Same gate as `/api/public/:token`: unknown 404 (counted as a guess), expired 410, before a scheduled start 404, password 401 until unlocked; then a folder token or canvas → 404, download off → 404. `200 text/markdown; charset=utf-8`, `Content-Disposition: attachment; filename*=UTF-8''<title>.md`, `Cache-Control: no-store`, `X-Robots-Tag: noindex, nofollow`. Content = the public page's blocks (no ids, no tokens, no frontmatter), links and files as absolute `PUBLIC_URL` addresses. 60/min |
| GET | `/api/public/:token/p/:ref/export.md` | The same for a page of a folder link (doc or collection); the folder link's setting applies. Ref outside the subtree, private or trashed → 404 |

- `PATCH /api/pages/:id/share` body adds `allowDownload?: boolean` (owners and admins; audited as
  `share.download_changed` with before/after `{ allowDownload }`). `POST` does not take it (strict body: 400 if
  sent): a new link always starts with downloads off. Publishing and unpublishing reset it to off.
- `ShareStatusDTO` adds `allowDownload: boolean`.
- `PublicPageDTO` adds `fullWidth?: true` (the page's "Full width") and `download?: true` (the link allows
  `…/export.md`); both left out when false.

### Onboarding (docs/adr/2380–2383)

Migration 0060 (`user_onboarding`, a `{"legacy": true}` row for every account that existed before it). Browser
session only: bearer tokens get 403.

| Method | Path | Body | Answer | Notes |
| --- | --- | --- | --- | --- |
| GET | `/api/me/onboarding` | — | `OnboardingDTO` `{ enabled, audience: owner\|member\|guest, intro, checklist: { show, collapsed, dismissed, complete, items: [{ id, done }] }, samples: { [workspaceId]: pageId } }` | The first call makes the person's row; for the first admin of a new server it also makes the sample page. 120/min |
| PATCH | `/api/me/onboarding` | any of `{ introSeen: true, collapsed, dismissed, event: slash\|link\|ai\|explore\|install }` (strict) | `OnboardingDTO` | 400 on an empty or unknown field. 60/min |
| POST | `/api/me/onboarding/sample` | `{ workspaceId }` | `{ pageId, workspaceId, created }` | Members (not guests) of the workspace; private pages; returns the live sample when there is one (`created: false`); 409 `SAMPLE_IN_PROGRESS` while one is being made; 404 `ONBOARDING_OFF`. 10/min |

- `ONBOARDING=off`: GET and PATCH answer `enabled: false` and change nothing visible; POST is 404 `ONBOARDING_OFF`.
- `POST /api/pages/from-template` (and so `create_from_template`): a page embed in a template document that names a
  page of the same template now points at the new copy of that page (docs/adr/2381-*).

### MCP tools
No new tool and no description change: full 48 tools (~12,777 tokens), core 32 (~7,533). Details: [MCP.md](MCP.md).

## v0.20.0 additions

One migration, 0061 (charts on public links, below). Existing answers keep their shape; new fields are additive.

### Columns (docs/adr/2420–2424)
- Page bodies with columns carry `<!-- inkling:columns -->` (with `{"widths":[…]}` in percent when the columns
  differ), `<!-- inkling:column -->` and `<!-- /inkling:columns -->` lines in every Markdown answer and input:
  `GET /api/pages/:id/export?format=md` (every `notation`), zip export and import, `POST /api/pages/:id/content`,
  the section routes and vault sync. Markers that do not pair up are dropped on input and the blocks stay.
- `GET` and `POST /api/pages/:id/section` (and `POST /api/pages/:id/sections`) treat a top-level group as one block of its section: a
  heading inside a column is not a section; a replace keeps the group unchanged or replaces it whole
  (docs/adr/2424-*).

### Document schema (docs/adr/2425)
- Collaboration socket: `GET /collab?schema=N` (WebSocket upgrade). `N` is the document schema the client knows
  (0.20 = 2); missing or invalid = 1 (0.19 and older). On a page that holds a node type above `N` the connection is
  read-only (`Authenticated` scope `readonly`) and gets the stateless message `{"t":"schema","needs":M}`; when such a
  node reaches a page while the connection is open, the connection becomes read-only at once and its socket is
  closed with code 4000 so the client reconnects.
- `GET /api/pages/:id/sync-check?schema=N`: with `N` below the server's document schema the answer adds
  `needs: number`, the schema the page needs now. Without the parameter, or with the server's own version, the
  answer is unchanged.
- `PATCH /api/collection-row-templates/:id` body adds `schema?: number` (the document schema of the client that
  made `update`; missing = 1). An `update` from a client below what the stored body needs answers 409
  `SCHEMA_OUTDATED` and changes nothing; other fields without `update` are not affected.

### Charts on public links (docs/adr/2440–2444)

Migration 0061 (`pages.share_include_charts boolean not null default false`, `pages.share_charts_by uuid` → users,
`on delete set null`, `pages.share_chart_sources jsonb` — approved source keys, null while off), additive.

- `PATCH /api/pages/:id/share` body adds `includeCharts?: boolean` (owners and admins; session only, like the
  route; audited as `share.charts_changed` with before/after `{ includeCharts }`). Turning it on records the
  caller as the account the charts are aggregated with; sending `true` while on keeps the recorded account;
  turning it on also approves the sources the link's charts use now (a collection or a view of it: the collection;
  a query: its text, white space normalized); `false` clears all three. `POST` does not take it (strict body: 400):
  a new link starts with charts off. Unpublishing clears it.
- `PATCH /api/pages/:id/share` body adds `approveChartSources?: true` (owners and admins, session only; 409
  `CHARTS_OFF` while charts are off): approves the sources the link's charts use now and records the caller as
  the account the charts are aggregated with. Audited as `share.charts_changed` with before/after `{ includeCharts,
  sources }` (the number of approved sources).
- `ShareStatusDTO` adds `includeCharts: boolean`, `chartsBy?: string | null` (the recorded account's name, while
  on) and `charts?: { total, hidden, pending }`, left out when there are none: `total` = chart blocks on the page,
  those inside columns included (a folder: its doc pages inside the link, at most 300 pages read); `hidden` = those
  the public page leaves out with the current setting (`pending` included); `pending` = with charts on, those whose
  source is not approved (added or changed since charts were turned on or last approved), which
  `approveChartSources` would publish; 0 while off. GET answers it also before a link exists (with the setting
  off); POST and PATCH return it too.
- `PublicPageDTO` adds `charts?: PublicChartDTO[]` (left out when empty), behind the link's usual gate (unknown
  404, expired 410, before a start 404, password 401):
  `{ anchor, kind, title?, group, series?, measure: { fn, name? }, groups: { label, special? }[],
  seriesKeys?: { label, special? }[], values: (number|null)[] | (number|null)[][], omittedGroups, omittedSeries,
  truncated? }`. `group` / `series` / `measure.name` are property display names; `special` is `empty`, `checked`
  or `unchecked`. No ids, keys, source, query text or library options. In `html`, the chart's title block has
  `data-id="<anchor>"` (when it has a title) and its table block `data-id="<anchor>-t"`, in the chart's place (inside
  its column when it is in one); anchors are new on each render. Which charts are included: with the switch on,
  those of an approved source the recorded account (still a member) can see as in the Markdown export (collections
  and views of the page's workspace, query sources run as that account); on a folder link, also those of
  collections inside the link; nothing else.
- The Markdown downloads (`…/export.md`) write each included chart as its bold title and a GFM table (inside the
  column markers when the chart is in a column).

### Public page HTML (docs/adr/2387)
- `PublicPageDTO.html`: a callout is its box, then `<span class="nd-callout-icon" aria-hidden="true">` with the type's
  emoji, then the text element (an unknown type is drawn as a note). Text and background colours keep BlockNote's
  attributes (`data-style-type` / `data-value` on text, `data-text-color` / `data-background-color` on blocks and
  table cells), and public pages now draw them in both themes. Only public pages use this server HTML.

### MCP tools
No new tool and no description change; every tool now carries its annotation hints (docs/adr/2460-*): full 48 tools
(~13,245 tokens; 0.19: ~12,777), core 32 (~7,857; 0.19: ~7,533), server instructions unchanged (~492). `catch_up`
is no longer marked read-only and `update_row` is marked destructive. Details: [MCP.md](MCP.md).

## v0.21.0 additions

No migration and no server change: endpoints, request bodies and answers are the same as in 0.20.0.

### PDF preview (docs/adr/2480–2482)
- The web app's PDF preview reads the file's size and type from `GET /api/files/:id/meta` and fetches the file
  through `GET /files/:id`, both as before (same checks, same headers), then draws it in the browser. Nothing new is
  stored and no route takes a new field.

### MCP tools
No new tool and no description change: the same numbers as 0.20, full 48 tools (~13,245 tokens), core 32 (~7,857),
server instructions ~492. Details: [MCP.md](MCP.md).
