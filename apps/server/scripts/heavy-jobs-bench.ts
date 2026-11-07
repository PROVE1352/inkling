/**
 * Heavy-job benchmark (docs/adr/1240-*, 1241-*; KNOWN-ISSUES B-M9, B-M1). Not part of CI.
 *
 *   cd apps/server
 *   DATABASE_URL=postgres://…/scratch HEAVY_JOBS_MAX=2 npx tsx scripts/heavy-jobs-bench.ts [--label x]
 *
 * In-process: the test app (real /api routes) listening on 127.0.0.1 and plain node:http clients,
 * against a migrated SCRATCH database (creates its own user and workspace, never cleans up).
 * Data: a folder of 120 docs (40 paragraphs each) with 24 incompressible 1 MiB attachments
 * (≈ 25 MiB zip), and a ≈ 20 MiB Markdown zip for imports (60 docs + 20 × 1 MiB attachments).
 *
 *  - export4: 4 concurrent subtree zip exports, read to the end.
 *  - import4 / import8: 4 / 8 concurrent zip imports of the same archive (one shared request body).
 *  - abort20: 20 exports that the client drops after 4 MiB (inside an attachment entry); open fds,
 *    leftover temp dirs and running slots before/after.
 *
 * Per scenario: RSS max (process.memoryUsage().rss sampled every 10 ms, minus nothing — the client
 * side is in the same process, so compare runs, not absolute values), wall time of the whole burst,
 * per-request time p50/max, status codes. Runs each scenario after a warm-up export.
 * "Before" = HEAVY_JOBS_MAX=100 (no effective cap); compare with the default (2) and 1.
 */
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.DATA_DIR ||= `${process.env.TMPDIR || '/tmp'}/inkling-heavyjobs-bench-${process.pid}`

import { randomBytes } from 'node:crypto'
import { readdirSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { performance } from 'node:perf_hooks'

const arg = (name: string) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined)
const LABEL = arg('--label') ?? `max=${process.env.HEAVY_JOBS_MAX ?? 'default'}`
/** One scenario per process gives each its own RSS baseline: export4 | import4 | import8 | abort20 (default: all but import8). */
const ONLY = arg('--scenario')
const want = (name: string) => (ONLY ? ONLY === name : name !== 'import8')
const DOCS = 120
const ATTACH = 24

