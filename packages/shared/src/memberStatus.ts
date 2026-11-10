import { z } from 'zod'

// ---------------------------------------------------------------------------
// Member status (docs/adr/1845-*, 1846-*)
// ---------------------------------------------------------------------------

export const MEMBER_STATUS_TEXT_MAX = 80
/** An emoji is a short grapheme sequence (flags, skin tones, ZWJ families), never more than this. */
export const MEMBER_STATUS_EMOJI_MAX = 16

export interface MemberStatusDTO {
  emoji: string | null
  text: string
  /** The status disappears at this instant (ISO, server clock); null = until cleared. */
  clearAt: string | null
}

/**
 * PUT /me/status. `clearAt` is an exact instant picked in the person's own time zone (the browser
 * turns "Friday 18:00" into an instant); null or omitted = until cleared. It must be in the future
 * and at most a year away. At least one of emoji and text.
 */
export const setMemberStatusSchema = z
  .object({
    emoji: z.string().trim().min(1).max(MEMBER_STATUS_EMOJI_MAX).nullable().optional(),
    text: z.string().trim().max(MEMBER_STATUS_TEXT_MAX).default(''),
    clearAt: z.iso.datetime({ offset: true }).nullable().optional(),
  })
  .strict()
  .refine((v) => !!v.emoji || v.text.length > 0, { message: 'Write a status or pick an emoji' })
export type SetMemberStatusInput = z.input<typeof setMemberStatusSchema>
