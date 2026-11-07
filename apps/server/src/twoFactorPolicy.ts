import { sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import type { WorkspaceTwoFactorStatus } from '@inkling/shared'
import { db } from './db/index'
import { AppError } from './errors'

/**
 * Workspace policy "require two-step verification" (docs/adr/1112-*).
 *
 * `workspaces.two_factor_required_at` (null = off) and `two_factor_grace_days`. Once the grace
 * period after turning it on has passed, a member who does not satisfy it gets 403
 * TWO_FACTOR_REQUIRED from every workspace-scoped route (requireMembership / findVisiblePage) and
 * from the collaboration socket. Satisfying it: TOTP turned on (`user_totp.enabled_at`), or a
 * delegated sign-in account, whose second factor is the upstream service's (docs/adr/1061-*).
 * Agent (MCP) requests run as the token's owner, so the owner's state decides.
 */

export const TWO_FACTOR_REQUIRED_MESSAGE =
  'This workspace requires two-step verification. Turn it on in Settings › Two-step verification to continue.'

export function twoFactorRequired(workspaceId: string): AppError {
  return new AppError(403, 'TWO_FACTOR_REQUIRED', TWO_FACTOR_REQUIRED_MESSAGE, undefined, { workspaceId })
}

/** SQL: `userId` satisfies a 2FA requirement (2FA on, or a delegated account). */
export function userSatisfiesSql(userId: string | SQL): SQL {
  return sql`exists (select 1 from users tfu where tfu.id = ${userId} and (tfu.origin = 'delegated'
    or exists (select 1 from user_totp tft where tft.user_id = tfu.id and tft.enabled_at is not null)))`
}

/**
 * SQL boolean: `userId` is blocked in the workspace `wsIdCol` by its 2FA requirement right now
 * (required, grace period over, not satisfied). Cheap when the requirement is off: the workspace
 * row is read by primary key and the user is never looked at.
 */
export function twoFactorBlockedSql(wsIdCol: AnyPgColumn | SQL, userId: string | SQL): SQL {
  return sql`exists (select 1 from workspaces tfw where tfw.id = ${wsIdCol}
    and tfw.two_factor_required_at is not null
    and tfw.two_factor_required_at + make_interval(days => tfw.two_factor_grace_days) <= now()
    and not ${userSatisfiesSql(userId)})`
}

/** Whether `userId` satisfies a 2FA requirement. */
export async function userSatisfiesTwoFactor(userId: string): Promise<boolean> {
  const [r] = (await db.execute(sql`SELECT ${userSatisfiesSql(userId)} AS ok`)) as unknown as { ok: boolean }[]
  return !!r?.ok
}

/** 403 TWO_FACTOR_REQUIRED when `userId` is blocked in `workspaceId` (collaboration socket, background paths). */
export async function isTwoFactorBlocked(workspaceId: string, userId: string): Promise<boolean> {
  const [r] = (await db.execute(
    sql`SELECT ${twoFactorBlockedSql(sql`${workspaceId}::uuid`, userId)} AS blocked`,
  )) as unknown as { blocked: boolean }[]
  return !!r?.blocked
}

export function twoFactorDeadline(requiredAt: Date | null, graceDays: number): Date | null {
  return requiredAt ? new Date(requiredAt.getTime() + graceDays * 86_400_000) : null
}

/** WorkspaceDTO.twoFactor for a caller whose own state is `satisfied`. */
export function twoFactorStatus(
  requiredAt: Date | null,
  graceDays: number,
  satisfied: boolean,
  now = Date.now(),
): WorkspaceTwoFactorStatus {
  const deadline = twoFactorDeadline(requiredAt, graceDays)
  if (!deadline) return { required: false, deadline: null, state: 'off' }
  const state = satisfied ? 'ok' : deadline.getTime() > now ? 'grace' : 'blocked'
  return { required: true, deadline: deadline.toISOString(), state }
}
