/**
 * What a page guest gets with a collection (docs/adr/2146-*). A guest cannot read the workspace's
 * member list, so the names of the people in the person, created-by and last-edited-by cells of the
 * rows they can see come with the rows: members only (a person cell never names anyone else, C-L11),
 * names only (no email, no other member).
 */
import { and, inArray, isNull } from 'drizzle-orm'
import { isPersonLikeType } from '@inkling/shared'
import type { CollectionField } from '@inkling/shared'
import { db } from '../db/index'
import { pages, users } from '../db/schema'
import { visibleTo } from '../pageDto'
import { isWorkspaceMember } from '../collectionRelations'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function guestPeopleNames(
  workspaceId: string,
  fields: CollectionField[],
  rows: { props: Record<string, unknown> }[],
): Promise<Record<string, string>> {
  const ids = new Set<string>()
  const people = fields.filter((f) => isPersonLikeType(f.type))
  for (const r of rows) {
    for (const f of people) {
      const v = r.props[f.id]
      for (const x of Array.isArray(v) ? v : [v]) if (typeof x === 'string' && UUID_RE.test(x)) ids.add(x.toLowerCase())
    }
  }
  const out: Record<string, string> = {}
  if (!ids.size) return out
  const list = [...ids]
  for (let i = 0; i < list.length; i += 500) {
    const us = await db
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(and(inArray(users.id, list.slice(i, i + 500)), isWorkspaceMember(workspaceId)))
    for (const u of us) out[u.id] = u.name
  }
  return out
}

/** Agent connection keys next to person cells (docs/adr/1861-*) are not for guests; in place. */
export function stripAgentKeys(props: Record<string, unknown>): void {
  for (const k of Object.keys(props)) if (k.startsWith('agent:')) delete props[k]
}

/** The nil uuid that stands for a relation target a guest cannot open. */
export const HIDDEN_TARGET = '00000000-0000-0000-0000-000000000000'

/**
 * Field definitions for a guest: a relation whose target collection is outside their trees names no
 * collection (the nil uuid, no pair field), so not even its id reaches them. Rollups keep their
 * relation field id; their values are computed over visible rows only.
 */
export async function redactHiddenTargets(fields: CollectionField[], userId: string): Promise<CollectionField[]> {
  const targets = [...new Set(fields.flatMap((f) => (f.type === 'relation' && f.relation ? [f.relation.targetPageId] : [])))]
  if (!targets.length) return fields
  const seen = new Set(
    (await db.select({ id: pages.id }).from(pages).where(and(inArray(pages.id, targets), isNull(pages.deletedAt), visibleTo(userId)))).map((r) => r.id),
  )
  return fields.map((f) =>
    f.type === 'relation' && f.relation && !seen.has(f.relation.targetPageId)
      ? { ...f, relation: { targetPageId: HIDDEN_TARGET, ...(f.relation.subItems ? { subItems: true } : {}) } }
      : f,
  )
}
