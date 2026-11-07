// Security Probe — TEST ONLY. Each command attempts something a malicious plugin might try and
// reports the outcome with ui.notice (and console). Expected result for every probe: blocked.
// See docs/PLUGINS.md "Threat checklist" for what each probe verifies.
/* global inkling */

const results = []
// Compact output (notices are capped at 300 characters): "name:ok" means BLOCKED (good),
// "name:OPEN" means the probe got through. Details go to the frame console.
const log = (name, blocked, detail) => {
  results.push(`${name}:${blocked ? 'ok' : 'OPEN'}`)
  console.log(`[security-probe] ${name}: ${blocked ? 'blocked' : 'NOT BLOCKED'} (${detail})`)
}
const attempt = async (name, fn) => {
  try {
    const v = await fn()
    log(name, false, String(v).slice(0, 60))
  } catch (e) {
    log(name, true, e && e.name ? e.name : 'error')
  }
}

inkling.commands.register('escape', async () => {
  results.length = 0
  await attempt('parentDOM', () => window.parent.document.title)
  await attempt('topDOM', () => window.top.document.cookie)
  await attempt('cookie', () => {
    document.cookie = 'probe=1'
    if (document.cookie === '') throw new Error('empty')
    return document.cookie
  })
  await attempt('localStorage', () => window.localStorage.getItem('x'))
  await attempt('fetchApi', () => fetch('/api/auth/me').then((r) => r.status))
  await attempt('fetchExt', () => fetch('https://example.com/').then((r) => r.status))
  await attempt('xhr', () => {
    const x = new XMLHttpRequest()
    x.open('GET', '/api/auth/me', false)
    x.send()
    return x.status
  })
  await attempt('ws', () => new Promise((res, rej) => {
    const ws = new WebSocket(`wss://example.com/`)
    ws.onopen = () => res('open')
    ws.onerror = () => rej(new Error('ws error'))
    setTimeout(() => rej(new Error('timeout')), 3000)
  }))
  await attempt('injectScript', () => new Promise((res, rej) => {
    const s = document.createElement('script')
    s.src = 'data:text/javascript,window.__probe=1'
    s.onload = () => (window.__probe ? res('ran') : rej(new Error('not run')))
    s.onerror = () => rej(new Error('refused'))
    document.head.appendChild(s)
  }))
  await attempt('eval', () => eval('1+1'))
  await attempt('popup', () => {
    const w = window.open('https://example.com/')
    if (!w) throw new Error('null')
    return 'opened'
  })
  await attempt('imgBeacon', () => new Promise((res, rej) => {
    const i = new Image()
    i.onload = () => res('loaded')
    i.onerror = () => rej(new Error('refused'))
    i.src = 'https://example.com/favicon.ico'
  }))
  await inkling.ui.notice(results.join(' '))
})

inkling.commands.register('write', async (ctx) => {
  try {
    await inkling.pages.update(ctx.pageId || '00000000-0000-0000-0000-000000000000', 'pwned')
    await inkling.ui.notice('pages.update: NOT BLOCKED')
  } catch (e) {
    await inkling.ui.notice(`pages.update: blocked (${e.code || e.message})`)
  }
})

inkling.commands.register('flood', () => {
  // Bypass the SDK: talk to the port directly is not possible from here, so flood via the SDK.
  for (let i = 0; i < 20000; i++) inkling.ui.notice('spam').catch(() => {})
})

inkling.commands.register('huge', () => {
  const big = 'x'.repeat(2 * 1024 * 1024)
  for (let i = 0; i < 5; i++) inkling.ui.notice(big).catch(() => {})
})

inkling.commands.register('loop', () => {
  // Busy loop: the parent stops getting pongs and removes the frame (if the browser runs the
  // sandboxed frame out of process; otherwise the whole tab stalls — see docs).
  for (;;) {
    /* spin */
  }
})

inkling.commands.register('navigate', () => {
  window.location.href = 'about:blank#probe'
})
