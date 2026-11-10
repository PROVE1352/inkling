import type { PushPayload } from '@inkling/shared'
import type { Locale } from '../i18n'
import { describeItem } from '../notify/mailer'
import { MAX_PLAINTEXT_BYTES } from './webPushCrypto'

/**
 * What a push shows (docs/adr/2223-*). The message is end-to-end encrypted to the browser, but the
 * notification is read on a lock screen, so it carries little:
 *  - title: who did what where — the same sentence as the instant mail subject ("Ann mentioned you in
 *    "Plan""), at most PUSH_TITLE_MAX characters;
 *  - body: the notification's own excerpt (a comment or mention line, already cut to 200 characters
 *    by the engine) shortened to PUSH_PREVIEW_MAX characters, or nothing;
 *  - url: the page path; tag: one per page (a newer push about the same page replaces the older one).
 * With "hide content" on: a fixed "New notification" text, still the page path to open.
 */

export const PUSH_TITLE_MAX = 120
export const PUSH_PREVIEW_MAX = 100
/** Our own cap on the JSON, well under what one encrypted record can carry (MAX_PLAINTEXT_BYTES). */
export const PUSH_PAYLOAD_MAX_BYTES = 2048

const TEXT: Record<Locale, { hiddenTitle: string; hiddenBody: string; testTitle: string; testBody: string }> = {
  en: {
    hiddenTitle: 'Inkling',
    hiddenBody: 'New notification',
    testTitle: 'Inkling test notification',
    testBody: 'Push notifications work on this device.',
  },
  ko: {
    hiddenTitle: 'Inkling',
    hiddenBody: '새 알림',
    testTitle: 'Inkling 테스트 알림',
    testBody: '이 기기에서 푸시 알림을 받을 수 있습니다.',
  },
}

/** Cut to `max` characters (code points), with an ellipsis when cut. */
export function clip(s: string, max: number): string {
  const t = s.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  const cps = [...t]
  return cps.length > max ? cps.slice(0, Math.max(0, max - 1)).join('') + '…' : t
}

export interface PushItem {
  id: string
  type: string
  pageId: string | null
  workspaceId: string | null
  title: string | null
  actor: string | null
  via: string | null
  excerpt: string | null
  count: number
}

/** Same-origin path of a notification (what the bell opens). */
export function itemPath(i: Pick<PushItem, 'type' | 'pageId' | 'workspaceId'>): string {
  const ok = (id: string | null) => !!id && /^[0-9a-f-]{36}$/i.test(id)
  if (ok(i.pageId) && ok(i.workspaceId)) return `/w/${i.workspaceId}/p/${i.pageId}`
  if (ok(i.workspaceId)) return `/w/${i.workspaceId}`
  return '/'
}

export function notificationPayload(i: PushItem, L: Locale, hideContent: boolean, now = Date.now()): PushPayload {
  const t = TEXT[L]
  const base = { v: 1 as const, url: itemPath(i), tag: i.pageId ? `p:${i.pageId}` : `n:${i.id}`, id: i.id, ts: now }
  if (hideContent) return { ...base, title: t.hiddenTitle, body: t.hiddenBody }
  return fit({
    ...base,
    title: clip(describeItem({ ...i, pageId: i.pageId }, L), PUSH_TITLE_MAX),
    body: i.excerpt ? clip(i.excerpt, PUSH_PREVIEW_MAX) : '',
  })
}

export function testPayload(L: Locale, now = Date.now()): PushPayload {
  const t = TEXT[L]
  return { v: 1, title: t.testTitle, body: t.testBody, url: '/', tag: 'test', id: null, ts: now }
}

/** UTF-8 size of the JSON. */
export function payloadBytes(p: PushPayload): number {
  return Buffer.byteLength(JSON.stringify(p), 'utf8')
}

/**
 * Shrink until the JSON fits PUSH_PAYLOAD_MAX_BYTES (body first, then title). Sizes are UTF-8 bytes:
 * a Korean character is 3 bytes, an escaped control character up to 6.
 */
export function fit(p: PushPayload, maxBytes = PUSH_PAYLOAD_MAX_BYTES): PushPayload {
  let out = p
  let bodyMax = [...p.body].length
  while (payloadBytes(out) > maxBytes && bodyMax > 0) {
    bodyMax = bodyMax > 8 ? Math.floor(bodyMax * 0.8) : 0
    out = { ...out, body: bodyMax > 0 ? clip(p.body, bodyMax) : '' }
  }
  let titleMax = [...p.title].length
  while (payloadBytes(out) > maxBytes && titleMax > 2) {
    titleMax = Math.max(2, Math.floor(titleMax * 0.8))
    out = { ...out, title: clip(p.title, titleMax) }
  }
  if (payloadBytes(out) > Math.min(maxBytes, MAX_PLAINTEXT_BYTES)) throw new Error('push payload does not fit')
  return out
}
