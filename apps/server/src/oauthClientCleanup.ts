import { sql, type SQL } from 'drizzle-orm'
import { db } from './db/index'
import { oauthClients } from './db/schema'
import { limits } from './limits'
import type { Tx } from './pageTree'

/**
 * Self-registered OAuth clients that were never used (0.22 security fix F3, contract §14,
 * docs/adr/2536-*). `POST /oauth/register` needs no account, so on a server open to strangers its
 * rows pile up (about 20 KB each at most). Two settings, both off by default: without them nothing
 * here deletes anything (a production server's MCP connections are rows of this table).
 *
 *   OAUTH_UNUSED_CLIENT_HOURS  the hourly housekeeping deletes never-used clients registered more
 *                              than this many hours ago
 *   OAUTH_UNUSED_CLIENT_MAX    a registration that would pass this many never-used clients first
 *                              deletes the oldest ones; it never deletes one younger than
 *                              PROTECT_MINUTES (someone may be on the consent screen with it): if
 *                              only those are left, the registration is refused for now (503)
 *
 * "Never used" = a dynamic registration (`ink_c_…`; agent connection tokens `ink_tc_…` and metadata
 * document clients, whose id is a URL, are never candidates) that nothing points at: no
 * authorization code, no grant (an expired one included, until the hourly purge removes it), no
 * agent block, no agent access record. OAUTH_CLIENT_REFERENCES lists every foreign key to
 * oauth_clients; a test compares it with the database catalog, so a new one cannot be missed (all of
 * them cascade: missing one would delete live rows with the client).
 */

/** Every table with a foreign key to oauth_clients.id (column client_id). */
export const OAUTH_CLIENT_REFERENCES = ['oauth_codes', 'oauth_grants', 'workspace_agent_access', 'workspace_agent_blocks'] as const

/** A registration younger than this is never pushed out by the cap. */
export const PROTECT_MINUTES = 15

/** Advisory lock of the cap (registrations count and delete one at a time). */
const OAUTH_CAP_LOCK = 4_651_204
/** Rows the hourly job deletes at most per run (the rest go next hour). */
const SWEEP_BATCH = 5_000

/** SQL: client row `c` is a dynamic registration nothing points at. */
function unusedSql(): SQL {
  const refs = OAUTH_CLIENT_REFERENCES.map((t) => sql`NOT EXISTS (SELECT 1 FROM ${sql.identifier(t)} r WHERE r.client_id = c.id)`)
  return sql`left(c.id, 6) = 'ink_c_' AND ${sql.join(refs, sql` AND `)}`
}

/**
 * Delete up to `max` of the oldest never-used clients registered before `olderThan`. Two statements in
 * the caller's transaction: lock the candidates (rows another transaction holds, e.g. a code being
 * inserted for one, are skipped), then delete them only if still unused, with a fresh snapshot of
 * committed rows (a code or grant committed meanwhile keeps its client). A reference inserted after the
 * lock waits for this transaction and then fails, as for any deleted client.
 */
async function deleteOldestUnused(tx: Pick<Tx, 'execute'>, olderThan: Date, max: number): Promise<number> {
  if (max <= 0) return 0
  const picked = (await tx.execute(sql`
    SELECT c.id FROM oauth_clients c
     WHERE ${unusedSql()} AND c.created_at < ${olderThan.toISOString()}::timestamptz
     ORDER BY c.created_at, c.id
     LIMIT ${max}
     FOR UPDATE SKIP LOCKED
  `)) as unknown as { id: string }[]
  if (picked.length === 0) return 0
  const ids = `{${picked.map((p) => `"${p.id.replace(/["\\]/g, '')}"`).join(',')}}`
  const rows = (await tx.execute(sql`
    DELETE FROM oauth_clients c WHERE c.id = ANY(${ids}::text[]) AND ${unusedSql()} RETURNING c.id
  `)) as unknown as unknown[]
  return rows.length
}

/** Never-used dynamic clients (for tests and the cap). */
export async function countUnusedClients(exec: Pick<Tx, 'execute'> = db): Promise<number> {
  const [r] = (await exec.execute(sql`SELECT count(*)::int AS n FROM oauth_clients c WHERE ${unusedSql()}`)) as unknown as { n: number }[]
  return Number(r?.n ?? 0)
}

/**
 * The hourly job: never-used clients older than OAUTH_UNUSED_CLIENT_HOURS, then (if the cap was
 * lowered) the oldest past OAUTH_UNUSED_CLIENT_MAX, never one younger than PROTECT_MINUTES.
 * Nothing without the settings. Returns the number deleted.
 */
export async function purgeUnusedOAuthClients(now = new Date()): Promise<number> {
  let n = 0
  const hours = limits.oauthUnusedClientHours
  if (hours !== undefined) n += await db.transaction((tx) => deleteOldestUnused(tx, new Date(now.getTime() - hours * 3_600_000), SWEEP_BATCH))
  const cap = limits.oauthUnusedClientMax
  if (cap !== undefined) {
    n += await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${OAUTH_CAP_LOCK})`)
      const over = (await countUnusedClients(tx)) - cap
      return deleteOldestUnused(tx, new Date(now.getTime() - PROTECT_MINUTES * 60_000), Math.min(over, SWEEP_BATCH))
    })
  }
  return n
}

export type RegisterResult = { ok: true; createdAt: Date } | { ok: false; retryAfterSec: number }

/**
 * Store a dynamic registration (`POST /oauth/register`). Without OAUTH_UNUSED_CLIENT_MAX: a plain
 * insert, as before. With it: under one lock, make room by deleting the oldest never-used clients
 * registered more than PROTECT_MINUTES ago; when the never-used ones are all younger than that (a
 * burst of registrations from several addresses), refuse instead of pushing out someone who is
 * signing in right now.
 */
export async function insertDynamicClient(row: { id: string; name: string; redirectUris: string[] }, now = new Date()): Promise<RegisterResult> {
  const cap = limits.oauthUnusedClientMax
  if (cap === undefined) {
    const [r] = await db.insert(oauthClients).values(row).returning({ createdAt: oauthClients.createdAt })
    return { ok: true, createdAt: r.createdAt }
  }
  return db.transaction(async (tx): Promise<RegisterResult> => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${OAUTH_CAP_LOCK})`)
    const over = (await countUnusedClients(tx)) + 1 - cap
    if (over > 0) {
      const freed = await deleteOldestUnused(tx, new Date(now.getTime() - PROTECT_MINUTES * 60_000), over)
      if (freed < over) return { ok: false, retryAfterSec: 60 }
    }
    const [r] = await tx.insert(oauthClients).values(row).returning({ createdAt: oauthClients.createdAt })
    return { ok: true, createdAt: r.createdAt }
  })
}
