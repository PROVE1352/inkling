// Imported by the generated service worker (vite.config.ts workbox.importScripts).
// Web push handlers go here: 'push' and 'notificationclick'. Plain script, no imports, no build step.
//
// Web push (docs/adr/2220-* .. 2223-*):
//  - push:                    show the notification the server sent (JSON: title, body, url, tag, id).
//                             One tag per page, so a newer push about the same page replaces the older
//                             one. Skipped only when a focused, visible window already shows that page
//                             (not on Safari, which revokes subscriptions whose pushes show nothing).
//  - notificationclick:       focus an open Inkling window and let the app route to the page (it acks
//                             over a MessageChannel); without an ack, navigate that window; without a
//                             window, open one.
//  - pushsubscriptionchange:  the browser renewed or dropped the subscription: subscribe again with the
//                             server key and register it, then forget the old endpoint.
/* eslint-disable no-restricted-globals */
;(() => {
  const ICON = '/icons/icon-192.png'
  // marker: the generated worker imported this file (checked by the browser test)
  self.__inklingPush = 1

  /** Only same-origin paths that start with one "/" (never "//host" or a scheme). */
  function safePath(p) {
    if (typeof p !== 'string' || p.length > 512 || p.charAt(0) !== '/' || p.charAt(1) === '/' || p.charAt(1) === '\\') return '/'
    try {
      const u = new URL(p, self.location.origin)
      return u.origin === self.location.origin ? u.pathname + u.search + u.hash : '/'
    } catch (_e) {
      return '/'
    }
  }

  function str(v, max) {
    return typeof v === 'string' ? v.slice(0, max) : ''
  }

  function isSafari() {
    const ua = (self.navigator && self.navigator.userAgent) || ''
    return /Safari\//.test(ua) && !/(Chrome|Chromium|CriOS|Edg|Firefox|FxiOS|OPR)\//.test(ua)
  }

  function pathOf(clientUrl) {
    try {
      return new URL(clientUrl).pathname
    } catch (_e) {
      return ''
    }
  }

  self.addEventListener('push', (event) => {
    event.waitUntil(
      (async () => {
        let p = null
        try {
          p = event.data ? event.data.json() : null
        } catch (_e) {
          p = null
        }
        if (!p || typeof p !== 'object') p = {}
        const url = safePath(p.url)
        const title = str(p.title, 200) || 'Inkling'
        const tag = str(p.tag, 100) || 'inkling'
        // The person is looking at that very page: the app shows it live, no second ping.
        if (!isSafari()) {
          const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
          const here = wins.find((c) => c.visibilityState === 'visible' && c.focused && pathOf(c.url) === url.split(/[?#]/)[0])
          if (here) {
            here.postMessage({ type: 'inkling:push-foreground', url, id: p.id || null })
            return
          }
        }
        await self.registration.showNotification(title, {
          body: str(p.body, 300),
          tag,
          renotify: tag !== 'inkling',
          icon: ICON,
          badge: ICON,
          timestamp: typeof p.ts === 'number' ? p.ts : Date.now(),
          data: { url, id: typeof p.id === 'string' ? p.id : null },
        })
      })(),
    )
  })

  /** Ask an open window to route itself (SPA navigation); resolves true when the app answered. */
  function askToOpen(client, url) {
    return new Promise((resolve) => {
      let done = false
      const ch = new MessageChannel()
      const finish = (ok) => {
        if (done) return
        done = true
        clearTimeout(timer)
        ch.port1.close()
        resolve(ok)
      }
      const timer = setTimeout(() => finish(false), 1000)
      ch.port1.onmessage = () => finish(true)
      try {
        client.postMessage({ type: 'inkling:open', url }, [ch.port2])
      } catch (_e) {
        finish(false)
      }
    })
  }

  self.addEventListener('notificationclick', (event) => {
    event.notification.close()
    const data = event.notification.data || {}
    const url = safePath(data.url)
    const target = new URL(url, self.location.origin).href
    event.waitUntil(
      (async () => {
        const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
        const mine = wins.filter((c) => {
          try {
            return new URL(c.url).origin === self.location.origin
          } catch (_e) {
            return false
          }
        })
        const exact = mine.find((c) => c.url === target)
        if (exact) {
          await exact.focus()
          return
        }
        const win = mine.find((c) => c.focused) || mine[0]
        if (win) {
          try {
            await win.focus()
          } catch (_e) {
            // focus can be refused without a user gesture; the window still routes
          }
          if (await askToOpen(win, url)) return
          try {
            if (await win.navigate(target)) return
          } catch (_e) {
            // an uncontrolled window cannot be navigated from here
          }
        }
        await self.clients.openWindow(target)
      })(),
    )
  })

  function keyBytes(b64u) {
    const s = b64u.replace(/-/g, '+').replace(/_/g, '/')
    const raw = atob(s + '==='.slice((s.length + 3) % 4))
    const out = new Uint8Array(raw.length)
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
    return out
  }

  async function post(method, path, body) {
    return fetch(path, {
      method,
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  self.addEventListener('pushsubscriptionchange', (event) => {
    event.waitUntil(
      (async () => {
        const old = event.oldSubscription || null
        let sub = event.newSubscription || null
        if (!sub) {
          const res = await fetch('/api/push/key', { credentials: 'same-origin' })
          if (!res.ok) return
          const k = await res.json()
          if (!k || !k.available || !k.publicKey) return
          sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(k.publicKey) })
        }
        const r = await post('POST', '/api/push/subscriptions', sub.toJSON())
        if (r.ok && old && old.endpoint && old.endpoint !== sub.endpoint) await post('DELETE', '/api/push/subscriptions', { endpoint: old.endpoint })
      })().catch(() => undefined),
    )
  })
})()
