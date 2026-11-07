import { and, eq, isNull, or, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import type { PageKind, PageMetaDTO, PageScope, RowDTO } from '@inkling/shared'
import { db } from './db/index'
import { pages } from './db/schema'
import { liveWorkspace } from './workspaceLive'
import { agentAllowedSql } from './agentAccess'
import { twoFactorBlockedSql, twoFactorRequired } from './twoFactorPolicy'
import { visibleRangeSql } from './tokenRange'

/**
 * Shared projection that selects only the pages columns the API responses need.
 * List/create/update/trash/search/backlink/import responses all reuse this helper.
 */
export const pageColumns = {
  id: pages.id,
  workspaceId: pages.workspaceId,
  parentId: pages.parentId,
  kind: pages.kind,
  scope: pages.scope,
  title: pages.title,
  icon: pages.icon,
  coverUrl: pages.coverUrl,
  aliases: pages.aliases,
  sortOrder: pages.sortOrder,
  // Full width (M13): true when the properties array has {id:'fullWidth', value:true}.
  //   Only the derived boolean is sent instead of the whole properties array, keeping the response size unchanged.
  fullWidth: sql<boolean>`(${pages.properties} @> '[{"id":"fullWidth","value":true}]'::jsonb)`,
  createdAt: pages.createdAt,
  updatedAt: pages.updatedAt,
  deletedAt: pages.deletedAt,
  editLocked: pages.editLocked,
} as const

export type PageRow = {
  id: string
  workspaceId: string
  parentId: string | null
  kind: PageKind
  scope: PageScope
  title: string
  icon: string | null
  coverUrl: string | null
  aliases: unknown
  sortOrder: number
  fullWidth: boolean
  createdAt: Date
  updatedAt: Date
  deletedAt: Date | null
  /** Own edit lock (docs/adr/0970-*); optional so hand-built rows need not carry it. */
  editLocked?: boolean
}

export function toPageDTO(row: PageRow): PageMetaDTO {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    parentId: row.parentId,
    kind: row.kind,
    scope: row.scope,
    title: row.title,
    icon: row.icon,
    coverUrl: row.coverUrl,
    aliases: Array.isArray(row.aliases) ? (row.aliases as string[]) : [],
    sortOrder: row.sortOrder,
    fullWidth: row.fullWidth === true,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
    ...(row.editLocked ? { editLocked: true as const } : {}),
  }
}

/**
 * Projection helper for collection rows (RowDTO).
 * pageColumns stays as is (keeps existing response sizes); props are added only in collection responses.
 */
export function toRowDTO(row: PageRow, props: Record<string, unknown>): RowDTO {
  return { ...toPageDTO(row), props: props ?? {} }
}

/** Fetch one live page (null if none) */
export async function findLivePage(id: string): Promise<PageRow | null> {
  const rows = await db
    .select(pageColumns)
    .from(pages)
    .where(and(eq(pages.id, id), isNull(pages.deletedAt), liveWorkspace(pages.workspaceId)))
    .limit(1)
  return rows[0] ?? null
}

/**
 * M6 visibility condition (drizzle expression).
 * A page is visible to `userId` when:
 *   scope='shared'
 *   OR (scope='private' AND created_by = userId)   <- the private section is author-only
 *
 * A private page whose author was deleted (created_by IS NULL) is visible to nobody — admins and
 * workspace owners included (C-H1, docs/adr/0803-*). Forced deletion moves such pages to the trash
 * where the 30-day purge removes them; they are never re-shared.
 *
 * Reused by every path that exposes pages (list / single-page guard / search / trash / backlinks / export tree / collab).
 * Inside a request of a range-limited connection it also requires the page to be in that range.
 * It references the pages table, so use it only in the where clause of queries that FROM/JOIN pages.
 */
export function visibleTo(userId: string): SQL {
  const visible = or(
    eq(pages.scope, 'shared'),
    and(eq(pages.scope, 'private'), eq(pages.createdBy, userId)),
  ) as SQL
  // A connection limited to some workspaces or one subtree (docs/adr/1200-*): every path that uses
  // this condition is narrowed with it. Nothing is added for browser sessions and unlimited tokens.
  const range = visibleRangeSql(userId)
  return range ? (and(visible, range) as SQL) : visible
}

/**
 * Fetch one page that is alive and visible to `userId` (null if missing or not visible).
 * Use instead of findLivePage in single-page access guards that have a permission context (signed-in user).
 * Returns null for invisible private pages to hide that they exist at all (the caller answers 404).
 */
export async function findVisiblePage(
  id: string,
  userId: string,
): Promise<PageRow | null> {
  const rows = await db
    .select({
      ...pageColumns,
      // "Require two-step verification" (docs/adr/1112-*): 403, not 404, so the client can say why.
      twoFactorBlocked: sql<boolean>`${twoFactorBlockedSql(pages.workspaceId, userId)}`,
    })
    .from(pages)
    .where(
      and(
        eq(pages.id, id),
        isNull(pages.deletedAt),
        visibleTo(userId),
        liveWorkspace(pages.workspaceId),
        // a page in a workspace that blocked the current agent connection is "not found" (docs/adr/0947-*)
        agentAllowedSql(pages.workspaceId),
      ),
    )
    .limit(1)
  const row = rows[0]
  if (!row) return null
  const { twoFactorBlocked, ...page } = row
  if (twoFactorBlocked) throw twoFactorRequired(page.workspaceId)
  return page
}
