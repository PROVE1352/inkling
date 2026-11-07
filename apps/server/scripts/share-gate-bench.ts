/**
 * Public link gate benchmark (docs/adr/1170-*, 1171-*). Not part of CI.
 *
 *   cd apps/server
 *   cp <old routes/public.ts> src/routes/publicBefore.bench.ts   # verbatim copy from before the change; delete afterwards
 *   DATABASE_URL=postgres://…/scratch npx tsx scripts/share-gate-bench.ts
 *
 * In-process: two Fastify apps on the same database, one with the public routes before the change
 * (`publicBefore.bench.ts`, a verbatim copy of the old routes/public.ts) and one with the current
 * routes. Requests through `app.inject` (no network, no rate limiter), sequential, render caches
 * warm. Seed: one doc of ~400 paragraphs (Yjs state size printed), one cover image, one folder with
 * 20 child docs. Cells: doc JSON, doc file, folder root, folder child; after the change also an
 * expiring link and a password link with a valid unlock cookie, and the unlock POST itself.
 * Rounds interleaved before/after, ROUNDS × N requests per cell after WARM warm-up requests.
 */
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.APP_SECRET_KEY ||= 'bench-app-secret-key-0123456789-abcdefghij'
process.env.DATA_DIR ||= `${process.env.TMPDIR || '/tmp'}/inkling-share-bench-${process.pid}`
process.env.AUTH_GUARD_MAX_FAILURES ||= '100000'

import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { randomUUID } from 'node:crypto'

const N = Number(process.env.N || 300)
const WARM = Number(process.env.WARM || 30)
const ROUNDS = Number(process.env.ROUNDS || 2)

const q = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]
}

