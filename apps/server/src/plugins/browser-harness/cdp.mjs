// CDP poller for the plugin sandbox harness: opens index.html in headless Chrome (port 9613)
// and prints window.__results once the harness sets window.__done.
const list = await (await fetch(`http://localhost:9613/json/new?http://localhost:${process.env.PORT || 3613}/index.html`, { method: 'PUT' })).json()
const ws = new WebSocket(list.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
await new Promise((r) => (ws.onopen = r))
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })
const deadline = Date.now() + 150000
let last = ''
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 2000))
  const res = await Promise.race([send('Runtime.evaluate', { expression: 'JSON.stringify({done: window.__done, r: window.__results})', returnByValue: true }), new Promise((r) => setTimeout(() => r(null), 5000))])
  if (!res) { console.log('[parent page did not answer within 5s at', new Date().toISOString(), ']'); continue }
  last = res.result?.result?.value ?? JSON.stringify(res)
  if (JSON.parse(last).done) break
}
console.log(JSON.stringify(JSON.parse(last), null, 1))
process.exit(0)
