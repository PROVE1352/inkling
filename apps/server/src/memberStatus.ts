import { and, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm'
import type { MemberStatusDTO } from '@inkling/shared'
import { db } from './db/index'
import { pages, userStatuses, users, workspaceMembers } from './db/schema'
import { localISODate } from './review'
import { cleanText } from './mcpTools/trust'

/**
 * Member status (docs/adr/1845-*, 1846-*): one short message + emoji per account, with an optional
 * clear time. A status past its `clear_at` is treated as absent everywhere it is read (members
 * list, mention menu, presence, agent output); the row stays until the person sets or clears it
 * again, so no sweep is needed.
 */

/** SQL condition: the status row is live at the server's now. */
export const liveStatusSql = () => or(isNull(userStatuses.clearAt), gt(userStatuses.clearAt, sql`now()`))

export function toStatusDTO(row: { emoji: string | null; text: string; clearAt: Date | null } | null | undefined): MemberStatusDTO | null {
  if (!row) return null
  if (!row.emoji && !row.text) return null
  return { emoji: row.emoji, text: row.text, clearAt: row.clearAt ? row.clearAt.toISOString() : null }
}

/** Live statuses of these accounts (absent = none). */
export async function statusesFor(userIds: string[]): Promise<Map<string, MemberStatusDTO>> {
  const out = new Map<string, MemberStatusDTO>()
  const ids = [...new Set(userIds)].slice(0, 1000)
  if (ids.length === 0) return out
  const rows = await db
    .select({ userId: userStatuses.userId, emoji: userStatuses.emoji, text: userStatuses.text, clearAt: userStatuses.clearAt })
    .from(userStatuses)
    .where(and(inArray(userStatuses.userId, ids), liveStatusSql()))
  for (const r of rows) {
    const dto = toStatusDTO(r)
    if (dto) out.set(r.userId, dto)
  }
  return out
}

// ---------------------------------------------------------------------------
// Agent output (docs/adr/1846-*). Status text is member-written: cleaned, quoted, capped, and only
// shown for people who are members of the workspace the agent is working in.
// ---------------------------------------------------------------------------

/** `"🎓 Exam week" until 2026-11-14` (server-local date), or `"…"` without a clear time. */
export function statusPhrase(s: MemberStatusDTO): string {
  const label = cleanText([s.emoji, s.text].filter(Boolean).join(' ')).replace(/"/g, "'")
  return `"${label}"${s.clearAt ? ` until ${localISODate(new Date(s.clearAt))}` : ''}`
}

const USER_MENTION_RE = /@\[([^[\]\n]*)\]\(user:([0-9a-fA-F-]{36})\)/g
const MAX_MENTIONED = 20

/** User ids mentioned as `@[Name](user:<id>)` in agent-written Markdown (first MAX_MENTIONED). */
export function mentionedUserIds(markdown: string | undefined | null): string[] {
  if (!markdown || !markdown.includes('(user:')) return []
  const ids = new Set<string>()
  USER_MENTION_RE.lastIndex = 0
  for (let m = USER_MENTION_RE.exec(markdown); m && ids.size < MAX_MENTIONED; m = USER_MENTION_RE.exec(markdown)) {
    ids.add(m[2].toLowerCase())
  }
  return [...ids]
}

/**
 * One line after a write that mentions people with a status: `status: Alice "🎓 Exam week" until
 * 2026-11-14; Bob "…"`. null when nobody mentioned (and in the workspace) has one — no tokens.
 */
export async function mentionStatusLine(workspaceId: string | null | undefined, markdown: string | undefined | null): Promise<string | null> {
  const ids = mentionedUserIds(markdown)
  if (!workspaceId || ids.length === 0) return null
  return peopleStatusLine(workspaceId, ids)
}

/**
 * `mentionStatusLine` for a page the caller has just written to (the write route already checked
 * access): the workspace is read only when the Markdown mentions someone.
 */
export async function mentionStatusLineForPage(pageId: string, markdown: string | undefined | null): Promise<string | null> {
  if (mentionedUserIds(markdown).length === 0) return null
  const [row] = await db.select({ workspaceId: pages.workspaceId }).from(pages).where(eq(pages.id, pageId)).limit(1)
  return mentionStatusLine(row?.workspaceId, markdown)
}

/** Live statuses of these people that are members of `workspaceId` (others are left out). */
export async function memberStatuses(
  workspaceId: string,
  userIds: string[],
): Promise<Map<string, { name: string; status: MemberStatusDTO }>> {
  const out = new Map<string, { name: string; status: MemberStatusDTO }>()
  const ids = [...new Set(userIds)].filter((id) => /^[0-9a-f-]{36}$/i.test(id)).slice(0, MAX_MENTIONED)
  if (ids.length === 0) return out
  const rows = await db
    .select({ id: users.id, name: users.name, emoji: userStatuses.emoji, text: userStatuses.text, clearAt: userStatuses.clearAt })
    .from(userStatuses)
    .innerJoin(users, eq(users.id, userStatuses.userId))
    .innerJoin(workspaceMembers, and(eq(workspaceMembers.userId, users.id), eq(workspaceMembers.workspaceId, workspaceId)))
    .where(and(inArray(userStatuses.userId, ids), liveStatusSql()))
  for (const r of rows) {
    const status = toStatusDTO(r)
    if (status) out.set(r.id, { name: r.name, status })
  }
  return out
}

/** The same line for given people (members of `workspaceId` only), in name order. */
export async function peopleStatusLine(workspaceId: string, userIds: string[]): Promise<string | null> {
  const parts = [...(await memberStatuses(workspaceId, userIds)).values()]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((r) => `${cleanText(r.name)} ${statusPhrase(r.status)}`)
  return parts.length ? `status: ${parts.join('; ')}` : null
}
