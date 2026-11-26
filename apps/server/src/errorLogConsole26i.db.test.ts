// Background jobs log failed queries with console.error / console.warn (0.25.4 security fix F-4, the
// part wired at merge): installLogSafeConsole, which the server installs once at start, passes each
// argument through logSafeError, so a DrizzleQueryError's bound values do not reach the log.
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
import assert from 'node:assert/strict'
import { format } from 'node:util'
import { after, describe, it } from 'node:test'

const HAS_DB = !!process.env.DATABASE_URL
const SECRET = 'hunter2-console-param-' + Math.random().toString(36).slice(2)

describe('[db] failed queries logged through console keep their values out', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const { db, closeDb } = await import('./db/index')
  const { sql } = await import('drizzle-orm')
  const { installLogSafeConsole } = await import('./errors')
  after(() => closeDb())

  async function failedQuery(): Promise<unknown> {
    try {
      await db.execute(sql`SELECT ${SECRET}::int AS n`)
    } catch (err) {
      return err
    }
    throw new Error('the query did not fail')
  }

  it('console.error and console.warn of a failed query print the SQL and the code, not the value', async () => {
    const lines: string[] = []
    const sink = { error: (...a: unknown[]) => lines.push(format(...a)), warn: (...a: unknown[]) => lines.push(format(...a)) }
    const err = await failedQuery()
    // as before: the raw error carries the value
    sink.error('[inkling] job failed', err)
    assert.ok(lines[0].includes(SECRET))
    lines.length = 0
    installLogSafeConsole(sink)
    sink.error('[inkling] job failed', 'page-1', err)
    sink.warn('[inkling] job failed', err)
    for (const l of lines) {
      assert.ok(!l.includes(SECRET), l)
      assert.match(l, /Failed query: SELECT \$1::int/)
      assert.match(l, /22P02/)
    }
    assert.match(lines[0], /^\[inkling\] job failed page-1 /)
    // other values pass through unchanged
    sink.error('plain', { a: 1 }, new Error('boom'))
    assert.match(lines[2], /^plain \{ a: 1 \} Error: boom/)
  })
})
