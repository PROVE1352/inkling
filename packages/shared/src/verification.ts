import { z } from 'zod'

// ---------------------------------------------------------------------------
// Page verification (docs/adr/1840-*, 1841-*, 1842-*)
// ---------------------------------------------------------------------------

/** Durations the verify dialog offers; "on a date" sends an exact instant instead. */
export const VERIFY_PRESET_DAYS = [30, 90, 180] as const
/** Longest verification, counted from now. */
export const VERIFY_MAX_DAYS = 365
/** Default "expiring soon" window of the verified list. */
export const VERIFY_EXPIRING_DAYS = 7
/** From this many changed sections (or one change too large to diff) the page "changed a lot" since verification. */
export const VERIFY_CHANGED_MANY = 3
export const VERIFY_NOTE_MAX = 200

/**
 * POST /pages/:id/verification. `expiresInDays` is counted on the server clock; `expiresAt` is an
 * exact instant (the dialog's "on a date" sends the end of that local day). Exactly one of them.
 */
export const verifyPageSchema = z
  .object({
    expiresInDays: z.number().int().min(1).max(VERIFY_MAX_DAYS).optional(),
    expiresAt: z.iso.datetime({ offset: true }).optional(),
    note: z.string().trim().max(VERIFY_NOTE_MAX).nullable().optional(),
  })
  .strict()
  .refine((v) => (v.expiresInDays === undefined) !== (v.expiresAt === undefined), {
    message: 'Send expiresInDays or expiresAt',
  })
export type VerifyPageInput = z.infer<typeof verifyPageSchema>

/** GET /workspaces/:id/verified query. `days` = the "expiring soon" window; mine=1 → verified by me. */
export const verifiedListQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).optional(),
  mine: z.enum(['0', '1']).optional(),
})

export interface PageVerificationDTO {
  /** 'expired' = past expiresAt: "needs verification again". */
  state: 'verified' | 'expired'
  /** Still verified but lapses within the list's window (default VERIFY_EXPIRING_DAYS days). */
  expiringSoon: boolean
  verifiedAt: string
  /** null when the account was deleted. */
  verifiedBy: { id: string; name: string } | null
  expiresAt: string
  note: string | null
  /**
   * Sections added, edited, removed or renamed since the verification (change feed; a lower
   * bound once change-feed retention has purged older rows).
   */
  changedSections: number
  /** changedSections ≥ VERIFY_CHANGED_MANY, or a change too large to diff was logged. */
  changedMuch: boolean
}

/** GET/POST/DELETE /pages/:id/verification */
export interface PageVerificationStatusDTO {
  verification: PageVerificationDTO | null
  /** The caller may verify or remove the verification (editors of the page; see docs/adr/1840-*). */
  canVerify: boolean
}

export interface VerifiedPageItemDTO {
  pageId: string
  title: string
  icon: string | null
  kind: 'doc' | 'folder' | 'canvas' | 'collection'
  verification: PageVerificationDTO
}

/** GET /workspaces/:id/verified — pages the caller can see, soonest expiry first. */
export interface VerifiedListDTO {
  expiringDays: number
  /** Expired: needs verification again. */
  expired: VerifiedPageItemDTO[]
  /** Still verified, lapsing within `expiringDays`. */
  expiring: VerifiedPageItemDTO[]
  /** Every other verified page. */
  verified: VerifiedPageItemDTO[]
}
