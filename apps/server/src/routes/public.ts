import { and, eq, isNull, sql } from 'drizzle-orm'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { createHash, createHmac } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { unlockShareSchema } from '@inkling/shared'
import type { PublicFolderDTO, PublicPageDTO, PublicTreeNodeDTO } from '@inkling/shared'
import { db } from '../db/index'
import { files, pageDocs, pages } from '../db/schema'
import { hashShareToken } from '../secretsAtRest'
import { env } from '../env'
import { notFound } from '../errors'
import { assertAccount, recordFailure } from '../guard'
import {
  assertShareOpen,
  checkSharePassword,
  padResponseTime,
  publicFileCacheControl,
  setUnlockCookie,
  shareExpired,
  shareExpiredError,
  shareNotStarted,
  sharePasswordInvalidError,
} from '../shareAccess'
import type { ShareGate } from '../shareAccess'
import { BoundedLru } from '../lru'
import { liveWorkspace } from '../workspaceLive'
import { collectionTableMdShared } from '../md/exporter'
import { chartsToTables, publicFor } from '../charts/render'
import type { ChartDataFn } from '../charts/render'
import {
  blocksToFullHTML,
  collectAssetFileIds,
  markdownToBlocks,
  neutralizeInternalLinksForPublic,
  parseFileUrl,
  rewriteAssetUrlsForPublic,
  rewriteInternalLinksForPublic,
  stateToBlocks,
} from '../md/convert'
import type { AnyBlock } from '../md/convert'

// Public route rate limit: a gentle 60/min per route, separate from the global 300/min.
const PUBLIC_RATE_LIMIT = { rateLimit: { max: 60, timeWindow: '1 minute' } }
// Password attempts: as strict as sign-in (docs/adr/1171-*), on top of the per-link backoff and IP ban.
const UNLOCK_RATE_LIMIT = { rateLimit: { max: 10, timeWindow: '1 minute' } }

// Safe rasters allowed to render inline (cannot run scripts). Everything else (pdf/video/svg...) is an attachment.
// Intentionally identical to the same-named set in files.ts, to keep the public routes self-contained.
const SAFE_INLINE_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
])

// Tokens are base64url (A–Z a–z 0–9 - _). Only the format is loosely checked; existence is decided by lookup (404 if missing).
const tokenParamSchema = z.object({ token: z.string().min(1).max(128) })
const fileParamSchema = z.object({
  token: z.string().min(1).max(128),
  fileId: z.uuid(),
})
// Folder-share subpage ref = first 22 chars (≈131 bits) of base64url(HMAC-SHA256(key=shareToken, msg=pageId)).
const REF_RE = /^[A-Za-z0-9_-]{22}$/
const refParamSchema = z.object({
  token: z.string().min(1).max(128),
  ref: z.string().regex(REF_RE),
})
const refFileParamSchema = refParamSchema.extend({ fileId: z.uuid() })

/** Minimal info about a shared page used by the public routes (internal ids/owner/membership never go into a response). */
export interface SharedPage {
  id: string
  workspaceId: string
  kind: 'doc' | 'folder' | 'canvas' | 'collection'
  scope: 'shared' | 'private'
  title: string
  icon: string | null
  coverUrl: string | null
  updatedAt: Date
}

/**
 * Opaque identifier of a folder-share subpage. To keep the internal pageId out of public URLs we
 * use a truncated HMAC(shareToken, pageId): it is one-way, so the pageId cannot be derived from
 * the ref, and when the token changes (unshare → reshare) every ref changes too. The live subtree
 * is recomputed on every request to look up ref→page, so no mapping table/migration is needed.
 */
function refFor(token: string, pageId: string): string {
  return createHmac('sha256', token).update(pageId).digest('base64url').slice(0, 22)
}

/** The page a token points at, with its expiry and password gate (docs/adr/1170-*, 1171-*). */
export interface SharedRoot extends SharedPage {
  gate: ShareGate
}

/** One page of a folder share's subtree (the root folder itself excluded). */
export interface SubtreePage extends SharedPage {
  parentId: string | null
}

/**
 * The **current** subtree of a shared folder (computed per request, so children added later are
 * included automatically). Descent stops at trashed (deleted_at), private (scope='private') and
 * template pages, excluding their whole subtree. Limited to the same workspace, depth guard of 64
 * (protects against parent cycles). Ordered by sort_order, created_at.
 */
