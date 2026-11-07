/**
 * GET /api/admin/status latency, cache miss (?refresh=1, every heavy probe runs) vs cache hit
 * (docs/adr/1230-*, docs/PERFORMANCE.md). In-process Fastify app with the admin routes, app.inject.
 *
 *   cd apps/server
 *   DATABASE_URL=postgres://…/<seeded scratch db> BACKUP_DIR=<dir with status.json> \
 *     npx tsx scripts/admin-status-bench.ts [--miss 30] [--hit 200]
 */
import { performance } from 'node:perf_hooks'
import Fastify from 'fastify'

const arg = (name: string, d: number) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? Number(process.argv[i + 1]) : d
}
const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]
}
const fmt = (xs: number[]) =>
  `p50 ${pct(xs, 50).toFixed(2)} ms, p95 ${pct(xs, 95).toFixed(2)} ms, max ${Math.max(...xs).toFixed(2)} ms (n=${xs.length})`

async function main() {
  const { db, closeDb } = await import('../src/db/index')
  const schema = await import('../src/db/schema')
  const { createSession, SESSION_COOKIE } = await import('../src/auth')
  const { registerAdminRoutes } = await import('../src/routes/admin')
  const { computeHeavyFacts } = await import('../src/status/probes')

  const app = Fastify()
  await app.register(import('@fastify/cookie'))
  await app.register(async (api) => registerAdminRoutes(api), { prefix: '/api' })
  await app.ready()
  const [u] = await db
    .insert(schema.users)
    .values({ email: `bench-${Date.now()}@t.t`, name: 'bench', passwordHash: 'x', isAdmin: true })
    .returning()
  const { token } = await createSession(u.id)
  const headers = { cookie: `${SESSION_COOKIE}=${token}` }
  const call = async (url: string) => {
    const t0 = performance.now()
    const res = await app.inject({ method: 'GET', url, headers })
    const ms = performance.now() - t0
    if (res.statusCode !== 200) throw new Error(`${res.statusCode} ${res.body}`)
    return { ms, body: res.json() as { cache: { hit: boolean }; level: string } }
  }

  for (let i = 0; i < 3; i++) await call('/api/admin/status?refresh=1') // warm-up
  const miss: number[] = []
  const hit: number[] = []
  const nMiss = arg('miss', 30)
  const nHit = arg('hit', 200)
  for (let i = 0; i < nMiss; i++) {
    const r = await call('/api/admin/status?refresh=1')
    if (r.body.cache.hit) throw new Error('expected a miss')
    miss.push(r.ms)
  }
  for (let i = 0; i < nHit; i++) {
    const r = await call('/api/admin/status')
    if (!r.body.cache.hit) throw new Error('expected a hit')
    hit.push(r.ms)
  }
  // the heavy probes alone (no HTTP, no evaluation)
  const probes: number[] = []
  for (let i = 0; i < 10; i++) {
    const t0 = performance.now()
    await computeHeavyFacts()
    probes.push(performance.now() - t0)
  }
  console.log(`miss (?refresh=1): ${fmt(miss)}`)
  console.log(`hit:               ${fmt(hit)}`)
  console.log(`heavy probes only: ${fmt(probes)}`)
  await app.close()
  await closeDb()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
