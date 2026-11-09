import { z } from 'zod'
import type { NotificationType } from './index'

// ---------------------------------------------------------------------------
// Later list with reminders, followed comment threads (docs/adr/1410-* .. 1413-*)
// ---------------------------------------------------------------------------

export const LATER_KINDS = ['page', 'thread', 'notification'] as const
export type LaterKind = (typeof LATER_KINDS)[number]

/** Open (not done) items per person; saving beyond it answers 409 LATER_FULL. */
export const LATER_MAX_OPEN = 500
/** Items per list response (newest first). */
export const LATER_LIST_MAX = 200
/** A reminder may be set at most this far ahead. */
export const LATER_REMIND_MAX_DAYS = 2 * 366

const remindAtSchema = z.iso.datetime({ offset: true })
/** IANA zone of the device the time was picked on ("Asia/Seoul"); stored for wording, not read yet. */
const remindTzSchema = z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9_+\-/]+$/, 'Invalid time zone')

/** POST /later — save (or save again: the same target is one item; done items reopen). */
export const saveLaterSchema = z
  .object({
    kind: z.enum(LATER_KINDS),
    pageId: z.uuid().optional(),
    threadId: z.uuid().optional(),
    notificationId: z.uuid().optional(),
    anchor: z.string().trim().min(1).max(200).optional(),
    remindAt: remindAtSchema.nullable().optional(),
    remindTz: remindTzSchema.optional(),
  })
  .refine(
    (d) =>
      d.kind === 'page' ? !!d.pageId : d.kind === 'thread' ? !!d.threadId : !!d.notificationId,
    { message: 'page needs pageId, thread needs threadId, notification needs notificationId' },
  )
export type SaveLaterInput = z.infer<typeof saveLaterSchema>

/** PATCH /later/:id — mark done / open again, set or clear the reminder. */
export const updateLaterSchema = z
  .object({
    done: z.boolean().optional(),
    remindAt: remindAtSchema.nullable().optional(),
    remindTz: remindTzSchema.optional(),
  })
  .refine((d) => d.done !== undefined || d.remindAt !== undefined, { message: 'Nothing to change' })
export type UpdateLaterInput = z.infer<typeof updateLaterSchema>

/** GET /later?workspaceId=&state=open|done */
export const laterQuerySchema = z.object({
  workspaceId: z.uuid().optional(),
  state: z.enum(['open', 'done']).default('open'),
})

export interface LaterItemDTO {
  id: string
  kind: LaterKind
  workspaceId: string
  pageId: string
  threadId: string | null
  anchor: string | null
  /**
   * The person can open the target now (live page they can see, member or guest of a live
   * workspace that does not block them). When false every field taken from the target is null:
   * the list keeps the item so it can be deleted, but never shows its title (docs/adr/1410-*).
   */
  accessible: boolean
  pageTitle: string | null
  /** Thread: first line of the root comment; notification: its excerpt. */
  preview: string | null
  /** Thread: author of the root comment; notification: who caused it. */
  actorName: string | null
  /** Saved notification: its type while the notification row still exists. */
  notificationType: NotificationType | null
  remindAt: string | null
  remindTz: string | null
  /** The reminder came due and was delivered (or is being delivered). */
  reminded: boolean
  done: boolean
  doneAt: string | null
  createdAt: string
}

export interface LaterListDTO {
  items: LaterItemDTO[]
  /** Open items in total (all workspaces, or the one asked for). */
  open: number
  /** Open items whose reminder already came due. */
  due: number
}

/** GET /later/target?pageId=|threadId=|notificationId=|id= — is this target saved, and its reminder. */
export const laterTargetQuerySchema = z
  .object({
    pageId: z.uuid().optional(),
    threadId: z.uuid().optional(),
    notificationId: z.uuid().optional(),
    /** An item of the list by its own id. */
    id: z.uuid().optional(),
  })
  .refine((d) => [d.pageId, d.threadId, d.notificationId, d.id].filter(Boolean).length === 1, {
    message: 'Pass exactly one of pageId, threadId, notificationId, id',
  })

// --- followed threads --------------------------------------------------------------

/** PUT /threads/:id/follow */
export const followThreadSchema = z.object({ following: z.boolean() })

/** GET /threads?workspaceId=&all=1 */
export const threadsQuerySchema = z.object({
  workspaceId: z.uuid(),
  /** Also followed threads without new replies (to review or unfollow). */
  all: z
    .enum(['0', '1'])
    .optional()
    .transform((v) => v === '1'),
})

export const THREADS_LIST_MAX = 100

export interface ThreadFollowDTO {
  threadId: string
  following: boolean
  /** 'auto' = started or replied, 'manual' = followed by hand; null = no row (not following). */
  source: 'auto' | 'manual' | null
}

export interface ThreadSummaryDTO {
  threadId: string
  pageId: string
  workspaceId: string
  pageTitle: string
  blockId: string
  resolved: boolean
  rootAuthor: string | null
  rootExcerpt: string
  /** Replies by someone else since I last read the thread. */
  newReplies: number
  replies: number
  lastReply: { author: string | null; excerpt: string; createdAt: string } | null
  lastActivityAt: string
  lastReadAt: string
}

export interface ThreadListDTO {
  threads: ThreadSummaryDTO[]
  /** Followed threads with new replies in this workspace. */
  unread: number
}
