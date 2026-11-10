/**
 * Comment POST under concurrency, with what the outbox costs around it (docs/adr/1150-*).
 *
 *   tsx scripts/comment-post-bench.ts --build before=/abs/dist-a/index.js --build after=/abs/dist-b/index.js \
 *       [--rounds 2] [--n 300] [--warmup 30] [--mode comment|append] [--admin postgres://inkling:inkling@localhost:55432/postgres]
 *
 * Each build is a production bundle (`tsup --out-dir …`; its folder needs a `node_modules` link to
 * apps/server/node_modules). Per round and build, in interleaved order (a, b, a, b, …):
 *  - a fresh database copied from one seed (CREATE DATABASE … TEMPLATE), so every run starts equal;
 *  - the server as its own process (NODE_ENV=production, outbox worker on), the load generator here;
 *  - 30 warm-up + N comment POSTs at 1 client, then the same at 16 clients (new threads on random
 *    pages created by other members; each comment notifies the page's creator);
 *  - during the 16-client run: pg_stat_activity sampled every 2 ms (wait events of the app's
 *    connections), NOTIFYs received on `inkling_outbox`, commits and outbox / notification inserts
 *    from the statistics views (deltas), time until the outbox is empty after the last response.
 * Seed: 51 users, 1 workspace, 2,000 shared doc pages created by 50 of them, 3,000 comments. The databases are dropped at the end.
 */
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'

const here = path.dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
function opt(name: string, dflt: string): string {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : dflt
}
const builds: { label: string; file: string }[] = []
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--build') {
    const [label, file] = args[i + 1].split('=')
    builds.push({ label, file })
  }
}
if (builds.length === 0) throw new Error('--build label=/abs/index.js (one or more)')
const ROUNDS = Number(opt('rounds', '2'))
const N = Number(opt('n', '300'))
const WARMUP = Number(opt('warmup', '30'))
const ADMIN = opt('admin', 'postgres://inkling:inkling@localhost:55432/postgres')
const PAGES = 2_000
const CREATORS = 50
const PORT0 = Number(opt('port', '3391'))
/** 'comment' = POST /pages/:id/comments (new thread); 'append' = POST /pages/:id/content (update_page append, write gate cost). */
const MODE = opt('mode', 'comment') as 'comment' | 'append'
const tag = `inkb_${process.pid}`

const admin = postgres(ADMIN, { max: 1, onnotice: () => {} })
const urlFor = (db: string) => ADMIN.replace(/\/[^/]*$/, `/${db}`)

interface Seed {
  token: string
  pageIds: string[]
}

async function makeSeed(): Promise<Seed> {
  const name = `${tag}_seed`
  await admin.unsafe(`CREATE DATABASE ${name}`)
  const c = postgres(urlFor(name), { max: 1, onnotice: () => {} })
  await migrate(drizzle(c), { migrationsFolder: path.join(here, '..', 'drizzle') })
  // Alice comments; the pages belong to 50 other members, so every comment notifies one person
  // and nobody reaches the hourly cap (60 quiet / 300 dropped) during a run.
  const a = randomUUID()
  const others = Array.from({ length: CREATORS }, () => randomUUID())
  const ws = randomUUID()
  await c`INSERT INTO users (id, email, name, password_hash) VALUES (${a}, 'a@bench.test', 'Alice', 'x')`
  await c`INSERT INTO users (id, email, name, password_hash) SELECT u, 'u' || i || '@bench.test', 'User ' || i, 'x'
            FROM unnest(${others}::uuid[]) WITH ORDINALITY AS t(u, i)`
  await c`INSERT INTO workspaces (id, name, invite_code, created_by) VALUES (${ws}, 'Bench', ${randomUUID()}, ${a})`
  await c`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (${ws}, ${a}, 'owner')`
  await c`INSERT INTO workspace_members (workspace_id, user_id, role) SELECT ${ws}, u, 'member' FROM unnest(${others}::uuid[]) u`
  await c`INSERT INTO workspace_acl_versions (workspace_id, version, locked_pages) VALUES (${ws}, 0, 0) ON CONFLICT DO NOTHING`
  const pages = (await c`
    INSERT INTO pages (workspace_id, kind, scope, title, created_by, sort_order)
    SELECT ${ws}, 'doc', 'shared', 'Page ' || g, (${others}::uuid[])[1 + g % ${CREATORS}], g * 1000 FROM generate_series(1, ${PAGES}) g
    RETURNING id`) as unknown as { id: string }[]
  const pageIds = pages.map((p) => p.id)
  await c`
    INSERT INTO comments (page_id, block_id, thread_id, author_id, body)
    SELECT (${pageIds}::uuid[])[1 + g % ${PAGES}], 'b1', gen_random_uuid(), (${others}::uuid[])[1 + g % ${CREATORS}], 'seed comment ' || g
      FROM generate_series(1, 3000) g`
  await c`UPDATE comments SET thread_id = id`
  const token = randomBytes(32).toString('base64url')
  const hash = createHash('sha256').update(token, 'utf8').digest('hex')
  await c`INSERT INTO sessions (token, user_id, expires_at) VALUES (${hash}, ${a}, now() + interval '7 days')`
  await c`VACUUM ANALYZE`
  await c.end()
  return { token, pageIds }
}

