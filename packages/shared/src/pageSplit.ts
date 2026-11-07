import { z } from 'zod'

// ---------------------------------------------------------------------------
// Splitting a page into subpages and automatic splitting of growing logs (docs/adr/1140-*, 1141-*)
// ---------------------------------------------------------------------------

/** Most subpages one split creates (a page with more sections is split in several runs). */
export const SPLIT_MAX_PAGES = 200

/** POST /api/pages/:id/split */
export const splitPageSchema = z.object({
  /** Heading level the page is cut at: a section starts at a top-level heading of this level. */
  level: z.number().int().min(1).max(6),
  /** Heading block ids of the sections to move; omitted = every section of that level. */
  sections: z.array(z.string().min(1).max(100)).max(SPLIT_MAX_PAGES).optional(),
  /** true = only return the plan (nothing is written). */
  preview: z.boolean().optional(),
})
export type SplitPageInput = z.infer<typeof splitPageSchema>

/** One section of the plan (or one created subpage). */
export interface SplitSectionDTO {
  /** Id of the section's heading block (kept in the subpage). */
  blockId: string
  /** Section anchor on the page before the split (`read_page section=`). */
  anchor: string
  /** Heading text = title of the subpage. */
  title: string
  /** Top-level blocks the section holds, heading included. */
  blocks: number
  /** Approximate stored size of the section (Yjs V2 bytes of its blocks). */
  bytes: number
  /** Comment threads anchored in the section (they move with it). */
  comments: number
  /** Created subpage (absent in a preview). */
  pageId?: string
}

export interface SplitPlanDTO {
  pageId: string
  level: number
  /** Headings of each level 1–6 at the top level of the page (for the level picker). */
  levels: number[]
  sections: SplitSectionDTO[]
  /** Blocks that stay on the page (intro, higher-level headings, the link list that replaces the sections). */
  remainingBlocks: number
  /** Other people with the page open in an editor right now (the split reaches them live). */
  openBy: number
  preview: boolean
}

/** Automatic splitting of a log page: off, one subpage per month, or a new subpage past a size. */
export type RotationMode = 'off' | 'month' | 'size'

export const ROTATION_MIN_BYTES = 64 * 1024
export const ROTATION_MAX_BYTES = 8 * 1024 * 1024
export const ROTATION_DEFAULT_BYTES = 1024 * 1024

/** PUT /api/pages/:id/rotation */
export const setRotationSchema = z.object({
  mode: z.enum(['off', 'month', 'size']),
  /** Size mode: start a new subpage once the current one stores this many bytes (V1). */
  maxBytes: z.number().int().min(ROTATION_MIN_BYTES).max(ROTATION_MAX_BYTES).optional(),
})
export type SetRotationInput = z.infer<typeof setRotationSchema>

/** GET/PUT /api/pages/:id/rotation */
export interface PageRotationDTO {
  mode: RotationMode
  maxBytes: number
  /** The subpage appends go to right now (null = none yet, or the page itself in size mode). */
  current: { id: string; title: string } | null
}

/** POST /api/pages/:id/rotation/target — where an append to this page should be written. */
export interface RotationTargetDTO {
  /** Page to append to: the page itself when it does not rotate. */
  pageId: string
  title: string
  /** The append goes to a subpage instead of the page that was addressed. */
  rotated: boolean
  /** The subpage was created by this call. */
  created: boolean
  mode: RotationMode
}
