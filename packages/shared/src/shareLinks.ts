import { z } from 'zod'

// ---------------------------------------------------------------------------
// Public link expiry and password (docs/adr/1170-*, 1171-*, 1172-*)
// ---------------------------------------------------------------------------

/** Presets offered by the share dialog; any other day count comes from "pick a date". */
export const SHARE_EXPIRY_PRESET_DAYS = [1, 7, 30] as const
/** Longest expiry the server accepts, counted from now (about ten years). */
export const SHARE_EXPIRY_MAX_DAYS = 3650
/** Workspace default for new links: 1..365 days, or null for "no expiry". */
export const SHARE_DEFAULT_EXPIRY_DAYS = { min: 1, max: 365 } as const
export const SHARE_PASSWORD_LENGTH = { min: 4, max: 128 } as const

const passwordSchema = z.string().min(SHARE_PASSWORD_LENGTH.min).max(SHARE_PASSWORD_LENGTH.max)
const expiresAtSchema = z.iso.datetime({ offset: true })
const expiresInDaysSchema = z.number().int().min(1).max(SHARE_EXPIRY_MAX_DAYS)
/** When the link opens (docs/adr/1844-*): an exact instant; null = at once. Always before the expiry. */
const startsAtSchema = z.iso.datetime({ offset: true })

/**
 * POST /pages/:id/share (body optional). Only used when a new link is made; an existing link is
 * returned unchanged (use PATCH). `expiresInDays` is counted on the server clock; `expiresAt` is an
 * exact instant (the dialog's "pick a date" sends the end of that local day). Omit both to apply
 * the workspace default; `expiresAt: null` asks for no expiry.
 */
export const createShareSchema = z
  .object({
    expiresAt: expiresAtSchema.nullable().optional(),
    expiresInDays: expiresInDaysSchema.optional(),
    startsAt: startsAtSchema.nullable().optional(),
    password: passwordSchema.optional(),
  })
  .strict()
  .refine((v) => !(v.expiresAt !== undefined && v.expiresInDays !== undefined), {
    message: 'Send expiresAt or expiresInDays, not both',
  })
export type CreateShareInput = z.infer<typeof createShareSchema>

/**
 * PATCH /pages/:id/share: change an existing link. Omitted fields stay as they are.
 * `expiresAt: null` removes the expiry; `password: null` removes the password; `startsAt: null`
 * opens a scheduled link at once (docs/adr/1844-*).
 */
export const updateShareSchema = z
  .object({
    expiresAt: expiresAtSchema.nullable().optional(),
    expiresInDays: expiresInDaysSchema.optional(),
    startsAt: startsAtSchema.nullable().optional(),
    password: passwordSchema.nullable().optional(),
    /** Visitors may download the page as Markdown (docs/adr/2362-*); only here, never when a link is made. */
    allowDownload: z.boolean().optional(),
  })
  .strict()
  .refine((v) => !(v.expiresAt !== undefined && v.expiresInDays !== undefined), {
    message: 'Send expiresAt or expiresInDays, not both',
  })
export type UpdateShareInput = z.infer<typeof updateShareSchema>

/** POST /api/public/:token/unlock */
export const unlockShareSchema = z.object({ password: z.string().min(1).max(SHARE_PASSWORD_LENGTH.max) }).strict()

/** Workspace rules for new public links (GET /pages/:id/share → `policy`, workspace settings). */
export interface SharePolicyDTO {
  /** New links expire after this many days unless the publisher picks otherwise; null = no default. */
  defaultExpiryDays: number | null
  /** New links need a password, and a link's password cannot be removed. */
  passwordRequired: boolean
}

/** Error codes of the public routes for a link that exists but is closed. */
export const SHARE_EXPIRED_CODE = 'SHARE_EXPIRED'
export const SHARE_PASSWORD_REQUIRED_CODE = 'SHARE_PASSWORD_REQUIRED'
