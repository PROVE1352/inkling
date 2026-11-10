import { eq } from 'drizzle-orm'
import type { SharePolicyDTO } from '@inkling/shared'
import { SHARE_EXPIRY_MAX_DAYS } from '@inkling/shared'
import type { Exec as AnyExec } from './workspaceAdmin'
import { workspaces } from './db/schema'
import { AppError, badRequest } from './errors'

/**
 * Owner side of public link expiry, passwords and the workspace rules for new links
 * (docs/adr/1170-*, 1171-*, 1172-*). The visitor side is shareAccess.ts.
 */

type Exec = Pick<AnyExec, 'select'>
const DAY_MS = 86_400_000

/** Lock the workspace row FOR SHARE (a concurrent settings change waits) and read its link rules. */
export async function lockSharePolicy(
  tx: Exec,
  workspaceId: string,
): Promise<SharePolicyDTO & { publicSharingDisabled: boolean }> {
  const [ws] = await tx
    .select({
      publicSharingDisabled: workspaces.publicSharingDisabled,
      defaultExpiryDays: workspaces.shareDefaultExpiryDays,
      passwordRequired: workspaces.sharePasswordRequired,
    })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .for('share')
    .limit(1)
  return {
    publicSharingDisabled: ws?.publicSharingDisabled ?? false,
    defaultExpiryDays: ws?.defaultExpiryDays ?? null,
    passwordRequired: ws?.passwordRequired ?? false,
  }
}

export async function readSharePolicy(exec: Exec, workspaceId: string): Promise<SharePolicyDTO> {
  const [ws] = await exec
    .select({ defaultExpiryDays: workspaces.shareDefaultExpiryDays, passwordRequired: workspaces.sharePasswordRequired })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1)
  return { defaultExpiryDays: ws?.defaultExpiryDays ?? null, passwordRequired: ws?.passwordRequired ?? false }
}

/**
 * Requested expiry → instant on the server clock. undefined = not asked (keep / apply the default),
 * null = no expiry. `expiresInDays` counts from the server's now, so a visitor's or publisher's
 * clock never matters; an explicit instant must be in the future and at most ~10 years away.
 */
export function resolveShareExpiry(
  input: { expiresAt?: string | null; expiresInDays?: number },
  now = Date.now(),
): Date | null | undefined {
  if (input.expiresInDays !== undefined) return new Date(now + input.expiresInDays * DAY_MS)
  if (input.expiresAt === undefined) return undefined
  if (input.expiresAt === null) return null
  const at = new Date(input.expiresAt)
  if (Number.isNaN(at.getTime())) throw badRequest('expiresAt is not a valid date')
  if (at.getTime() <= now + 60_000) throw badRequest('Pick an expiry in the future')
  if (at.getTime() > now + SHARE_EXPIRY_MAX_DAYS * DAY_MS) throw badRequest('Pick an expiry within ten years')
  return at
}

/**
 * Requested start of a scheduled link (docs/adr/1844-*) → instant on the server clock.
 * undefined = not asked (keep), null = open at once. A start that is already past is the same as
 * "at once" (stored as null), so a link never shows a start that no longer matters.
 */
export function resolveShareStart(input: { startsAt?: string | null }, now = Date.now()): Date | null | undefined {
  if (input.startsAt === undefined) return undefined
  if (input.startsAt === null) return null
  const at = new Date(input.startsAt)
  if (Number.isNaN(at.getTime())) throw badRequest('startsAt is not a valid date')
  if (at.getTime() > now + SHARE_EXPIRY_MAX_DAYS * DAY_MS) throw badRequest('Pick a start within ten years')
  return at.getTime() <= now ? null : at
}

/** A link must open before it expires (400 otherwise). */
export function assertShareWindow(startsAt: Date | null, expiresAt: Date | null): void {
  if (startsAt && expiresAt && startsAt.getTime() >= expiresAt.getTime()) {
    throw badRequest('Pick a start before the expiry')
  }
}

export const sharePasswordPolicyError = () =>
  new AppError(403, 'SHARE_PASSWORD_POLICY', 'This workspace requires a password on public links')

/** The status fields of a link (the password itself never leaves the server). */
export function shareLinkFields(
  row: { shareExpiresAt: Date | null; sharePasswordHash: string | null; shareStartsAt?: Date | null; shareAllowDownload?: boolean },
  now = Date.now(),
): { expiresAt: string | null; expired: boolean; hasPassword: boolean; startsAt: string | null; notStarted: boolean; allowDownload: boolean } {
  const startsAt = row.shareStartsAt ?? null
  return {
    expiresAt: row.shareExpiresAt ? row.shareExpiresAt.toISOString() : null,
    expired: row.shareExpiresAt !== null && row.shareExpiresAt.getTime() <= now,
    hasPassword: row.sharePasswordHash !== null,
    // scheduled links (docs/adr/1844-*)
    startsAt: startsAt ? startsAt.toISOString() : null,
    notStarted: startsAt !== null && startsAt.getTime() > now,
    // visitors may download Markdown (docs/adr/2362-*)
    allowDownload: row.shareAllowDownload === true,
  }
}

/** Columns cleared together with the token whenever a link is removed (unpublish, bulk, policy). */
export const CLEARED_SHARE_LINK = {
  shareToken: null,
  shareTokenEnc: null,
  shareExpiresAt: null,
  shareStartsAt: null,
  sharePasswordHash: null,
  shareAllowDownload: false,
} as const
