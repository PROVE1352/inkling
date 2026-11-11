import { sql } from 'drizzle-orm'
import { db } from '../db/index'
import { limits } from '../limits'
import { deleteAccount, planAccountDeletion, type DeleteAccountOptions, type DeleteAccountResult } from './deletion'

/**
 * Hourly jobs of the account piece (docs/adr/2515-*, 2516-*), registered from account/register.ts.
 * Log lines carry user ids and counts only, never a name, email or sign-in ID.
 */

export const EXPIRY_BATCH = 50
export const RETENTION_DAYS = 30

type DeleteFn = (userId: string, opts: DeleteAccountOptions) => Promise<DeleteAccountResult>

/**
 * Account lifetime: delete up to 50 accounts whose expires_at has passed and that are not admins,
 * oldest first, each in its own transaction (a failure is logged and the next one still runs).
 * Nothing at all unless ACCOUNT_LIFETIME_DAYS is set; with ACCOUNT_LIFETIME_DRY_RUN=1 only the plan
 * is logged. Accounts without expires_at (made before the setting, or admins) never match.
 * Returns the number deleted (dry run: the number that would be).
 */
export async function expireAccounts(log: (msg: string) => void, del: DeleteFn = deleteAccount): Promise<number> {
  if (limits.accountLifetimeDays === null) return 0
  const due = (await db.execute(sql`
    SELECT id FROM users
     WHERE expires_at IS NOT NULL AND expires_at < now() AND is_admin = false
     ORDER BY expires_at, id
     LIMIT ${EXPIRY_BATCH}
  `)) as unknown as { id: string }[]
  let n = 0
  for (const { id } of due) {
    if (limits.accountLifetimeDryRun) {
      const plan = await planAccountDeletion(db, id)
      log(`[inkling] account lifetime (dry run): would delete user ${id}, ${plan.purge.length} workspace(s) deleted, ${plan.transfer.length} handed over`)
      n++
      continue
    }
    try {
      const r = await del(id, { by: 'expiry', log })
      if (!r.deleted) continue
      n++
      log(`[inkling] account lifetime: deleted user ${id}, ${r.deletedWorkspaces} workspace(s) deleted, ${r.transferredWorkspaces} handed over`)
    } catch (err) {
      // the code only: a database error's text can quote the row
      const code = (err as { code?: unknown } | null)?.code
      log(`[inkling] account lifetime: deleting user ${id} failed (${typeof code === 'string' ? code : 'error'}); will retry next hour`)
    }
  }
  return n
}

/**
 * Retention: sign-up IP records after 30 days, and IP bans that ended more than 30 days ago (an
 * active ban — banned_until in the future — is never touched; lifting a ban sets banned_until to now).
 */
export async function purgeAccountRecords(now = new Date()): Promise<{ signupEvents: number; ipBans: number }> {
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 86_400_000).toISOString()
  const a = (await db.execute(sql`DELETE FROM signup_events WHERE created_at < ${cutoff}::timestamptz RETURNING id`)) as unknown as unknown[]
  const b = (await db.execute(sql`DELETE FROM ip_bans WHERE banned_until < ${cutoff}::timestamptz RETURNING id`)) as unknown as unknown[]
  return { signupEvents: a.length, ipBans: b.length }
}