async function main() {
  const H = await import('../src/mcpTools/testHarness')
  const { db, closeDb } = await import('../src/db/index')
  const schema = await import('../src/db/schema')
  const { eq } = await import('drizzle-orm')
  const { blocksToStateBuffer } = await import('../src/md/convert')
  const { heavyJobStatus } = await import('../src/heavyJobs')
  const JSZip = (await import('jszip')).default

  const app = await H.buildTestApp()
  await app.listen({ port: 0, host: '127.0.0.1' })
  const port = (app.server.address() as AddressInfo).port
  const dataDir = process.env.DATA_DIR!
  await mkdir(path.join(dataDir, 'uploads'), { recursive: true })

  const owners = await Promise.all([0, 1, 2, 3].map((i) => H.makeUser(`bench${i}`)))
  const ws = await H.makeWorkspace(owners[0], owners.slice(1))
  const [folder] = await db.insert(schema.pages).values({ workspaceId: ws.id, title: 'Bench export', createdBy: owners[0].id, kind: 'folder' }).returning()
  const para = (t: string) => ({ type: 'paragraph', content: [{ type: 'text', text: t, styles: {} }] })
  for (let d = 0; d < DOCS; d++) {
    const blocks: unknown[] = [{ type: 'heading', props: { level: 2 }, content: [{ type: 'text', text: `Doc ${d}`, styles: {} }] }]
    for (let p = 0; p < 40; p++) blocks.push(para(`Paragraph ${p} of doc ${d}: ${'lorem ipsum dolor sit amet '.repeat(6)}`))
    const pg = await H.makeDocPage(ws.id, owners[0].id, `Doc ${d}`, [] as never, { parentId: folder.id })
    if (d < ATTACH) {
      const [f] = await db.insert(schema.files).values({ workspaceId: ws.id, pageId: pg.id, name: `a${d}.bin`, mime: 'image/png', size: 1 << 20, createdBy: owners[0].id }).returning()
      await writeFile(path.join(dataDir, 'uploads', f.id), randomBytes(1 << 20))
      blocks.push({ type: 'image', props: { url: `/files/${f.id}` } })
    }
    await db.update(schema.pageDocs).set({ state: blocksToStateBuffer(blocks as never) }).where(eq(schema.pageDocs.pageId, pg.id))
  }

  // Import archive: 60 docs + 20 × 1 MiB attachments (incompressible): ≈ 20 MiB upload.
  const zip = new JSZip()
  for (let d = 0; d < 60; d++) {
    const att = d < 20 ? `\n\n![a](assets/a${d}.png)\n` : ''
    zip.file(`Imported/Doc ${d}.md`, `# Doc ${d}\n\n${'Some imported text. '.repeat(200)}${att}`)
    if (d < 20) zip.file(`Imported/assets/a${d}.png`, randomBytes(1 << 20))
  }
  const importZip = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  const boundary = '----inkling-bench'
  const importBody = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="bench.zip"\r\nContent-Type: application/zip\r\n\r\n`),
    importZip,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ])

  type Res = { status: number; ms: number; bytes: number }
  const get = (user: (typeof owners)[number], abortAfter: number | null = null) =>
    new Promise<Res>((resolve) => {
      const t0 = performance.now()
      let bytes = 0
      const req = request({ host: '127.0.0.1', port, path: `/api/pages/${folder.id}/export?format=zip`, headers: { cookie: user.cookie } }, (res) => {
        res.on('data', (c: Buffer) => {
          bytes += c.length
          if (abortAfter !== null && bytes >= abortAfter) {
            req.destroy()
            resolve({ status: res.statusCode ?? 0, ms: performance.now() - t0, bytes })
          }
        })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, ms: performance.now() - t0, bytes }))
        res.on('error', () => {})
      })
      req.on('error', () => {})
      req.end()
    })
  const post = (user: (typeof owners)[number]) =>
    new Promise<Res>((resolve) => {
      const t0 = performance.now()
      let bytes = 0
      const req = request(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: `/api/workspaces/${ws.id}/import`,
          headers: { cookie: user.cookie, 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': importBody.length },
        },
        (res) => {
          res.on('data', (c: Buffer) => (bytes += c.length))
          res.on('end', () => resolve({ status: res.statusCode ?? 0, ms: performance.now() - t0, bytes }))
        },
      )
      req.end(importBody)
    })

  async function scenario(name: string, burst: () => Promise<Res[]>) {
    ;(globalThis as { gc?: () => void }).gc?.()
    await new Promise((r) => setTimeout(r, 300))
    const base = process.memoryUsage().rss
    let peak = base
    let maxRunning = 0
    const timer = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().rss)
      maxRunning = Math.max(maxRunning, heavyJobStatus().running)
    }, 10)
    const t0 = performance.now()
    const res = await burst()
    const wall = performance.now() - t0
    clearInterval(timer)
    const ms = res.map((r) => r.ms).sort((a, b) => a - b)
    const mb = (b: number) => Math.round(b / 2 ** 20)
    console.log(
      JSON.stringify({
        label: LABEL,
        scenario: name,
        rssBaseMB: mb(base),
        rssPeakMB: mb(peak),
        rssRiseMB: mb(peak - base),
        wallMs: Math.round(wall),
        p50Ms: Math.round(ms[Math.floor(ms.length / 2)]),
        maxMs: Math.round(ms[ms.length - 1]),
        statuses: res.map((r) => r.status).join(','),
        zipMB: +(res[0].bytes / 2 ** 20).toFixed(1),
        maxRunning,
      }),
    )
  }

  const warm = await get(owners[0])
  console.log(JSON.stringify({ label: LABEL, warmup: { status: warm.status, ms: Math.round(warm.ms), zipMB: +(warm.bytes / 2 ** 20).toFixed(1) } }))
  const one = await get(owners[0])
  console.log(JSON.stringify({ label: LABEL, scenario: 'export1', ms: Math.round(one.ms) }))
  if (want('export4')) await scenario('export4', () => Promise.all(owners.map((u) => get(u))))
  if (want('import4')) await scenario('import4', () => Promise.all(owners.map((u) => post(u))))
  // two per person (HEAVY_JOBS_PER_USER = 2): how the peak grows with the number of concurrent jobs
  if (want('import8')) await scenario('import8', () => Promise.all([...owners, ...owners].map((u) => post(u))))
  if (!want('abort20')) {
    await app.close().catch(() => {})
    await closeDb()
    process.exit(0)
  }

  // Aborted downloads: fds and temp dirs before/after.
  await new Promise((r) => setTimeout(r, 300))
  const fds = () => readdirSync('/dev/fd').length
  const tmp = () => readdirSync(path.join(dataDir, 'tmp')).filter((f) => f.startsWith('export-')).length
  const fd0 = fds()
  const tmp0 = tmp()
  // 4 MiB: past the rendered pages (≈ 1.2 MiB), inside an attachment entry
  for (let i = 0; i < 20; i++) await get(owners[i % 4], 4 * 2 ** 20)
  await new Promise((r) => setTimeout(r, 1000))
  console.log(JSON.stringify({ label: LABEL, scenario: 'abort20', fdBefore: fd0, fdAfter: fds(), tmpDirsLeft: tmp() - tmp0, running: heavyJobStatus().running }))

  await app.close().catch(() => {})
  await closeDb()
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
