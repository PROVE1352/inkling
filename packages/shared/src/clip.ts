import { z } from 'zod'
import type { PageMetaDTO } from './index'

// Web clipper (docs/adr/2260-* .. 2263-*): POST /api/clip saves what a person saw on the web as a page,
// GET /api/clip/lookup finds the pages already saved from a URL. The /clip screen, the bookmarklet and
// the installed app's share target all end in the same request.

/** Longest title, selected text and URL the clipper takes (the /clip screen cuts query values to these). */
export const CLIP_MAX_TITLE = 300
export const CLIP_MAX_TEXT = 20_000
export const CLIP_MAX_URL = 2048
export const CLIP_MAX_TAGS = 10
export const CLIP_MAX_TAG_LEN = 40

/** One tag as the body's `#tag` index reads it (md/tagIndex.ts): letters, digits, _ / -. */
export const CLIP_TAG_RE = /^[\p{L}\p{N}_/-]+$/u

export const clipModeSchema = z.enum(['link', 'article'])
export type ClipMode = z.infer<typeof clipModeSchema>

export const clipRequestSchema = z.object({
  workspaceId: z.uuid(),
  parentId: z.uuid().nullish(),
  url: z.string().trim().max(CLIP_MAX_URL).optional(),
  title: z.string().max(CLIP_MAX_TITLE).optional(),
  text: z.string().max(CLIP_MAX_TEXT).optional(),
  mode: clipModeSchema.default('link'),
  tags: z
    .array(
      z
        .string()
        .trim()
        .max(CLIP_MAX_TAG_LEN + 1)
        .transform((s) => s.replace(/^#/, ''))
        .pipe(z.string().min(1).max(CLIP_MAX_TAG_LEN).regex(CLIP_TAG_RE)),
    )
    .max(CLIP_MAX_TAGS)
    .optional(),
})
export type ClipRequest = z.input<typeof clipRequestSchema>

/**
 * Why an `article` save was stored as a link instead (the page is still created):
 * the fetch failed or was refused, the URL is not a web page, or no article body was found.
 */
export type ClipFallback = 'fetch_failed' | 'not_html' | 'no_content'

export interface ClipResultDTO {
  page: PageMetaDTO
  /** What was stored: `article` only when a body was extracted. */
  mode: ClipMode
  fallback?: ClipFallback
  /** The article was longer than the cap and was cut. */
  truncated?: boolean
}

export interface ClipLookupDTO {
  /** Live pages the caller can see whose Source property is this URL (newest first, at most 5). */
  pages: { id: string; title: string; workspaceId: string; createdAt: string }[]
}

/**
 * Property ids the clipper writes (ordinary page properties, editable afterwards): the source URL
 * (type url) and when it was saved (type text, "YYYY-MM-DD HH:MM UTC" — not a date property, which
 * would put every clip on the calendar and in the due list).
 */
export const CLIP_SOURCE_PROPERTY = 'source'
export const CLIP_SAVED_PROPERTY = 'clipped'
