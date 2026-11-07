# Inkling API Contract (M1)

The shared contract between the server and web agents. **This document is the source of truth**: implementations must not diverge from it.
Request validation schemas and DTO types are defined in `@inkling/shared` (packages/shared/src/index.ts), and both sides import them.

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

- Built-in ids in default order (`SIDEBAR_MENU_IDS`): `search, graph, tags, shared, due, calendar, activity, today`.
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
| POST | `/api/files?workspaceId=<uuid>` | multipart field `file` (one) | `{ file: FileDTO }`: `url` is `/files/<id>` |
| GET | `/files/:id` | - | Binary stream. Headers: Content-Type from the row's `mime`, `Content-Disposition: inline; filename*=UTF-8''<encoded>`, `Cache-Control: private, max-age=31536000, immutable`, ETag=id. Unauthenticated 401, non-member 403. |

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
| GET | `/api/pages/:id/backlinks` | `{ pages: PageMetaDTO[] }`: live pages that link to this page (membership checked, updatedAt desc) |
| POST | `/api/pages/:id/restore` | `{ page }`: sets `deleted_at=null` on the page and its descendants. If the parent is still deleted, `parentId=null` (moved to the root). 400 if the target is not deleted |
| DELETE | `/api/pages/:id/purge` | 204: hard delete (cascade). Allowed **only for deleted (trashed) pages**, otherwise 400 |
| GET | `/api/workspaces/:id/trash` | `{ pages: PageMetaDTO[] }`: all deleted pages (flat), deletedAt desc |
| GET | `/api/workspaces/:id/search?q=` | `{ pages: PageMetaDTO[] }`: title ILIKE substring match (escaped), live pages only, limit 20, updatedAt desc. Empty q → empty array |

## Export / Import

| Method | Path | Input/Output |
|---|---|---|
| GET | `/api/pages/:id/export?format=md` | `text/markdown; charset=utf-8` attachment (single page, children excluded). Image links keep their absolute `/files/...` paths |
| GET | `/api/pages/:id/export?format=zip` | zip: the page + its subtree. Structure follows the convention below |
| GET | `/api/workspaces/:id/export` | zip: the whole workspace tree |
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
- `GET /api/pages/:id/snapshots` → `{ snapshots: SnapshotDTO[] }` newest 50.
- `GET /api/pages/:id/snapshots/:sid/preview` → `{ markdown: string }`.
- `POST /api/pages/:id/snapshots/:sid/restore` → 204. Applied to the live document (DirectConnection), with an automatic snapshot taken just before restoring. Canvas 400.
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

Read: `find_context(query, workspaceId?, budget?)`, `read_page(pageId, outline?, section?, maxChars?)`, `read_pages(pageIds[], budget?)`,
`list_workspaces`, `list_pages(workspaceId, parentId?|'root', depth?, format?)`, `search(query, workspaceId?, format?)`,
`changes_since(cursor?, workspaceId?, budget?, detail?)`, `query_rows(collectionId, filter?, sort?, fields?, limit?, cursor?, describe?)`, `list_templates`,
`get_instructions(workspaceId, forPageId?)` (docs/adr/0975-*). Text outputs wrap member-written content in `<untrusted_content …>` and print
`can:` / `applies:` / `suspicious:` lines (docs/adr/0976-*, 0977-*).
Write (refused for read-only tokens): `patch_section(pageId, section, markdown?, mode, baseVersion?)`, `update_page(pageId, markdown, mode: append|replace)`,
`create_page(workspaceId, title, markdown, parentId?, private?)`, `import_folder`, `update_row(rowId, properties, baseVersion)`, `create_row(collectionId, title?, properties?)`,
`rename_page`, `move_page(pageId, parentId|null, section?)` (within the same workspace only), `trash_page` (soft delete), `add_comment(pageId, body)` (anchored to the first block), `create_from_template`.
`list_pages` and `search` keep their legacy JSON unless `format: "lines"` (docs/adr/0928-*).

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
| GET | `/api/context` | `q` (1–300 chars), `workspaceId?` (else every live workspace I belong to), `budget?` (≤ 12,000, default 3,500) | `{ fragments: [{pageId, workspaceId, title, anchor, headingPath, sections: [{anchor, headingPath, version}], ords, text, tokens, score, truncated}], more: [{pageId, title, anchor, headingPath, tokens}], titleOnly: [{pageId, title, kind}], budget, usedTokens, candidates }`. Only live, visible pages of live workspaces |
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

OAuth: `POST /oauth/register` refuses a `client_name` that folds to a reserved word (Inkling, Admin, System, …;
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
| GET | `/api/changes/:seq/diff` | – | `ChangeDiffDTO { before, after, ops: [{t:'='\|'-'\|'+', s}] \| null, large, … }`; 404 unless the page is visible now and the row was visible when logged |
| GET | `/api/pages/:id/snapshots/:sid/diff` | `against=current\|<snapshot id>` | `SnapshotDiffDTO { from, to, ops, large }` (Markdown of both versions, line diff) |
| GET | `/api/pages/:id/provenance` | – | `PageProvenanceDTO { createdVia, createdByName, lastAgentEdit: {at, via, actorName} \| null }` |
| GET | `/api/inbox` | `workspaceId?, cursor?, kinds=mention,reply,comment,assigned,…` | `{ items: InboxItem[], more, unacked }` — unacknowledged direct items of the caller in `seq` order (MCP `inbox`) |
| POST | `/api/inbox/ack` | `{ ids?: string[], cursor?: string }` | `{ acked }` — sets `acked_at`; does not touch `read` |

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
(state-vector hash + metadata hash); `contentHash` is SHA-256 of the normalized canonical
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
| DELETE | `/api/templates/:id` | 204. Built-in key → 403; creator or owner only |
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
