import { sql } from 'drizzle-orm'
import { db } from './db/index'

/**
 * OAuth client names that could pass for the product, an operator or a member (docs/adr/0978-*).
 *
 * The client name is what people see in "Connected agents", the audit log ("Alice via <client>")
 * and the change feed. A client calling itself "Inkling", "Admin" or a member's display name would
 * make agent writes look like system or human actions. Names are compared after folding: NFKC,
 * lower case, common look-alike letters and digits mapped to Latin, everything that is not a
 * letter or digit removed ("ＡＤＭＩＮ", "Adm1n", "a d m i n", "\u0410dmin" with a Cyrillic \u0410 all fold
 * to "admin"). Length and control-character cleanup stay where they were (registration slices to
 * 100 characters; bearer requests sanitise the label).
 *
 * Member names are a separate, narrower rule (docs/adr/1007-*, superseding that part of 0978):
 * exact comparison only (NFKC + case + spacing), enforced per workspace where such a member is,
 * and only a warning for common app names.
 */

// 'public form' is the via of public form answers, read as a person's input (docs/adr/1870-*)
const RESERVED = ['inkling', 'admin', 'administrator', 'system', 'root', 'owner', 'moderator', 'support', 'staff', '관리자', '시스템', '운영자', '잉클링', 'public form']

/** Look-alikes folded to the Latin letter they imitate (Cyrillic, Greek, leetspeak). */
const CONFUSABLE: Record<string, string> = {
  а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', у: 'y', х: 'x', і: 'i', ј: 'j', ѕ: 's', һ: 'h', ԁ: 'd', ӏ: 'l', к: 'k', м: 'm', т: 't', в: 'b', н: 'h',
  α: 'a', ε: 'e', ι: 'i', κ: 'k', ν: 'v', ο: 'o', ρ: 'p', τ: 't', υ: 'u', χ: 'x', μ: 'm',
  '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', $: 's', '!': 'i', '|': 'i', l: 'i',
}

/** Folded comparison key of a display name. */
export function foldName(s: string): string {
  const lower = s.normalize('NFKC').toLowerCase()
  let out = ''
  for (const ch of lower) {
    const c = CONFUSABLE[ch] ?? ch
    if (/[\p{L}\p{N}]/u.test(c)) out += c
  }
  return out
}

const RESERVED_FOLDED = new Set(RESERVED.map(foldName))

/** The reserved word a client name imitates, or null. Exact folded match ("Inkling Notes Helper" is fine). */
export function reservedClientName(name: string): string | null {
  const f = foldName(name)
  if (!f) return null
  // the via of database automations is "automation: <rule>" (agentVia.ts, docs/adr/2242-*): no client starts so
  if (f.startsWith('automation')) return 'automation'
  for (const r of RESERVED) if (foldName(r) === f) return r
  return RESERVED_FOLDED.has(f) ? f : null
}

/**
 * Common app names (docs/adr/1007-*). A member whose display name is one of these ("Claude") must
 * not lock that app out of a whole team, so a clash with such a name is only a warning on the
 * consent screen. Compared with `exactName`.
 */
export const WELL_KNOWN_CLIENTS = [
  'claude', 'claude code', 'claude desktop', 'claude.ai', 'chatgpt', 'openai', 'codex', 'cursor', 'copilot',
  'github copilot', 'gemini', 'gemini cli', 'windsurf', 'cline', 'continue', 'zed', 'goose', 'vs code', 'vscode',
  'raycast', 'perplexity', 'mistral', 'le chat', 'jetbrains', 'junie', 'amp', 'warp', 'opencode', 'kiro',
]

/** Exact comparison key for member-name checks: NFKC, lower case, whitespace collapsed (no look-alike folding). */
export function exactName(s: string): string {
  return s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()
}

const WELL_KNOWN = new Set(WELL_KNOWN_CLIENTS.map(exactName))

export function isWellKnownClient(name: string): boolean {
  return WELL_KNOWN.has(exactName(name))
}

/**
 * Members whose display name equals the client name exactly, in the workspaces of `userId` (other
 * members only: a person may name their own connection after themselves). Returns the member name
 * and the workspaces where such a member is, or null.
 */
export async function memberNameClashes(
  name: string,
  userId: string,
): Promise<{ member: string; workspaces: { id: string; name: string }[] } | null> {
  const key = exactName(name)
  if (!key) return null
  const rows = (await db.execute(sql`
    SELECT u.name AS member, w.id, w.name FROM workspace_members me
      JOIN workspaces w ON w.id = me.workspace_id AND w.deleted_at IS NULL
      JOIN workspace_members m ON m.workspace_id = me.workspace_id AND m.user_id <> ${userId}
      JOIN users u ON u.id = m.user_id
     WHERE me.user_id = ${userId}
     ORDER BY w.name, w.id
  `)) as unknown as { member: string; id: string; name: string }[]
  const hits = rows.filter((r) => exactName(r.member) === key)
  if (!hits.length) return null
  const seen = new Set<string>()
  const workspaces = hits.filter((h) => (seen.has(h.id) ? false : (seen.add(h.id), true))).map((h) => ({ id: h.id, name: h.name }))
  return { member: hits[0].member, workspaces }
}

/** The display name of a member of any of `userId`'s workspaces (themselves included) the client name equals exactly. */
export async function memberNameClash(name: string, userId: string): Promise<string | null> {
  const key = exactName(name)
  if (!key) return null
  const rows = (await db.execute(sql`
    SELECT DISTINCT u.name FROM workspace_members me
      JOIN workspace_members m ON m.workspace_id = me.workspace_id
      JOIN users u ON u.id = m.user_id
     WHERE me.user_id = ${userId}
  `)) as unknown as { name: string }[]
  for (const r of rows) if (exactName(r.name) === key) return r.name
  return null
}

/**
 * Per-workspace rule (docs/adr/1007-*): an agent connection whose client name equals another
 * member's display name in THIS workspace is refused here (other workspaces are unaffected), unless
 * the name is a common app name (warning only). True = refuse.
 */
export async function clientNameClashesInWorkspace(clientName: string | null, userId: string, workspaceId: string): Promise<boolean> {
  if (!clientName || isWellKnownClient(clientName)) return false
  const key = exactName(clientName)
  if (!key) return false
  const rows = (await db.execute(sql`
    SELECT u.name FROM workspace_members m JOIN users u ON u.id = m.user_id
     WHERE m.workspace_id = ${workspaceId}::uuid AND m.user_id <> ${userId}::uuid
  `)) as unknown as { name: string }[]
  return rows.some((r) => exactName(r.name) === key)
}
