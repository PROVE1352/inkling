// Vault sync readiness R14 (Z-3, 0.17): a large vault syncs without errors, and an unchanged re-run
// does nothing beyond reading the change feed. Times are printed (`[R14] …`), not asserted.
//   VSYNC_SCALE_N        number of notes / pages (default 100; the readiness report used 1000)
//   VSYNC_SCALE_LIMITER  1 (default) = the rate limiter registered as index.ts does (global 300/min,
//                        the sync routes' own limits, the CLI waits on 429); 0 = no limiter
// Run: cd apps/server && DATABASE_URL=postgres://… VSYNC_SCALE_N=1000 node ../../scripts/run-tests.mjs --db
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.DATA_DIR ||= `${process.env.TMPDIR || '/tmp'}/inkling-vscale-${process.pid}`

import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { after, before, describe, it } from 'node:test'

const HAS_DB = !!process.env.DATABASE_URL
const N = Number(process.env.VSYNC_SCALE_N || 100)
const LIMITER = process.env.VSYNC_SCALE_LIMITER !== '0'
mkdirSync(path.join(process.env.DATA_DIR!, 'uploads'), { recursive: true })

describe(`[db] vault sync readiness: ${N} notes (R14)`, { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const h = await import('../mcpTools/testHarness')
  const kit = await import('./vaultSyncTestKit')
  const { closeDb, db } = await import('../db/index')
  const schema = await import('../db/schema')
  const { and, eq, isNull } = await import('drizzle-orm')
  const collab = await import('../collab')

  const s = await kit.buildSyncApp({ rateLimit: LIMITER })
  type U = Awaited<ReturnType<typeof h.makeUser>>
  let alice: U
  let home: string
  const scratch: string[] = []
  before(async () => {
    alice = await h.makeUser('Alice')
    home = await mkdtemp(path.join(tmpdir(), 'inkling-vscale-home-'))
    scratch.push(home)
  })
  after(async () => {
    await collab.destroyCollab()
    await s.close()
    await closeDb()
    for (const d of scratch) await rm(d, { recursive: true, force: true })
  })

  const para = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text, styles: {} }] })
  const heading = (text: string) => ({ type: 'heading', props: { level: 2 }, content: [{ type: 'text', text, styles: {} }] })
  async function timed(ws: string, vault: string) {
    const start = s.seen.length
    const t0 = performance.now()
    const r = await kit.runSync(s, vault, { workspaceId: ws, auth: alice.cookie, home })
    const ms = performance.now() - t0
    assert.equal(r.code, 0, r.out.slice(-2000))
    const reqs = s.seen.slice(start)
    return { ms, out: r.out, requests: reqs.length, retried429: (r.out.match(/rate limited/g) ?? []).length, reqs }
  }
  async function countNotes(dir: string): Promise<number> {
    let n = 0
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue
      if (e.isDirectory()) n += await countNotes(path.join(dir, e.name))
      else if (e.name.endsWith('.md')) n++
    }
    return n
  }
  const report = (what: string, r: { ms: number; requests: number; retried429: number }) =>
    console.log(`[R14] ${what}: N=${N} limiter=${LIMITER ? 'on' : 'off'} ${(r.ms / 1000).toFixed(1)} s, ${r.requests} requests, ${r.retried429} rate-limit waits`)

  it('vault → server: first sync of N new notes, then an unchanged re-run', async () => {
    const ws = (await h.makeWorkspace(alice)).id
    const vault = await mkdtemp(path.join(tmpdir(), 'inkling-vscale-vault-'))
    scratch.push(vault)
    for (let i = 0; i < N; i++) {
      const dir = path.join(vault, `Folder ${i % 10}`)
      await mkdir(dir, { recursive: true })
      // every tenth note links to another one (the two-phase create path)
      const link = i % 10 === 0 ? `\n\nsee [[Note ${(i + 1) % N}]]` : ''
      await writeFile(path.join(dir, `Note ${i}.md`), `# Note ${i}\n\nbody of note ${i}, ${'lorem ipsum '.repeat(20)}${link}\n\n* one\n* two\n`)
    }
    const first = await timed(ws, vault)
    report('vault → server, first sync', first)
    const pages = await db.select({ id: schema.pages.id }).from(schema.pages).where(and(eq(schema.pages.workspaceId, ws), isNull(schema.pages.deletedAt), eq(schema.pages.kind, 'doc')))
    assert.equal(pages.length, N, 'one page per note')
    const again = await timed(ws, vault)
    report('vault → server, unchanged re-run', again)
    assert.match(again.out, /sync done: nothing to do/)
    assert.deepEqual(again.reqs.map((r) => `${r.method} ${r.url.replace(/[0-9a-f-]{36}/g, ':id')}`), ['GET /api/workspaces', 'GET /api/workspaces/:id/sync/changes'], 'the re-run only reads the change feed')
  })

  it('server → vault: first sync of N existing pages, then an unchanged re-run', async () => {
    const ws = (await h.makeWorkspace(alice)).id
    const folders: string[] = []
    for (let f = 0; f < 10; f++) {
      const [row] = await db.insert(schema.pages).values({ workspaceId: ws, title: `Server folder ${f}`, kind: 'folder', createdBy: alice.id }).returning()
      folders.push(row.id)
    }
    for (let i = 0; i < N; i++) {
      await h.makeDocPage(ws, alice.id, `Page ${i}`, [heading('Intro'), para(`page ${i} ${'dolor sit amet '.repeat(20)}`)] as never, { parentId: folders[i % 10] })
    }
    const vault = await mkdtemp(path.join(tmpdir(), 'inkling-vscale-vault-'))
    scratch.push(vault)
    const first = await timed(ws, vault)
    report('server → vault, first sync', first)
    assert.equal(await countNotes(vault), N)
    const again = await timed(ws, vault)
    report('server → vault, unchanged re-run', again)
    assert.match(again.out, /sync done: nothing to do/)
    assert.equal(again.requests, 2, 'the re-run only reads the change feed')
  })
})
