import { t } from '../i18n'
import { toast } from './toast'

// Service worker registration + "new version" prompt (docs/adr/0706-*).
// A deploy installs the new SW in the background; it waits until the user reloads through the
// toast (or closes every tab), so a running tab never mixes old code with a new precache.
// Hand-rolled instead of `virtual:pwa-register` — that needs workbox-window, which is not a
// dependency of this package. The generated sw.js (registerType 'prompt') skips waiting on a
// {type: 'SKIP_WAITING'} message.

// Getters, not values: t() must run when the toast is shown, not at import time.
const S = {
  get updateReady() {
    return t('pwa.updateReady')
  },
  get updated() {
    return t('pwa.updated')
  },
  get reload() {
    return t('pwa.reload')
  },
}

/** Long-lived SPA tabs never navigate, so ask the browser to look for a new sw.js hourly. */
const UPDATE_CHECK_MS = 60 * 60 * 1000

export function initPwa(): void {
  if (!('serviceWorker' in navigator) || import.meta.env.DEV) return
  const sw = navigator.serviceWorker
  let prompted = false
  let accepted = false

  const promptUpdate = (waiting: ServiceWorker) => {
    if (prompted) return
    prompted = true
    toast({
      message: S.updateReady,
      actionLabel: S.reload,
      onAction: () => {
        accepted = true
        waiting.postMessage({ type: 'SKIP_WAITING' })
      },
      duration: 0,
    })
  }

  sw.addEventListener('controllerchange', () => {
    if (accepted) {
      window.location.reload()
      return
    }
    // Another tab accepted the update: this tab still runs the old build. Offer a reload
    // rather than reloading under the user (lazy chunks fall back to reloadOnceForStaleChunk).
    if (!prompted) {
      prompted = true
      toast({ message: S.updated, actionLabel: S.reload, onAction: () => window.location.reload(), duration: 0 })
    }
  })

  const register = () => {
    sw.register('/sw.js', { scope: '/' })
      .then((reg) => {
        // An update already waiting from an earlier visit (only when this page is controlled —
        // the very first install has nothing to update).
        if (reg.waiting && sw.controller) promptUpdate(reg.waiting)
        reg.addEventListener('updatefound', () => {
          const installing = reg.installing
          installing?.addEventListener('statechange', () => {
            if (installing.state === 'installed' && sw.controller) promptUpdate(installing)
          })
        })
        window.setInterval(() => {
          if (document.visibilityState === 'visible' && navigator.onLine) {
            reg.update().catch(() => {})
          }
        }, UPDATE_CHECK_MS)
      })
      .catch(() => {
        // registration failure (private mode, blocked) — the app works without a SW
      })
  }
  // Register after load so the SW install (precache download) does not compete with first paint.
  if (document.readyState === 'complete') register()
  else window.addEventListener('load', register, { once: true })
}

// A lazy chunk of the build this tab was loaded from can disappear after a deploy (no SW, or
// the SW was replaced elsewhere). Reload once to pick up the new build instead of a blank route.
const RELOAD_KEY = 'inkling:chunk-reload'

export function reloadOnceForStaleChunk(err: unknown): never {
  let last = 0
  try {
    last = Number(sessionStorage.getItem(RELOAD_KEY) ?? 0)
  } catch {
    // storage unavailable — fall through and rethrow
  }
  if (Date.now() - last > 60_000) {
    try {
      sessionStorage.setItem(RELOAD_KEY, String(Date.now()))
    } catch {
      // ignore
    }
    window.location.reload()
  }
  throw err
}
