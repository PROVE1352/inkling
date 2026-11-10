// @ts-nocheck — Node test file (node:test types are not part of the web tsconfig); not bundled.
// public/push-sw.js (docs/adr/2223-*): run in a tiny service worker stand-in. The push handler shows
// the notification with the page tag, never opens anything but a same-origin path, and skips only the
// page in a focused, visible window; a click routes an open window (with an ack) or opens one.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { describe, it } from 'node:test'

const SRC = readFileSync(new URL('../../public/push-sw.js', import.meta.url), 'utf8')

function worker({ clients = [], ua = 'Mozilla/5.0 Chrome/141.0 Safari/537.36' } = {}) {
  const handlers = {}
  const shown = []
  const opened = []
  const self = {
    location: { origin: 'https://notes.example.com' },
    navigator: { userAgent: ua },
    addEventListener: (type, fn) => (handlers[type] = fn),
    registration: { showNotification: async (title, opts) => shown.push({ title, ...opts }) },
    clients: { matchAll: async () => clients, openWindow: async (u) => opened.push(u) },
  }
  vm.runInNewContext(SRC, { self, URL, setTimeout, clearTimeout, MessageChannel, atob, fetch: async () => ({ ok: false }) })
  const fire = async (type, event) => {
    let p
    handlers[type]({ ...event, waitUntil: (x) => (p = x) })
    await p
  }
  return { self, handlers, shown, opened, fire }
}

const pushEvent = (payload) => ({ data: { json: () => payload } })

describe('push-sw.js', () => {
  it('registers push, notificationclick and pushsubscriptionchange, and marks the import', () => {
    const w = worker()
    assert.deepEqual(Object.keys(w.handlers).sort(), ['notificationclick', 'push', 'pushsubscriptionchange'])
    assert.equal(w.self.__inklingPush, 1)
  })

  it('shows the notification with its tag and same-origin path; off-site or odd paths become "/"', async () => {
    const w = worker()
    await w.fire('push', pushEvent({ v: 1, title: 'Ann mentioned you', body: 'hi', url: '/w/a/p/b', tag: 'p:b', id: 'n1', ts: 5 }))
    assert.equal(w.shown[0].title, 'Ann mentioned you')
    assert.equal(w.shown[0].tag, 'p:b')
    assert.deepEqual({ ...w.shown[0].data }, { url: '/w/a/p/b', id: 'n1' })
    for (const url of ['//evil.example/x', 'https://evil.example/', 'javascript:alert(1)', '/\\evil.example', 42]) {
      await w.fire('push', pushEvent({ title: 't', url, tag: 'x' }))
      assert.equal(w.shown.at(-1).data.url, '/', String(url))
    }
    // no data at all still shows something (browsers penalise silent pushes)
    await w.fire('push', { data: null })
    assert.equal(w.shown.at(-1).title, 'Inkling')
  })

  it('skips the page in a focused, visible window (not on Safari); other pages still notify', async () => {
    const posted = []
    const here = { url: 'https://notes.example.com/w/a/p/b', focused: true, visibilityState: 'visible', postMessage: (m) => posted.push(m) }
    const w = worker({ clients: [here] })
    await w.fire('push', pushEvent({ title: 't', url: '/w/a/p/b', tag: 'p:b' }))
    assert.equal(w.shown.length, 0)
    assert.equal(posted[0].type, 'inkling:push-foreground')
    await w.fire('push', pushEvent({ title: 't', url: '/w/a/p/c', tag: 'p:c' }))
    assert.equal(w.shown.length, 1)
    const safari = worker({ clients: [here], ua: 'Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1' })
    await safari.fire('push', pushEvent({ title: 't', url: '/w/a/p/b', tag: 'p:b' }))
    assert.equal(safari.shown.length, 1)
    // a Home Screen app on iOS has no "Safari/" token in its user agent
    const homeScreen = worker({ clients: [here], ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148' })
    await homeScreen.fire('push', pushEvent({ title: 't', url: '/w/a/p/b', tag: 'p:b' }))
    assert.equal(homeScreen.shown.length, 1)
    const macSafari = worker({ clients: [here], ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15' })
    await macSafari.fire('push', pushEvent({ title: 't', url: '/w/a/p/b', tag: 'p:b' }))
    assert.equal(macSafari.shown.length, 1)
  })

  it('click: an open window routes itself (ack); without a window one is opened', async () => {
    let closed = false
    const note = { data: { url: '/w/a/p/b' }, close: () => (closed = true) }
    const win = {
      url: 'https://notes.example.com/w/a/settings',
      focused: false,
      focus: async () => win,
      postMessage: (m, [port]) => {
        assert.equal(m.type, 'inkling:open')
        assert.equal(m.url, '/w/a/p/b')
        port.postMessage('ok')
        port.close()
      },
      navigate: async () => assert.fail('navigate is the fallback only'),
    }
    const w = worker({ clients: [win] })
    await w.fire('notificationclick', { notification: note })
    assert.ok(closed)
    assert.deepEqual(w.opened, [])
    const empty = worker()
    await empty.fire('notificationclick', { notification: { data: { url: '//evil.example' }, close() {} } })
    assert.deepEqual(empty.opened, ['https://notes.example.com/'])
  })
})
