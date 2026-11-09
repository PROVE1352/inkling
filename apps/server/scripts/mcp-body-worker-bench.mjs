// B-L10, rejected variant (docs/adr/1526-*): JSON.parse on the main thread vs in a Worker (buffer
// transferred, object cloned back), same body shapes as mcp-body-bench.ts. No database.
//   cd apps/server && node scripts/mcp-body-worker-bench.mjs
import { Worker } from 'node:worker_threads'
import { createRequire } from 'node:module'
const require = createRequire(process.cwd() + '/package.json')
let sjson
try { sjson = require('secure-json-parse') } catch { sjson = null }

const MB = 1024 * 1024
function stringHeavy(bytes) {
  const para = '## 회의록\n\n- 결정: 배포는 금요일 오후 4시. "quoted" text, tabs\t and \\ slashes.\n' + 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(6) + '\n'
  const files = []
  let size = 0
  let i = 0
  while (size < bytes) {
    const md = para.repeat(Math.ceil(30000 / para.length))
    files.push({ path: `notes/day${i++}.md`, markdown: md })
    size += md.length * 1.15
  }
  return JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'import_folder', arguments: { workspaceId: 'x', folderName: 'f', files } } })
}
function objectHeavy(bytes) {
  const rows = []
  let size = 0
  while (size < bytes) {
    rows.push({ id: rows.length, name: 'row', tags: ['a', 'b'], v: { x: 1, y: 2.5, z: true } })
    size += 70
  }
  return JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_row', arguments: { properties: { rows } } } })
}

// worker: parse there, send the object back (structured clone; deserialized on the main thread)
const src = `const { parentPort } = require('node:worker_threads'); parentPort.on('message', (m) => { try { parentPort.postMessage({ ok: JSON.parse(Buffer.from(m.buf).toString('utf8')) }) } catch (e) { parentPort.postMessage({ err: String(e) }) } })`
const worker = new Worker(src, { eval: true })

function maxGapDuring(fn) {
  return new Promise((resolve) => {
    let max = 0
    let last = performance.now()
    let done = false
    const tick = () => {
      const now = performance.now()
      max = Math.max(max, now - last)
      last = now
      if (!done) setImmediate(tick)
    }
    setImmediate(tick)
    const start = performance.now()
    Promise.resolve(fn()).then(() => {
      const total = performance.now() - start
      setImmediate(() => { done = true; resolve({ max, total }) })
    })
  })
}

const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]
const results = []
for (const [shape, gen] of [['string-heavy', stringHeavy], ['object-heavy', objectHeavy]]) {
  for (const mb of [1, 4, 8, 12]) {
    const body = gen(mb * MB)
    const buf = Buffer.from(body)
    const sync = [], sec = [], wk = [], wkTotal = []
    for (let r = 0; r < 7; r++) {
      let t = performance.now(); JSON.parse(body); sync.push(performance.now() - t)
      if (sjson) { t = performance.now(); sjson.parse(body); sec.push(performance.now() - t) }
      // Buffer -> string conversion is part of the sync path too (fastify reads the body as a string)
      const g = await maxGapDuring(() => new Promise((res) => {
        worker.once('message', () => res())
        const copy = new Uint8Array(buf) // copy so the transfer does not detach our buffer
        worker.postMessage({ buf: copy }, [copy.buffer])
      }))
      wk.push(g.max); wkTotal.push(g.total)
    }
    const row = { shape, MB: +(buf.length / MB).toFixed(1), jsonParseMs: +med(sync).toFixed(1), secureJsonParseMs: sjson ? +med(sec).toFixed(1) : null, workerMaxBlockMs: +med(wk).toFixed(1), workerTotalMs: +med(wkTotal).toFixed(1) }
    results.push(row)
    console.log(JSON.stringify(row))
  }
}
await worker.terminate()
