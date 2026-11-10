import { z } from 'zod'

// ---------------------------------------------------------------------------
// Web push (docs/adr/2220-* .. 2223-*)
// ---------------------------------------------------------------------------

/**
 * Kinds of notification a person can push or not, grouped like the bell shows them:
 *  - mention:  @mentions in a page or a comment
 *  - assigned: task assignment, made owner of a page
 *  - reply:    replies in a thread I am in or follow
 *  - comment:  new comments on my pages and on pages I follow at "all"
 *  - approval: approval requests and their results
 *  - reminder: due dates and Later-list reminders
 *  - updates:  edits on pages I follow at "all", AI edit summaries
 */
export const PUSH_KIND_GROUPS = ['mention', 'assigned', 'reply', 'comment', 'approval', 'reminder', 'updates'] as const
export const pushKindGroupSchema = z.enum(PUSH_KIND_GROUPS)
export type PushKindGroup = z.infer<typeof pushKindGroupSchema>
/** Without a saved choice: everything except page edits. */
export const DEFAULT_PUSH_KINDS: readonly PushKindGroup[] = ['mention', 'assigned', 'reply', 'comment', 'approval', 'reminder']

/** Notification type → its push group (types without one never push). */
export const PUSH_GROUP_OF_TYPE: Readonly<Record<string, PushKindGroup>> = {
  doc_mention: 'mention',
  comment_mention: 'mention',
  task_assigned: 'assigned',
  page_owner: 'assigned',
  comment_reply: 'reply',
  comment: 'comment',
  approval_request: 'approval',
  approval_result: 'approval',
  reminder: 'reminder',
  later_reminder: 'reminder',
  page_update: 'updates',
  agent_digest: 'updates',
}

/** GET /api/push/key */
export interface PushKeyDTO {
  /** The server can send push (WEB_PUSH is not off and its VAPID key is usable). */
  available: boolean
  /** VAPID public key (base64url, 65-byte point) for `pushManager.subscribe`; null when unavailable. */
  publicKey: string | null
}

export interface PushDeviceDTO {
  id: string
  label: string | null
  createdAt: string
  lastSuccessAt: string | null
  lastFailureAt: string | null
  /** Failed deliveries in a row. */
  failureCount: number
  /** Registered by the session of this request (this browser). */
  current: boolean
  /** Made with an older server key: it is dropped at its next delivery and re-made when that browser opens the app. */
  stale: boolean
}

/** GET/PATCH /api/push/settings */
export interface PushSettingsDTO {
  available: boolean
  enabled: boolean
  kinds: PushKindGroup[]
  /** Lock-screen privacy: only "New notification", without who, where or what. */
  hideContent: boolean
  devices: PushDeviceDTO[]
}

export const updatePushSettingsSchema = z
  .object({
    enabled: z.boolean().optional(),
    kinds: z.array(pushKindGroupSchema).max(PUSH_KIND_GROUPS.length).optional(),
    hideContent: z.boolean().optional(),
  })
  .refine((d) => Object.values(d).some((v) => v !== undefined), { message: 'Nothing to change' })
export type UpdatePushSettingsInput = z.infer<typeof updatePushSettingsSchema>

/** POST /api/push/subscriptions: `PushSubscription.toJSON()` plus a device name. */
export const pushSubscribeSchema = z.object({
  endpoint: z.string().min(1).max(1024),
  expirationTime: z.number().nullable().optional(),
  keys: z.object({
    p256dh: z.string().min(1).max(200),
    auth: z.string().min(1).max(100),
  }),
  label: z.string().trim().max(80).optional(),
})
export type PushSubscribeInput = z.infer<typeof pushSubscribeSchema>

/** DELETE /api/push/subscriptions: this browser's subscription. */
export const pushUnsubscribeSchema = z.object({ endpoint: z.string().min(1).max(1024) })

/** POST /api/push/test: one of my devices, or all of them. */
export const pushTestSchema = z.object({ deviceId: z.uuid().optional() })

/**
 * What the service worker gets (JSON inside the encrypted message). Kept small: push services take
 * at most 4096 bytes of encrypted body.
 */
export interface PushPayload {
  v: 1
  title: string
  body: string
  /** Same-origin path to open on click ("/w/<ws>/p/<page>"), always starting with one "/". */
  url: string
  /** Notifications with the same tag replace each other (one per page or thread). */
  tag: string
  /** Notification id (null for a test). */
  id: string | null
  ts: number
}