export async function loadSharedSubtree(
  rootId: string,
  workspaceId: string,
): Promise<SubtreePage[]> {
  const rows = (await db.execute(sql`
    WITH RECURSIVE sub AS (
      SELECT id, 0 AS depth FROM pages WHERE id = ${rootId}
      UNION ALL
      SELECT p.id, s.depth + 1 FROM pages p
      JOIN sub s ON p.parent_id = s.id
      WHERE p.deleted_at IS NULL
        AND p.scope = 'shared'
        AND p.workspace_id = ${workspaceId}
        AND s.depth < 64
    )
    SELECT p.id, p.parent_id, p.workspace_id, p.kind, p.scope, p.title, p.icon,
           p.cover_url, p.updated_at
    FROM pages p JOIN sub s ON s.id = p.id
    WHERE p.id <> ${rootId}
    ORDER BY p.sort_order ASC, p.created_at ASC
  `)) as unknown as {
    id: string
    parent_id: string | null
    workspace_id: string
    kind: SharedPage['kind']
    scope: SharedPage['scope']
    title: string
    icon: string | null
    cover_url: string | null
    updated_at: Date | string
  }[]
  return rows.map((r) => ({
    id: r.id,
    parentId: r.parent_id,
    workspaceId: r.workspace_id,
    kind: r.kind,
    scope: r.scope,
    title: r.title,
    icon: r.icon,
    coverUrl: r.cover_url,
    updatedAt: r.updated_at instanceof Date ? r.updated_at : new Date(r.updated_at),
  }))
}

/** Folder-share context: token → (root folder, subtree, two-way ref map). null if the token is not a folder token. */
export interface FolderShare {
  root: SharedRoot
  pages: SubtreePage[]
  refById: Map<string, string>
  byRef: Map<string, SubtreePage>
}

export async function loadFolderShare(token: string): Promise<FolderShare | null> {
  const root = await findSharedPageByToken(token)
  if (!root || root.kind !== 'folder') return null
  return buildFolderShare(root, token)
}

/** Folder-share context for a root already looked up (and gated) by the caller. */
export async function buildFolderShare(root: SharedRoot, token: string): Promise<FolderShare> {
  const list = await loadSharedSubtree(root.id, root.workspaceId)
  const refById = new Map<string, string>()
  const byRef = new Map<string, SubtreePage>()
  for (const p of list) {
    const ref = refFor(token, p.id)
    refById.set(p.id, ref)
    byRef.set(ref, p)
  }
  return { root, pages: list, refById, byRef }
}

/** Subtree → public tree. Collection rows (children) are hidden from the tree as in the app sidebar (they show as a table). */
function buildPublicTree(share: FolderShare, token: string): PublicTreeNodeDTO[] {
  const byParent = new Map<string, SubtreePage[]>()
  for (const p of share.pages) {
    const key = p.parentId ?? ''
    const arr = byParent.get(key)
    if (arr) arr.push(p)
    else byParent.set(key, [p])
  }
  const build = (parentId: string): PublicTreeNodeDTO[] =>
    (byParent.get(parentId) ?? []).map((p) => {
      const ref = share.refById.get(p.id)!
      return {
        ref,
        title: p.title,
        icon: publicizeChildAssetUrl(p.icon, token, ref),
        kind: p.kind,
        children: p.kind === 'collection' ? [] : build(p.id),
      }
    })
  return build(share.root.id)
}

function publicChildFileUrl(token: string, ref: string, fileId: string): string {
  return `/api/public/${token}/p/${ref}/f/${fileId}`
}

function publicizeChildAssetUrl(url: string | null, token: string, ref: string): string | null {
  const fid = parseFileUrl(url)
  return fid ? publicChildFileUrl(token, ref, fid) : url
}

/**
 * Shared file streaming (after the gate). Only safe rasters are inline; everything else is an
 * attachment. Cache lifetime follows the link: never past its expiry, browser-only for password
 * links (docs/adr/1170-*, 1171-*).
 */
