import postgres from 'postgres'
import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { env } from '../env'
import * as schema from './schema'

/**
 * Server-side limits for every pooled connection (B-M4, docs/adr/0807-*), sent as startup
 * parameters so they apply per connection — NOT per role: the backup sidecar's pg_dump logs in with
 * the same role and must stay unlimited. A runaway recursive query, a forgotten open transaction
 * or a lock queue can no longer pin all 10 pool connections. Long jobs opt out per transaction
 * with relaxStatementTimeout(tx).
 */
export const POOL_TIMEOUTS = {
  statement_timeout: 15_000,
  idle_in_transaction_session_timeout: 60_000,
  lock_timeout: 10_000,
} as const

// Application connection pool (max 10). onnotice is silenced.
const client = postgres(env.databaseUrl, {
  max: 10,
  onnotice: () => {},
  connect_timeout: 10,
  connection: { application_name: 'inkling', ...POOL_TIMEOUTS },
})

export const db = drizzle(client, { schema })

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

/**
 * Runs `fn` in a transaction with SSD page costs (`random_page_cost = 1.1`, docs/adr/0755-*).
 * With the default 4.0 the planner prefers a seq scan + ILIKE over every TOASTed body to the
 * trigram index (it does not cost detoasting) and ends up 50-250x slower on selective terms.
 * The same value is the compose default (deploy/postgres), this keeps the plan right on
 * servers that run with stock settings. Seq scans remain available where they really win.
 */
export function withSsdPlanCosts<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL random_page_cost = 1.1`)
    return fn(tx)
  })
}

/** Lifts the pool's statement timeout for the rest of `tx` (long maintenance work). */
export async function relaxStatementTimeout(tx: Pick<Tx, 'execute'>): Promise<void> {
  await tx.execute(sql`SET LOCAL statement_timeout = 0`)
}

/** Run migrations at boot: opens a dedicated single connection and closes it when done. */
export async function runMigrations(): Promise<void> {
  // No statement/lock timeouts here: a migration may rewrite a large table (ADR 0807).
  const migrationClient = postgres(env.databaseUrl, {
    max: 1,
    onnotice: () => {},
    connect_timeout: 10,
    connection: { application_name: 'inkling-migrate', statement_timeout: 0, lock_timeout: 0 },
  })
  try {
    await migrate(drizzle(migrationClient, { schema }), {
      migrationsFolder: env.drizzleDir,
    })
  } finally {
    await migrationClient.end({ timeout: 5 })
  }
}

/** Close the connection pool on shutdown */
export async function closeDb(): Promise<void> {
  await client.end({ timeout: 5 })
}

/** Postgres SQLSTATE of an error thrown through drizzle (which may wrap it in `cause`). */
export function pgCode(err: unknown): string | undefined {
  const e = err as { code?: unknown; cause?: { code?: unknown } } | null
  const c = e?.code ?? e?.cause?.code
  return typeof c === 'string' ? c : undefined
}

/**
 * Re-runs `fn` (a whole transaction) when Postgres aborted it as a deadlock victim (40P01).
 * Callers already lock in a canonical order; this covers the remaining interleavings (A-M12).
 */
export async function retryOnDeadlock<T>(fn: () => Promise<T>, retries = 2): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn()
    } catch (err) {
      if (pgCode(err) !== '40P01' || i >= retries) throw err
      await new Promise((r) => setTimeout(r, 20 + Math.random() * 80))
    }
  }
}
