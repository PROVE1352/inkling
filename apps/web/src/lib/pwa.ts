import { noteServiceWorkerUpdate, setUpdateTransport } from './update'

// Service worker registration + update hand-off (docs/adr/0706-*, 0993-*).
// A deploy installs the new SW in the background; it waits until this tab reloads through the
// update banner (components/UpdateBanner.tsx, store in lib/update.ts) or force mode does it, so
// a running tab never mixes old code with a new precache.
// Hand-rolled instead of `virtual:pwa-register` — that needs workbox-window, which is not a
// dependency of this package. The generated sw.js (registerType 'prompt') skips waiting on a
// {type: 'SKIP_WAITING'} message.
//
// Fixed in 0993: the old toast captured the waiting worker when it was shown and latched
// `prompted`. A second deploy before the click made that worker redundant, so "Reload" posted
// SKIP_WAITING to a dead worker — nothing happened, the toast was gone and never came back while
// the newer worker sat in `waiting`. The worker is now looked up when the user accepts, the
// signal re-arms on every new worker, and a reload always happens (unregistering as a last resort).

/** Long-lived SPA tabs never navigate, so ask the browser to look for a new sw.js hourly. */
const UPDATE_CHECK_MS = 60 * 60 * 1000
/** How long to wait for a new worker to finish installing (precache download) before giving up. */
const INSTALL_WAIT_MS = 30_000
/** How long to wait for the waiting worker to take control after SKIP_WAITING. */
const ACTIVATE_WAIT_MS = 8_000

let registration: ServiceWorkerRegistration | null = null
/** Set while this tab itself asked a worker to activate: its controllerchange is ours. */
let swapping = false
/** Another tab activated a new worker: this tab's controller already serves the new build. */
let controllerReplaced = false

const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms))

/**
 * The newest installed worker. Always asks for sw.js first: a worker that has been waiting since
 * an earlier deploy may already be outdated (two deploys before the click), and activating it
 * would only lead to another "new version" notice.
 */
async function newestWaiting(reg: ServiceWorkerRegistration, ms: number): Promise<ServiceWorker | null> {
  try {
    await reg.update()
  } catch {
    // offline / sw.js fetch failed — fall back to what is already waiting
  }
  const deadline = Date.now() + ms
  // A newer worker still installing (precache download) replaces the waiting one when done.
  while (reg.installing && Date.now() < deadline) await sleep(250)
  return reg.waiting
}

function waitForControllerChange(ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sw = navigator.serviceWorker
    const done = (ok: boolean) => {
      window.clearTimeout(timer)
      sw.removeEventListener('controllerchange', onChange)
      resolve(ok)
    }
    const onChange = () => done(true)
    const timer = window.setTimeout(() => done(false), ms)
    sw.addEventListener('controllerchange', onChange)
  })
}

/**
 * Reload into the newest build. With a controlling service worker a plain reload would be
 * answered from the old precache, so first activate the waiting (or freshly fetched) worker;
 * if none shows up, unregister so the reload goes to the network. Always ends in a reload.
 */
export async function reloadToLatest(): Promise<void> {
  const sw = 'serviceWorker' in navigator ? navigator.serviceWorker : null
  if (!sw?.controller || controllerReplaced) {
    window.location.reload()
    return
  }
  const reg = registration ?? (await sw.getRegistration('/').catch(() => undefined)) ?? null
  if (!reg) {
    window.location.reload()
    return
  }
  const worker = await newestWaiting(reg, INSTALL_WAIT_MS)
  let activated = false
  if (worker) {
    swapping = true
    const changed = waitForControllerChange(ACTIVATE_WAIT_MS)
    worker.postMessage({ type: 'SKIP_WAITING' })
    activated = await changed
  }
  if (!activated) {
    // No newer worker, or it never took over: drop the registration (it stays in use until this
    // page unloads) so the reload fetches index.html from the server. The new page registers again.
    await reg.unregister().catch(() => false)
  }
  window.location.reload()
}

/** Start downloading the new worker as soon as the server reports a new build. */
function prefetchUpdate(): void {
  const reg = registration
  if (!reg || reg.installing) return
  reg.update().catch(() => {})
}

export function initPwa(): void {
  setUpdateTransport(reloadToLatest, prefetchUpdate)
  if (!('serviceWorker' in navigator) || import.meta.env.DEV) return
  const sw = navigator.serviceWorker

  sw.addEventListener('controllerchange', () => {
    if (swapping) return // reloadToLatest reloads
    // Another tab accepted the update: this tab still runs the old build. Offer a reload rather
    // than reloading under the user (lazy chunks fall back to reloadOnceForStaleChunk).
    controllerReplaced = true
    noteServiceWorkerUpdate()
  })

  const watchInstalling = (worker: ServiceWorker | null) => {
    if (!worker) return
    const onState = () => {
      // Only when this page is controlled — the very first install has nothing to update.
      if (worker.state === 'installed' && sw.controller) noteServiceWorkerUpdate()
      if (worker.state !== 'installing') worker.removeEventListener('statechange', onState)
    }
    worker.addEventListener('statechange', onState)
    onState()
  }

  const register = () => {
    sw.register('/sw.js', { scope: '/' })
      .then((reg) => {
        registration = reg
        // An update already waiting from an earlier visit, or one the navigation's own update
        // check started before this (deferred) registration ran.
        if (reg.waiting && sw.controller) noteServiceWorkerUpdate()
        watchInstalling(reg.installing)
        reg.addEventListener('updatefound', () => watchInstalling(reg.installing))
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