function sendPublicFile(
  reply: FastifyReply,
  file: { id: string; mime: string; name: string },
  gate: ShareGate,
) {
  const filePath = uploadPath(file.id)
  if (!existsSync(filePath)) throw notFound()
  const inline = SAFE_INLINE_MIME.has(file.mime)
  reply.header('Content-Type', file.mime)
  reply.header('X-Content-Type-Options', 'nosniff')
  reply.header('Content-Security-Policy', "default-src 'none'; sandbox")
  reply.header(
    'Content-Disposition',
    `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
  )
  reply.header('Cache-Control', publicFileCacheControl(gate))
  reply.header('ETag', file.id)
  return reply.send(createReadStream(filePath))
}

function uploadPath(id: string): string {
  return path.join(env.dataDir, 'uploads', id)
}

/**
 * Find the live shared page for a shareToken (null if none).
 * No session/membership/workspace conditions: only a valid token, excluding soft-deleted pages.
 * scope='private' is excluded here defensively (publish already blocks it; belt and braces).
 */
export async function findSharedPageByToken(token: string): Promise<SharedRoot | null> {
  const tokenHash = hashShareToken(token)
  const row = (
    await db
      .select({
        id: pages.id,
        workspaceId: pages.workspaceId,
        kind: pages.kind,
        scope: pages.scope,
        title: pages.title,
        icon: pages.icon,
        coverUrl: pages.coverUrl,
        updatedAt: pages.updatedAt,
        // The gate is read from the same row; expiry is compared on the server clock by the caller,
        // so an expired link answers 410 instead of looking like an unknown token.
        expiresAt: pages.shareExpiresAt,
        // a scheduled link's start, compared the same way (docs/adr/1844-*)
        startsAt: pages.shareStartsAt,
        passwordHash: pages.sharePasswordHash,
      })
      .from(pages)
      .where(
        and(
          // stored as SHA-256 (docs/adr/1110-*); a 64-hex value is never a raw token
          eq(pages.shareToken, tokenHash),
          isNull(pages.deletedAt),
          eq(pages.scope, 'shared'),
          // A soft-deleted workspace's links stop working at once and come back on restore (ADR 0910).
          liveWorkspace(pages.workspaceId),
        ),
      )
      .limit(1)
  )[0]
  if (!row) return null
  const { expiresAt, startsAt, passwordHash, ...page } = row
  return { ...page, gate: { tokenHash, expiresAt, startsAt, passwordHash } }
}

/**
 * Load blocks for public rendering.
 *  - doc: page_docs.state → stateToBlocks (empty blocks if missing or corrupt)
 *  - collection: child rows (shared) as a GFM table → markdownToBlocks (internal links unresolved)
 * Other kinds (folder/canvas) get a 404 before the call, so they never reach here.
 */
async function loadPublicBlocks(page: SharedPage, charts?: ChartDataFn): Promise<AnyBlock[]> {
  if (page.kind === 'collection') {
    try {
      const md = await collectionTableMdShared(page.id)
      return await markdownToBlocks(md, () => null)
    } catch {
      return []
    }
  }
  const row = (
    await db
      .select({ state: pageDocs.state })
      .from(pageDocs)
      .where(eq(pageDocs.pageId, page.id))
      .limit(1)
  )[0]
  if (!row) return []
  let blocks: AnyBlock[]
  try {
    blocks = stateToBlocks(row.state)
  } catch {
    return []
  }
  // chart blocks: a table of data inside the link, else left out by blocksToFullHTML (docs/adr/1605-*)
  return charts ? chartsToTables(blocks, charts) : blocks
}

// ---------------------------------------------------------------------------
// Revision-keyed render caches (docs/adr/0753-*). Consulted only *after* the token/scope gate,
// keyed by page id + pages.updated_at (bumped by every document store) so an edit, rename or
// re-share is a new key; entries are bounded by count, bytes and TTL. Collections are not
// cached: their table depends on child rows whose edits do not bump the parent.
// ---------------------------------------------------------------------------
const RENDER_TTL_MS = 10 * 60_000
const htmlCache = new BoundedLru<string>(200, RENDER_TTL_MS, 32 * 1024 * 1024, (h) => h.length * 2)
const fileIdCache = new BoundedLru<Set<string>>(500, RENDER_TTL_MS, 8 * 1024 * 1024, (s) => 64 + s.size * 90)
export const publicRenderStats = { htmlHits: 0, htmlMisses: 0, fileHits: 0, fileMisses: 0 }

function revKey(page: SharedPage): string | null {
  return page.kind === 'doc' ? `${page.id}|${page.updatedAt.getTime()}` : null
}

async function cachedHtml(key: string | null, render: () => Promise<string>): Promise<string> {
  if (key) {
    const hit = htmlCache.get(key)
    if (hit !== undefined) {
      publicRenderStats.htmlHits++
      return hit
    }
  }
  publicRenderStats.htmlMisses++
  const html = await render()
  if (key) htmlCache.set(key, html)
  return html
}

/** The set of fileIds the page publicly references (body attachments + cover + icon). Basis of the file gate. */
async function publicAllowedFileIds(page: SharedPage): Promise<Set<string>> {
  // Every image on a public page used to re-decode the whole Yjs document for this gate.
  const rk = revKey(page)
  const key = rk ? `${rk}|${page.coverUrl ?? ''}|${page.icon ?? ''}` : null
  if (key) {
    const hit = fileIdCache.get(key)
    if (hit) {
      publicRenderStats.fileHits++
      return hit
    }
  }
  publicRenderStats.fileMisses++
  const ids = await computeAllowedFileIds(page)
  if (key) fileIdCache.set(key, ids)
  return ids
}

async function computeAllowedFileIds(page: SharedPage): Promise<Set<string>> {
  const blocks = await loadPublicBlocks(page)
  const ids = collectAssetFileIds(blocks)
  const cover = parseFileUrl(page.coverUrl)
  if (cover) ids.add(cover)
  const icon = parseFileUrl(page.icon)
  if (icon) ids.add(icon)
  return ids
}

/** Rewrite /files/<id> asset URLs to the public file path (external URLs, emoji etc. unchanged). */
function publicizeAssetUrl(url: string | null, token: string): string | null {
  const fid = parseFileUrl(url)
  return fid ? publicFileUrl(token, fid) : url
}

function publicFileUrl(token: string, fileId: string): string {
  return `/api/public/${token}/f/${fileId}`
}

/** Common security headers for page (HTML/JSON) responses: strict CSP + nosniff. */
function setPagePublicHeaders(reply: FastifyReply): void {
  reply.header(
    'Content-Security-Policy',
    "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'",
  )
  reply.header('X-Content-Type-Options', 'nosniff')
  // Live document, so no caching (unsharing/edits take effect immediately).
  reply.header('Cache-Control', 'no-store')
}

/**
 * Register the public routes, inside the /api group of index.ts without a preHandler.
 * (No session/membership involved; access is controlled only by token + scope + the reference gate.)
 */
export async function registerPublicRoutes(app: FastifyInstance): Promise<void> {
  // Shared page body (unauthenticated). Valid token → server-generated safe HTML (PublicPageDTO). Otherwise 404.
  app.get('/public/:token', { config: PUBLIC_RATE_LIMIT }, async (req, reply) => {
    const { token } = tokenParamSchema.parse(req.params)

    const page = await findSharedPageByToken(token)
    // If it is not a live shared page (invalid token/deleted/unshared), hide its existence with a 404.
    // Token guesses count as failures (repeated ones temporarily ban the IP).
    if (!page) {
      await recordFailure(req, 'share-token')
      throw notFound()
    }
    // Expired → 410, password without an unlock → 401 (docs/adr/1170-*, 1171-*).
    assertShareOpen(req, reply, page.gate)
    // Folder share: return the live subtree as a tree (bodies are fetched one by one via /p/:ref).
    if (page.kind === 'folder') {
      const share = await buildFolderShare(page, token)
      setPagePublicHeaders(reply)
      const dto: PublicFolderDTO = {
        kind: 'folder',
        title: page.title,
        icon: publicizeAssetUrl(page.icon, token),
        tree: buildPublicTree(share, token),
        updatedAt: page.updatedAt.toISOString(),
      }
      return dto
    }
    // Only doc and collection can be shared as a single page. canvas is unsupported → 404.
    if (page.kind !== 'doc' && page.kind !== 'collection') throw notFound()

    const rk = revKey(page)
    const html = await cachedHtml(rk && `p|${rk}|${token}`, async () => {
      const blocks = await loadPublicBlocks(page)
      // Security: turn internal-path links such as wikilinks (/w/...) into text (no workspace/page id leaks).
      neutralizeInternalLinksForPublic(blocks)
      // Rewrite image/attachment URLs (/files/<id>) to the token-scoped public path (avoids auth 404s + access gate).
      rewriteAssetUrlsForPublic(blocks, (fileId) => publicFileUrl(token, fileId))
      return blocksToFullHTML(blocks)
    })

    setPagePublicHeaders(reply)
    const dto: PublicPageDTO = {
      title: page.title,
      icon: publicizeAssetUrl(page.icon, token),
      coverUrl: publicizeAssetUrl(page.coverUrl, token),
      html,
      updatedAt: page.updatedAt.toISOString(),
    }
    return dto
  })

  // Stream only attachments the shared page references (unauthenticated). Gate: the file appears in
  // that page's blocks/cover/icon + belongs to the page's workspace. Any other fileId is a 404.
  app.get('/public/:token/f/:fileId', { config: PUBLIC_RATE_LIMIT }, async (req, reply) => {
    const { token, fileId } = fileParamSchema.parse(req.params)

    const page = await findSharedPageByToken(token)
    if (!page) {
      await recordFailure(req, 'share-token')
      throw notFound()
    }
    assertShareOpen(req, reply, page.gate)
    // A folder token only serves the folder's own icon/cover (subpage attachments use /p/:ref/f/:fileId).
    if (page.kind !== 'doc' && page.kind !== 'collection' && page.kind !== 'folder') {
      throw notFound()
    }

    const file = (
      await db.select().from(files).where(eq(files.id, fileId)).limit(1)
    )[0]
    if (!file) throw notFound()
    // Block cross-workspace reads.
    if (file.workspaceId !== page.workspaceId) throw notFound()

    // Only files this page actually references (blocks reading arbitrary fileIds).
    const allowed = await publicAllowedFileIds(page)
    if (!allowed.has(fileId)) throw notFound()
    // A single-page link serves files of that page only; a folder link's own icon/cover, files of
    // the folder itself (docs/adr/1302-*).
    if (!(await fileOwnerPageIsPublic(file.pageId, [page.id]))) throw notFound()

    // Only safe rasters inline, everything else as an attachment. Active types (svg etc.) are
    // already blocked at upload. The public cache stays short (content lingers little after unsharing).
    return sendPublicFile(reply, file, page.gate)
  })

  // ── Folder-share subpages ──────────────────────────────────────────
  // Folder token + ref (HMAC) → body of a doc/collection inside the subtree as a PublicPageDTO.
  // 404 if the ref is not in the subtree (outside/trashed/private/missing) or the kind cannot be viewed.
  app.get('/public/:token/p/:ref', { config: PUBLIC_RATE_LIMIT }, async (req, reply) => {
    const { token, ref } = refParamSchema.parse(req.params)

    const share = await openFolderShare(req, reply, token)
    const page = share.byRef.get(ref)
    if (!page) throw notFound()
    if (page.kind !== 'doc' && page.kind !== 'collection') throw notFound()

    // Link rewriting depends on which pages are currently inside the shared subtree, so the
    // key also carries a fingerprint of that membership.
    const rk = revKey(page)
    const members = rk
      ? createHash('sha1').update([...share.refById.keys()].sort().join(',')).digest('base64')
      : ''
    const html = await cachedHtml(rk && `c|${rk}|${token}|${ref}|${members}`, async () => {
      // charts may show collections inside this folder share (the root excluded: a folder has no rows)
      const inShare = new Map(share.pages.map((p) => [p.id, p]))
      const blocks = await loadPublicBlocks(page, publicFor(share.root.workspaceId, (id) => inShare.get(id)))
      // Keep only wikilinks pointing inside the subtree as public paths; turn the rest into text (no id leaks).
      rewriteInternalLinksForPublic(blocks, (pageId) => {
        if (pageId === share.root.id) return `/s/${token}`
        const r = share.refById.get(pageId)
        return r ? `/s/${token}/p/${r}` : null
      })
      rewriteAssetUrlsForPublic(blocks, (fileId) => publicChildFileUrl(token, ref, fileId))
      return blocksToFullHTML(blocks)
    })

    setPagePublicHeaders(reply)
    const dto: PublicPageDTO = {
      title: page.title,
      icon: publicizeChildAssetUrl(page.icon, token, ref),
      coverUrl: publicizeChildAssetUrl(page.coverUrl, token, ref),
      html,
      updatedAt: page.updatedAt.toISOString(),
    }
    return dto
  })

  // Attachments of a folder-share subpage. Gate: the ref is inside the subtree + the file appears in
  // **that subpage's** blocks/cover/icon + same workspace. fileIds of other pages (including outside) are 404.
  app.get(
    '/public/:token/p/:ref/f/:fileId',
    { config: PUBLIC_RATE_LIMIT },
    async (req, reply) => {
      const { token, ref, fileId } = refFileParamSchema.parse(req.params)

      const share = await openFolderShare(req, reply, token)
      const page = share.byRef.get(ref)
      if (!page) throw notFound()

      const file = (
        await db.select().from(files).where(eq(files.id, fileId)).limit(1)
      )[0]
      if (!file) throw notFound()
      if (file.workspaceId !== page.workspaceId) throw notFound()

      const allowed = await publicAllowedFileIds(page)
      if (!allowed.has(fileId)) throw notFound()
      // Files of pages inside the shared folder only (the folder and its current subtree).
      if (!(await fileOwnerPageIsPublic(file.pageId, [share.root.id, ...share.pages.map((p) => p.id)]))) throw notFound()

      return sendPublicFile(reply, file, share.root.gate)
    },
  )

  // Password entry (docs/adr/1171-*). Right password → 204 + an unlock cookie scoped to
  // /api/public/<token>. Every outcome runs one argon2 verify (a dummy hash when there is nothing to
  // compare with) and is answered no sooner than SHARE_UNLOCK_FLOOR_MS after the request arrived.
  // Wrong passwords count against the link (backoff for everyone on it) and the IP (ban); the
  // password is never logged or stored.
  app.post('/public/:token/unlock', { config: UNLOCK_RATE_LIMIT }, async (req, reply) => {
    const startedAt = Date.now()
    const { token } = tokenParamSchema.parse(req.params)
    const { password } = unlockShareSchema.parse(req.body ?? {})
    reply.header('Cache-Control', 'no-store')
    reply.header('X-Robots-Tag', 'noindex, nofollow')
    const linkKey = `share:${hashShareToken(token)}`
    // A link with piled-up wrong passwords is delayed for everyone before the expensive check.
    assertAccount(linkKey)

    const page = await findSharedPageByToken(token)
    const expired = !!page && shareExpired(page.gate)
    // before a scheduled start: the unknown-link answer, not counted (docs/adr/1844-*)
    const notStarted = !!page && shareNotStarted(page.gate)
    const ok = await checkSharePassword(page && !expired && !notStarted ? page.gate.passwordHash : null, password)
    let failure: Error | null = null
    if (!page) {
      await recordFailure(req, 'share-token')
      failure = notFound()
    } else if (notStarted) {
      failure = notFound()
    } else if (expired) {
      failure = shareExpiredError()
    } else if (page.gate.passwordHash && !ok) {
      await recordFailure(req, 'share-password', linkKey)
      failure = sharePasswordInvalidError()
    } else if (page.gate.passwordHash) {
      setUnlockCookie(reply, token, page.gate)
    }
    await padResponseTime(startedAt)
    if (failure) throw failure
    return reply.code(204).send()
  })
}

/**
 * Folder token → gated folder share for the child routes. Unknown token or a token that is not a
 * folder → 404 counted as a guess (as before); expired or locked → the gate's answer.
 */
async function openFolderShare(req: FastifyRequest, reply: FastifyReply, token: string): Promise<FolderShare> {
  const root = await findSharedPageByToken(token)
  if (!root) {
    await recordFailure(req, 'share-token')
    throw notFound()
  }
  assertShareOpen(req, reply, root.gate)
  if (root.kind !== 'folder') {
    await recordFailure(req, 'share-token')
    throw notFound()
  }
  return buildFolderShare(root, token)
}

/**
 * A file attached to a page is served publicly only while that page itself could be shared:
 * live and in the shared section (C-L11), and inside what the link shares (`sharedIds`: the page
 * of a single-page link, the folder and its subtree for a folder link, docs/adr/1302-*).
 * Referencing another page's attachment URL from a public page must not publish it. Files without
 * a page (legacy uploads) keep the reference gate.
 */
async function fileOwnerPageIsPublic(pageId: string | null, sharedIds: string[]): Promise<boolean> {
  if (!pageId) return true
  if (!sharedIds.includes(pageId)) return false
  const [p] = await db
    .select({ scope: pages.scope, deletedAt: pages.deletedAt })
    .from(pages)
    .where(eq(pages.id, pageId))
    .limit(1)
  return !!p && p.scope === 'shared' && !p.deletedAt
}
