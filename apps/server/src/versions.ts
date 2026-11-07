import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { db } from './db/index'

/**
 * Change markers used for cheap cache validation (docs/adr/0752-*, 0753-*).
 *
 * indexEpoch: bumped by every write to a derived index (page_links/texts/tags/tasks). Live
 * typing bumps pages.updated_at at store time but the derived indexes follow later (debounced,
 * docs/adr/0750-*), so caches over index-backed data must include this as well.
 */
let epoch = 0
/** Distinguishes epochs of different processes (the counter restarts at 0 on boot). */
const BOOT_ID = randomUUID().slice(0, 8)

export function bumpIndexEpoch(): void {
  epoch++
}

export function indexEpoch(): string {
  return `${BOOT_ID}:${epoch}`
}

/**
 * Cheap change marker for a workspace: any page edit (doc store bumps pages.updated_at), trash /
 * restore, creation, or collection field change alters it. One indexed aggregate over the
 * workspace's pages (pages_workspace_deleted_idx).
 */
export async function workspaceVersion(workspaceId: string): Promise<string> {
  const rows = (await db.execute(sql`
    SELECT
      (SELECT max(greatest("updated_at", coalesce("deleted_at", "updated_at")))::text FROM "pages" WHERE "workspace_id" = ${workspaceId}) AS "a",
      (SELECT count(*)::text FROM "pages" WHERE "workspace_id" = ${workspaceId} AND "deleted_at" IS NULL) AS "b",
      (SELECT max("c"."updated_at")::text FROM "collections" "c" JOIN "pages" "p" ON "p"."id" = "c"."page_id" WHERE "p"."workspace_id" = ${workspaceId}) AS "c"
  `)) as unknown as { a: string | null; b: string | null; c: string | null }[]
  const r = rows[0]
  return `${r?.a ?? ''}|${r?.b ?? ''}|${r?.c ?? ''}`
}
