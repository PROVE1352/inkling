/**
 * Backup failure alerts (docs/adr/0607-*). Polls the sidecar's status.json and, for each new
 * problem (failed run, failed restore test, failed remote copy, silent sidecar):
 *   1. creates an in-app notification (type 'backup_failed') for every admin,
 *   2. mails the admins when SMTP is configured,
 *   3. calls notifyBackupFailureExternal() — the hook for future instance-level channels.
 *
 * Dedupe is DB-based and restart-safe: an alert is "already sent" when a backup_failed
 * notification exists that was created at or after the alert's timestamp.
 */
import { and, eq, gte } from 'drizzle-orm'
import { db } from '../db/index'
import { notifications, users } from '../db/schema'
import { env, mailEnabled } from '../env'
import { resolveLocale } from '../i18n'
import { appOrigin, backupFailedMail, sendMail } from '../mail'
import { currentAlert, isConfigured, readStatus, type BackupAlert } from './store'

const POLL_MS = 2 * 60 * 1000
const FIRST_POLL_MS = 30 * 1000
/** Do not alert about problems older than this (e.g. right after first deploying the feature). */
const MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000

/**
 * Extension point for instance-level alert channels.
 * TODO: workspace webhooks (src/webhooks.ts) are workspace-scoped and only carry page events,
 * so there is no instance-wide Slack/Discord channel to post a backup failure to yet. When an
 * instance-level webhook setting exists, deliver `alert` here (summary only, no paths/secrets).
 */
export async function notifyBackupFailureExternal(
  _alert: BackupAlert,
  _log: (msg: string) => void,
): Promise<void> {
  // intentionally empty — see TODO above
}

async function alreadyNotified(at: Date): Promise<boolean> {
  const [row] = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(and(eq(notifications.type, 'backup_failed'), gte(notifications.createdAt, at)))
    .limit(1)
  return !!row
}

async function mailAdmins(
  admins: { email: string; locale: string | null }[],
  alert: BackupAlert,
  log: (msg: string) => void,
): Promise<void> {
  if (!mailEnabled) return
  const origin = appOrigin()
  for (const a of admins) {
    // delegated accounts use a fake mirror domain that never receives mail
    if (a.email.endsWith(`@${env.delegatedEmailDomain}`)) continue
    // each admin gets the alert in their own saved locale (else DEFAULT_LOCALE)
    const content = backupFailedMail({
      kind: alert.kind,
      at: alert.at,
      details: alert.message,
      origin,
      locale: resolveLocale(a.locale),
    })
    try {
      await sendMail(a.email, content, log)
    } catch {
      // sendMail already logged the SMTP error code; keep going with the other admins
    }
  }
}

export async function checkBackupAlerts(log: (msg: string) => void, now = Date.now()): Promise<boolean> {
  if (!(await isConfigured())) return false
  const status = await readStatus()
  if (!status) return false
  const alert = currentAlert(status, now)
  if (!alert) return false
  const at = new Date(alert.at)
  if (Number.isNaN(at.getTime()) || now - at.getTime() > MAX_AGE_MS) return false
  if (await alreadyNotified(at)) return false

  const admins = await db
    .select({ id: users.id, email: users.email, locale: users.locale })
    .from(users)
    .where(eq(users.isAdmin, true))
  if (admins.length === 0) return false
  await db.insert(notifications).values(
    admins.map((a) => ({ userId: a.id, type: 'backup_failed' as const, actorId: null })),
  )
  log(`[backup] alert (${alert.kind}): ${alert.message} — notified ${admins.length} admin(s)`)
  await mailAdmins(admins, alert, log)
  await notifyBackupFailureExternal(alert, log)
  return true
}

/** Starts the poller; returns a stop function. Timers are unref'd (never block shutdown). */
export function startBackupMonitor(log: (msg: string) => void): () => void {
  let busy = false
  const tick = () => {
    if (busy) return
    busy = true
    checkBackupAlerts(log)
      .catch((err) => log(`[backup] alert check failed: ${(err as Error).message}`))
      .finally(() => {
        busy = false
      })
  }
  const first = setTimeout(tick, FIRST_POLL_MS)
  const every = setInterval(tick, POLL_MS)
  first.unref()
  every.unref()
  return () => {
    clearTimeout(first)
    clearInterval(every)
  }
}