async function main() {
  mkdirSync(path.join(process.env.DATA_DIR!, 'uploads'), { recursive: true })
  const h = await import('../src/mcpTools/testHarness')
  const { db, closeDb } = await import('../src/db/index')
  const schema = await import('../src/db/schema')
  const { eq } = await import('drizzle-orm')
  const { AppError } = await import('../src/errors')
  const Fastify = (await import('fastify')).default
  const { blocksToStateBuffer } = await import('../src/md/convert')

  async function build(mod: string) {
    const app = Fastify()
    await app.register(import('@fastify/cookie'))
    app.setErrorHandler((err, _req, reply) => {
      if (err instanceof AppError) return reply.code(err.status).send({ error: { code: err.code, message: err.message } })
      return reply.code(500).send({ error: { code: 'INTERNAL', message: String(err) } })
    })
    const routes = (await import(mod)) as { registerPublicRoutes: (api: unknown) => Promise<void> }
    await app.register(async (api) => routes.registerPublicRoutes(api), { prefix: '/api' })
    await app.register(async (api) => {
      await (await import('../src/routes/pages')).registerPageRoutes(api)
    }, { prefix: '/api' })
    await app.ready()
    return app
  }
  const before = await build('../src/routes/publicBefore.bench')
  const after = await build('../src/routes/public')

  // --- seed ---
  const owner = await h.makeUser('bench')
  const ws = await h.makeWorkspace(owner)
  const para = (i: number) => ({
    type: 'paragraph',
    content: [{ type: 'text', text: `Paragraph ${i}: ${'lorem ipsum dolor sit amet consectetur '.repeat(5)}`, styles: {} }],
  })
  const fileId = randomUUID()
  writeFileSync(path.join(process.env.DATA_DIR!, 'uploads', fileId), Buffer.alloc(20_000, 1))
  const blocks = Array.from({ length: 400 }, (_, i) => para(i))
  const stateBytes = blocksToStateBuffer(blocks).length
  const mk = async (title: string) => {
    const p = await h.makeDocPage(ws.id, owner.id, title, blocks, { coverUrl: `/files/${fileId}` })
    return p
  }
  const docOpen = await mk('Open doc')
  await db.insert(schema.files).values({ id: fileId, workspaceId: ws.id, pageId: docOpen.id, name: 'c.png', mime: 'image/png', size: 20_000 })
  const docExp = await mk('Expiring doc')
  const docPw = await mk('Password doc')
  const [folder] = await db.insert(schema.pages).values({ workspaceId: ws.id, title: 'Folder', kind: 'folder', createdBy: owner.id }).returning()
  for (let i = 0; i < 20; i++) {
    await h.makeDocPage(ws.id, owner.id, `Child ${i}`, blocks.slice(0, 40), { parentId: folder.id })
  }
  const publish = async (id: string, body?: object) => {
    const r = await after.inject({ method: 'POST', url: `/api/pages/${id}/share`, headers: { cookie: owner.cookie }, ...(body ? { payload: body } : {}) })
    if (r.statusCode !== 200) throw new Error(r.body)
    return (r.json() as { token: string }).token
  }
  const tOpen = await publish(docOpen.id)
  const tExp = await publish(docExp.id, { expiresInDays: 30 })
  const tPw = await publish(docPw.id, { password: 'bench-password' })
  const tFolder = await publish(folder.id)
  const unlock = await after.inject({ method: 'POST', url: `/api/public/${tPw}/unlock`, payload: { password: 'bench-password' } })
  const cookie = unlock.cookies.map((c) => `${c.name}=${c.value}`).join('; ')
  const ref = ((await after.inject({ method: 'GET', url: `/api/public/${tFolder}` })).json() as { tree: { ref: string }[] }).tree[0].ref
  void eq

  type App = typeof after
  const cells: { name: string; url: string; cookie?: string; apps: ('before' | 'after')[] }[] = [
    { name: 'doc JSON, open link', url: `/api/public/${tOpen}`, apps: ['before', 'after'] },
    { name: 'doc file, open link', url: `/api/public/${tOpen}/f/${fileId}`, apps: ['before', 'after'] },
    { name: 'folder root, open link', url: `/api/public/${tFolder}`, apps: ['before', 'after'] },
    { name: 'folder child, open link', url: `/api/public/${tFolder}/p/${ref}`, apps: ['before', 'after'] },
    { name: 'doc JSON, expiring link', url: `/api/public/${tExp}`, apps: ['after'] },
    { name: 'doc JSON, password link + unlock cookie', url: `/api/public/${tPw}`, cookie, apps: ['after'] },
  ]
  const run = async (app: App, url: string, ck?: string) => {
    const times: number[] = []
    for (let i = 0; i < WARM + N; i++) {
      const t0 = performance.now()
      const r = await app.inject({ method: 'GET', url, headers: ck ? { cookie: ck } : {} })
      const dt = performance.now() - t0
      if (r.statusCode !== 200) throw new Error(`${url} → ${r.statusCode} ${r.body.slice(0, 200)}`)
      if (i >= WARM) times.push(dt)
    }
    return times
  }
  const results: Record<string, Record<string, { p50: number; p95: number }[]>> = {}
  for (let round = 0; round < ROUNDS; round++) {
    for (const c of cells) {
      for (const which of c.apps) {
        const times = await run(which === 'before' ? before : after, c.url, c.cookie)
        ;((results[c.name] ??= {})[which] ??= []).push({ p50: q(times, 50), p95: q(times, 95) })
      }
    }
  }
  // Unlock POST (right password), after the change only.
  const unlockTimes: number[] = []
  for (let i = 0; i < 20; i++) {
    const t0 = performance.now()
    await after.inject({ method: 'POST', url: `/api/public/${tPw}/unlock`, payload: { password: 'bench-password' } })
    unlockTimes.push(performance.now() - t0)
  }
  const { verifyPassword } = await import('../src/auth')
  const [pwRow] = await db.select({ h: schema.pages.sharePasswordHash }).from(schema.pages).where(eq(schema.pages.id, docPw.id))
  const argonTimes: number[] = []
  for (let i = 0; i < 20; i++) {
    const t0 = performance.now()
    await verifyPassword(pwRow.h!, 'wrong')
    argonTimes.push(performance.now() - t0)
  }

  console.log(`node ${process.version}, state ${stateBytes} bytes, N=${N} after ${WARM} warm-up, rounds=${ROUNDS}`)
  for (const [name, r] of Object.entries(results)) {
    const fmt = (xs?: { p50: number; p95: number }[]) =>
      xs ? xs.map((x) => `${x.p50.toFixed(3)}/${x.p95.toFixed(3)}`).join(', ') : '—'
    console.log(`${name.padEnd(42)} before p50/p95 ms: ${fmt(r.before).padEnd(30)} after: ${fmt(r.after)}`)
  }
  console.log(`unlock POST (right password) p50 ${q(unlockTimes, 50).toFixed(1)} ms, p95 ${q(unlockTimes, 95).toFixed(1)} ms (n=20)`)
  console.log(`argon2 verify alone p50 ${q(argonTimes, 50).toFixed(1)} ms, p95 ${q(argonTimes, 95).toFixed(1)} ms (n=20)`)
  await before.close()
  await after.close()
  await closeDb()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
