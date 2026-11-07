// Test harness (Plugin API sandbox check). Not part of the app bundle — see run.sh.
// Needs security-probe (apps/server/src/plugins/fixtures) and progress-bar (examples/plugins) in PLUGINS_DIR.
// Drives REAL sandboxed plugin frames from the server with the
// REAL parent broker (esbuild bundle of apps/web/src/plugins/broker.ts). Mirrors host.ts wiring.
window.__results = {}
window.__done = false
const out = document.getElementById('out')
const put = (k, v) => { window.__results[k] = v; out.textContent = JSON.stringify(window.__results, null, 1) }

function runFrame(name, plugin, opts) {
  return new Promise((resolve) => {
    const notices = []
    let killed = null, loads = 0, port = null, lastPong = Date.now(), n = 0, hb = null, done = false
    const iframe = document.createElement('iframe')
    iframe.setAttribute('sandbox', 'allow-scripts')
    iframe.src = plugin.frameUrl
    const broker = new PB.PluginBroker({
      pluginId: plugin.id, permissions: plugin.permissions, mode: opts.mode || 'worker',
      declaredCommands: plugin.commands.map((c) => c.id), declaredBlocks: plugin.blocks.map((b) => b.type),
      blockType: opts.blockType,
      handlers: {
        'ui.notice': ({ message }) => { notices.push(message); if (opts.untilNotice) finish(); return { ok: true } },
        'pages.update': () => { notices.push('HANDLER-RAN-pages.update'); return { ok: true } },
        'block.resize': ({ height }) => { notices.push('resize:' + height); if (opts.untilResize) finish(); return { ok: true } },
      },
      post: (m) => port && port.postMessage(m),
      kill: (r) => { killed = r; finish() },
      onPong: () => { lastPong = Date.now() },
      onCommandRegistered: (id) => {
        if (id === opts.command) setTimeout(() => port.postMessage(JSON.stringify({ event: 'command', commandId: id, context: { workspaceId: null, pageId: null } })), 50)
      },
    })
    iframe.addEventListener('load', () => {
      loads++
      if (loads > 1) { killed = 'navigated'; finish(); return }
      const ch = new MessageChannel()
      port = ch.port1
      port.onmessage = (e) => broker.receive(e.data)
      iframe.contentWindow.postMessage('inkling-plugin-init:v1', '*', [ch.port2])
      port.postMessage(JSON.stringify({ event: 'init', context: { pluginId: plugin.id, mode: opts.mode || 'worker', theme: 'light', blockType: opts.blockType || null, data: opts.data || null, editable: true } }))
      hb = setInterval(() => {
        if (Date.now() - lastPong > 12000) { killed = 'unresponsive'; finish(); return }
        port.postMessage(JSON.stringify({ event: 'ping', n: ++n }))
      }, 4000)
    })
    const t = setTimeout(() => finish(), opts.timeout || 15000)
    document.body.insertBefore(iframe, document.body.firstChild)
    function finish() {
      if (done) return
      done = true
      clearTimeout(t); if (hb) clearInterval(hb); broker.close(); iframe.remove()
      resolve({ notices: notices.slice(0, 3).map((s) => s.slice(0, 1500)), noticeCount: notices.length, killed, stats: broker.stats })
    }
  })
}

;(async () => {
  try {
    document.cookie = 'parentsecret=topsecret; path=/'
    localStorage.setItem('parentls', 'x')
    window.PARENT_SECRET = 'p4rent'
    const login = await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@example.com', password: 'password123' }) })
    put('login', login.status)
    const plugins = (await (await fetch('/api/plugins')).json()).plugins
    const P = Object.fromEntries(plugins.map((p) => [p.id, p]))
    put('active', Object.keys(P))
    const probe = P['security-probe']
    put('escape', await runFrame('escape', probe, { command: 'escape', untilNotice: true }))
    put('write', await runFrame('write', probe, { command: 'write', untilNotice: true }))
    put('huge', await runFrame('huge', probe, { command: 'huge' }))
    put('flood', await runFrame('flood', probe, { command: 'flood' }))
    put('navigate', await runFrame('navigate', probe, { command: 'navigate' }))
    put('block', await runFrame('block', P['progress-bar'], { mode: 'block', blockType: 'progress', data: { label: 'Build', value: 40, max: 100 }, untilResize: true }))
    const t0 = Date.now()
    put('loop', Object.assign(await runFrame('loop', probe, { command: 'loop', timeout: 30000 }), { ms: Date.now() - t0 }))
    put('parentStillResponsive', true)
  } catch (e) {
    put('error', String(e && e.stack || e))
  }
  window.__done = true
})()
