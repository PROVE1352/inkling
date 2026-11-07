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
 */

const RESERVED = ['inkling', 'admin', 'administrator', 'system', 'root', 'owner', 'moderator', 'support', 'staff', '관리자', '시스템', '운영자', '잉클링']

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
  for (const r of RESERVED) if (foldName(r) === f) return r
  return RESERVED_FOLDED.has(f) ? f : null
}

/**
 * Display name of a member of any workspace `userId` belongs to (themselves included) that the
 * client name imitates, or null. Run at consent time: only then is it known whose workspaces the
 * connection will act in, and the check does not reveal names to an anonymous registrant.
 */
export async function memberNameClash(name: string, userId: string): Promise<string | null> {
  const f = foldName(name)
  if (!f) return null
  const rows = (await db.execute(sql`
    SELECT DISTINCT u.name FROM workspace_members me
      JOIN workspace_members m ON m.workspace_id = me.workspace_id
      JOIN users u ON u.id = m.user_id
     WHERE me.user_id = ${userId}
  `)) as unknown as { name: string }[]
  for (const r of rows) if (foldName(r.name) === f) return r.name
  return null
}
