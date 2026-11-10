import type { PushKeyDTO } from '@inkling/shared'
import { api, OfflineError } from '../api'

// Web push on this device (docs/adr/2220-* .. 2223-*). The service worker handlers live in
// public/push-sw.js; this module asks for permission (only from a click in Settings), subscribes,
// registers the subscription with the server, and re-syncs it on app start without asking anything.

export type PushDeviceState =
  /** No service worker, PushManager or Notification API (old browser, insecure origin). */
  | 'unsupported'
  /** iPhone/iPad in a Safari tab: push needs the app added to the Home Screen (iOS 16.4+). */
  | 'ios-home'
  /** The service worker is not registered (development build, or it failed to install). */
  | 'no-worker'
  /** The server cannot push (WEB_PUSH=off or its key is unusable). */
  | 'server-off'
  /** The person blocked notifications for this site in the browser. */
  | 'denied'
  /** No connection to the server right now (docs/adr/2321-*): nothing can be checked or changed. */
  | 'offline'
  | 'off'
  | 'on'

// Per-browser memory of "this account turned push on here", so a new sign-in of the same account
// re-registers the subscription by itself and another account on a shared browser never does.
const FLAG = 'inkling.push.user'

function readFlag(): string | null {
  try {
    return localStorage.getItem(FLAG)
  } catch {
    return null
  }
}

function writeFlag(userId: string | null): void {
  try {
    if (userId) localStorage.setItem(FLAG, userId)
    else localStorage.removeItem(FLAG)
  } catch {
    // private window: the app simply does not re-register by itself
  }
}

export function isIos(): boolean {
  const ua = navigator.userAgent
  // iPadOS reports a Mac user agent; touch points tell them apart
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
}

export function isStandalone(): boolean {
  return (
    window.matchMedia?.('(display-mode: standalone)').matches === true ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  )
}

export function pushSupported(): boolean {
  return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
}

async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null
  // getRegistration, not `ready`: `ready` never settles when no worker is registered (dev builds).
  const reg = await navigator.serviceWorker.getRegistration('/').catch(() => undefined)
  return reg ?? null
}

export function keyBytes(b64u: string): Uint8Array<ArrayBuffer> {
  const s = b64u.replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(s + '==='.slice((s.length + 3) % 4))
  const out = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

function sameKey(sub: PushSubscription, key: Uint8Array): boolean {
  const k = sub.options?.applicationServerKey
  if (!k) return false
  const a = new Uint8Array(k)
  return a.length === key.length && a.every((v, i) => v === key[i])
}

function serverKey(): Promise<PushKeyDTO> {
  return api<PushKeyDTO>('/api/push/key')
}

/** The state of this browser, from the browser alone plus the server key (no prompt). */
export async function deviceState(): Promise<{ state: PushDeviceState; endpoint: string | null }> {
  if (!pushSupported()) return { state: isIos() && !isStandalone() ? 'ios-home' : 'unsupported', endpoint: null }
  if (isIos() && !isStandalone()) return { state: 'ios-home', endpoint: null }
  let offlineNow = false
  const key = await serverKey().catch((err: unknown) => {
    offlineNow = err instanceof OfflineError
    return null
  })
  if (offlineNow) return { state: 'offline', endpoint: null }
  if (!key?.available) return { state: 'server-off', endpoint: null }
  if (Notification.permission === 'denied') return { state: 'denied', endpoint: null }
  const reg = await registration()
  if (!reg) return { state: 'no-worker', endpoint: null }
  const sub = await reg.pushManager.getSubscription().catch(() => null)
  if (!sub || Notification.permission !== 'granted') return { state: 'off', endpoint: null }
  return { state: 'on', endpoint: sub.endpoint }
}

async function register(sub: PushSubscription): Promise<void> {
  const json = sub.toJSON() as { endpoint?: string; expirationTime?: number | null; keys?: Record<string, string> }
  await api('/api/push/subscriptions', {
    method: 'POST',
    body: JSON.stringify({ endpoint: json.endpoint, expirationTime: json.expirationTime ?? null, keys: json.keys }),
  })
}

/** Subscribe with the server key (replacing a subscription made with another key). */
async function subscribe(reg: ServiceWorkerRegistration, key: Uint8Array<ArrayBuffer>): Promise<PushSubscription> {
  const cur = await reg.pushManager.getSubscription()
  if (cur && sameKey(cur, key)) return cur
  if (cur) await cur.unsubscribe().catch(() => false)
  return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })
}

/**
 * Turn push on for this browser. Call it ONLY from a click: it asks for notification permission.
 * Returns the resulting state.
 */
export async function enablePush(userId: string): Promise<PushDeviceState> {
  if (!pushSupported()) return isIos() && !isStandalone() ? 'ios-home' : 'unsupported'
  const key = await serverKey()
  if (!key.available || !key.publicKey) return 'server-off'
  const perm = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission()
  if (perm !== 'granted') return perm === 'denied' ? 'denied' : 'off'
  const reg = await registration()
  if (!reg) return 'no-worker'
  const sub = await subscribe(reg, keyBytes(key.publicKey))
  await register(sub)
  writeFlag(userId)
  return 'on'
}

/**
 * Logging out without reaching the server (offline, a failed request): the session and its push rows
 * stay on the server, so this device would keep receiving pushes. Drop the browser's subscription
 * here; the server removes its row at the next delivery (404/410). The per-browser marker stays, so
 * the same person's next sign-in subscribes again by itself (`syncPush`, docs/adr/2221-*). Never throws,
 * and gives up after two seconds so logging out cannot hang on it.
 */
export async function dropPushSubscriptionHere(): Promise<void> {
  if (!pushSupported()) return
  const work = (async () => {
    const reg = await registration()
    const sub = await reg?.pushManager.getSubscription().catch(() => null)
    if (sub) await sub.unsubscribe().catch(() => false)
  })().catch(() => undefined)
  await Promise.race([work, new Promise<void>((r) => setTimeout(r, 2000))])
}

/** Turn push off for this browser (the server forgets it too). */
export async function disablePush(): Promise<void> {
  writeFlag(null)
  const reg = await registration()
  const sub = await reg?.pushManager.getSubscription().catch(() => null)
  if (!sub) return
  await api('/api/push/subscriptions', { method: 'DELETE', body: JSON.stringify({ endpoint: sub.endpoint }) }).catch(() => undefined)
  await sub.unsubscribe().catch(() => false)
}

/**
 * On app start (signed in): when this account turned push on in this browser before, make sure the
 * server knows the current subscription — bound to the current session (a new sign-in after logout or
 * session expiry), and made with the current server key (a key change). Never asks for permission.
 */
export async function syncPush(userId: string): Promise<void> {
  if (!pushSupported() || readFlag() !== userId || Notification.permission !== 'granted') return
  const reg = await registration()
  if (!reg) return
  const key = await serverKey().catch(() => null)
  if (!key?.available || !key.publicKey) return
  const sub = await subscribe(reg, keyBytes(key.publicKey))
  await register(sub)
}