function startServer(file: string, db: string, port: number): Promise<ChildProcess> {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'inkb-'))
  const child = spawn(process.execPath, [file], {
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(port),
      DATABASE_URL: urlFor(db),
      DATA_DIR: dataDir,
      DRIZZLE_DIR: path.join(here, '..', 'drizzle'),
      LOG_LEVEL: 'warn',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let err = ''
  child.stderr?.on('data', (d) => (err += String(d)))
  return new Promise((resolve, reject) => {
    const t0 = Date.now()
    const poll = async () => {
      if (child.exitCode !== null) return reject(new Error(`server exited: ${err.slice(-2000)}`))
      try {
        const r = await fetch(`http://127.0.0.1:${port}/api/health`)
        if (r.ok) return resolve(child)
      } catch {
        /* not yet */
      }
      if (Date.now() - t0 > 30_000) return reject(new Error(`server did not start: ${err.slice(-2000)}`))
      setTimeout(poll, 100)
    }
    void poll()
  })
}

function pct(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]
}

let ipSeq = 0
async function load(port: number, seed: Seed, conc: number, n: number): Promise<{ lat: number[]; secs: number }> {
  const lat: number[] = []
  let next = 0
  const t0 = performance.now()
  const worker = async () => {
    while (next < n) {
      next++
      const pageId = seed.pageIds[Math.floor(Math.random() * seed.pageIds.length)]
      const ip = ++ipSeq
      const s = performance.now()
      const r = await fetch(`http://127.0.0.1:${port}/api/pages/${pageId}/${MODE === 'append' ? 'content' : 'comments'}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: `inkling_sid=${seed.token}`,
          'x-forwarded-for': `10.${(ip >> 16) & 255}.${(ip >> 8) & 255}.${ip & 255}`,
        },
        body: JSON.stringify(MODE === 'append' ? { markdown: `bench line ${ip}`, mode: 'append' } : { blockId: 'b1', body: `bench comment ${ip}` }),
      })
      await r.arrayBuffer()
      if (r.status !== 200) throw new Error(`HTTP ${r.status}`)
      lat.push(performance.now() - s)
    }
  }
  await Promise.all(Array.from({ length: conc }, worker))
  return { lat, secs: (performance.now() - t0) / 1000 }
}

interface DbStats {
  commits: number
  outboxIns: number
  notifRows: number
}

/**
 * Commits from pg_stat_database (backends flush their counters when idle, at the latest after
 * 10 s: the caller waits 11 s first); outbox inserts from the id sequence; notification rows by count.
 * Runs on `admin` (another database) and `c` (2 autocommit statements, subtracted by the caller).
 */
async function dbStats(c: postgres.Sql, db: string): Promise<DbStats> {
  await new Promise((r) => setTimeout(r, 11_000))
  const [d] = await admin`SELECT xact_commit::int AS commits FROM pg_stat_database WHERE datname = ${db}`
  const [o] = await c`SELECT coalesce((SELECT last_value FROM outbox_id_seq WHERE is_called), 0)::int AS n`
  const [n] = await c`SELECT count(*)::int AS n FROM notifications`
  return { commits: Number(d.commits), outboxIns: Number(o.n), notifRows: Number(n.n) }
}

async function runOne(build: { label: string; file: string }, seed: Seed, round: number, port: number) {
  const db = `${tag}_${build.label.replace(/\W/g, '')}_${round}`
  await admin.unsafe(`CREATE DATABASE ${db} TEMPLATE ${tag}_seed`)
  const server = await startServer(build.file, db, port)
  const mon = postgres(urlFor(db), { max: 2, onnotice: () => {} })
  try {
    const out: Record<string, unknown> = { mode: MODE, build: build.label, round }
    for (const conc of [1, 16]) {
      await load(port, seed, conc, WARMUP)
      // let the consumer settle before measuring
      for (let i = 0; i < 200; i++) {
        const [p] = await mon`SELECT count(*)::int AS n FROM outbox WHERE state = 'pending'`
        if (Number(p.n) === 0) break
        await new Promise((r) => setTimeout(r, 25))
      }
      let own = 0
      const before = await dbStats(mon, db)
      let notifies = 0
      const listener = await mon.listen('inkling_outbox', () => notifies++)
      const waits = new Map<string, number>()
      let samples = 0
      let sampling = conc > 1
      const sampler = (async () => {
        const s2 = postgres(ADMIN, { max: 1, onnotice: () => {} })
        while (sampling) {
          const rows = await s2`
            SELECT coalesce(wait_event_type || ':' || wait_event, 'cpu') AS w, application_name AS app
              FROM pg_stat_activity WHERE datname = ${db} AND application_name LIKE 'inkling%' AND state = 'active'`
          samples++
          for (const r of rows) waits.set(`${r.app}|${r.w}`, (waits.get(`${r.app}|${r.w}`) ?? 0) + 1)
          await new Promise((r) => setTimeout(r, 2))
        }
        await s2.end()
      })()
      const { lat, secs } = await load(port, seed, conc, N)
      const tEnd = performance.now()
      let drainMs = -1
      for (let i = 0; i < 2000; i++) {
        own++
        const [p] = await mon`SELECT count(*)::int AS n FROM outbox WHERE state = 'pending'`
        if (Number(p.n) === 0) {
          drainMs = performance.now() - tEnd
          break
        }
        await new Promise((r) => setTimeout(r, 2))
      }
      sampling = false
      await sampler
      own += 3 // the two statements of the first dbStats, LISTEN
      const after = await dbStats(mon, db)
      await listener.unlisten()
      out[`c${conc}`] = {
        p50: +pct(lat, 50).toFixed(2),
        p95: +pct(lat, 95).toFixed(2),
        rps: Math.round(N / secs),
        drainMs: Math.round(drainMs),
        commitsPerReq: +((after.commits - before.commits - own) / N).toFixed(2),
        outboxInsPerReq: +((after.outboxIns - before.outboxIns) / N).toFixed(2),
        notifRowsPerReq: +((after.notifRows - before.notifRows) / N).toFixed(2),
        notifiesSeen: notifies,
        ...(conc > 1
          ? {
              samples,
              waits: Object.fromEntries(
                [...waits.entries()].sort((x, y) => y[1] - x[1]).slice(0, 8).map(([k, v]) => [k, +(v / samples).toFixed(3)]),
              ),
            }
          : {}),
      }
    }
    console.log(JSON.stringify(out))
    return out
  } finally {
    await mon.end()
    server.kill('SIGTERM')
    await new Promise((r) => server.once('exit', r))
    await admin.unsafe(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`)
  }
}

if (args.includes('--seed-only')) {
  // Leave the seed database for manual EXPLAIN runs (dropped by the caller).
  const seed = await makeSeed()
  console.log(JSON.stringify({ db: `${tag}_seed`, token: seed.token }))
  await admin.end()
  process.exit(0)
}

try {
  const seed = await makeSeed()
  let port = PORT0
  for (let round = 1; round <= ROUNDS; round++) {
    for (const b of builds) await runOne(b, seed, round, port++)
  }
} finally {
  await admin.unsafe(`DROP DATABASE IF EXISTS ${tag}_seed WITH (FORCE)`)
  await admin.end()
}
