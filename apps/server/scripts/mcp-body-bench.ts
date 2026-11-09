/**
 * B-L10 bench (docs/adr/1526-*): longest event-loop stall while Fastify takes a POST body, default
 * JSON parser (before) vs the /mcp parser with the value cap (after), for string-heavy
 * (import_folder-like) and value-heavy bodies of 1–12 MB. No database.
 *   cd apps/server && npx tsx scripts/mcp-body-bench.ts
 */
import { monitorEventLoopDelay } from 'node:perf_hooks'
import Fastify from 'fastify'
import { registerMcpJsonParser } from '../src/mcpBody'

const MB = 1024 * 1024
function stringHeavy(bytes: number): string {
  const para = '## 회의록\n\n- 결정: 배포는 금요일 오후 4시. "quoted" text, tabs\t and \\ slashes.\n' + 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(6) + '\n'
  const files: { path: string; markdown: string }[] = []
  let size = 0
  while (size < bytes) {
    const md = para.repeat(Math.ceil(30000 / para.length))
    files.push({ path: `notes/day${files.length}.md`, markdown: md })
    size += md.length * 1.15
  }
  return JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'import_folder', arguments: { files } } })
}
function valueHeavy(bytes: number): string {
  const rows: unknown[] = []
  let size = 0
  while (size < bytes) {
    rows.push({ id: rows.length, name: 'row', tags: ['a', 'b'], v: { x: 1, y: 2.5, z: true } })
    size += 70
  }
  return JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_row', arguments: { properties: { rows } } } })
}

async function build(capped: boolean) {
  const app = Fastify()
  await app.register(async (s) => {
    if (capped) registerMcpJsonParser(s)
    s.post('/mcp', { bodyLimit: 13 * MB }, async () => ({ ok: true }))
  })
  await app.ready()
  return app
}

/** Longest event-loop delay (monitorEventLoopDelay, 1 ms resolution) and the wall time of one request. */
async function maxStall(fn: () => Promise<unknown>): Promise<{ stall: number; wall: number; status: number }> {
  const h = monitorEventLoopDelay({ resolution: 1 })
  h.enable()
  await new Promise((r) => setTimeout(r, 5))
  const t = performance.now()
  const r = (await fn()) as { statusCode: number }
  const wall = performance.now() - t
  await new Promise((r) => setTimeout(r, 5))
  h.disable()
  return { stall: h.max / 1e6, wall, status: r.statusCode }
}

const med = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]
const before = await build(false)
const after = await build(true)
for (const [shape, gen] of [['string-heavy', stringHeavy], ['value-heavy', valueHeavy]] as const) {
  for (const mb of [1, 4, 8, 12]) {
    const payload = gen(mb * MB)
    const row: Record<string, unknown> = { shape, MB: +(Buffer.byteLength(payload) / MB).toFixed(1) }
    for (const [name, app] of [['before', before], ['after', after]] as const) {
      const stalls: number[] = []
      const walls: number[] = []
      let status = 0
      for (let i = 0; i < 7; i++) {
        const r = await maxStall(() => app.inject({ method: 'POST', url: '/mcp', headers: { 'content-type': 'application/json' }, payload }))
        stalls.push(r.stall)
        walls.push(r.wall)
        status = r.status
      }
      row[`${name}StallMs`] = +med(stalls).toFixed(1)
      row[`${name}WallMs`] = +med(walls).toFixed(1)
      row[`${name}Status`] = status
    }
    console.log(JSON.stringify(row))
  }
}
await before.close()
await after.close()
