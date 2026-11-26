// A failed database query must not put its parameter values into the error log (0.25.4 security fix
// F-4). drizzle 0.45 wraps every failed query in DrizzleQueryError, whose message, stack and `params`
// field carry the values (emails, page text, sealed-or-not webhook URLs …). The global error handler
// (index.ts) logs the error with req.log.error; errors.ts logSafeError keeps the query text, the
// Postgres error code and message, and drops the values.
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
import assert from 'node:assert/strict'
import { Writable } from 'node:stream'
import { after, describe, it } from 'node:test'

const HAS_DB = !!process.env.DATABASE_URL
const SECRET = 'hunter2-secret-param-' + Math.random().toString(36).slice(2)

describe('[db] failed queries: parameter values stay out of the error log', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const Fastify = (await import('fastify')).default
  const { db, closeDb } = await import('./db/index')
  const { sql } = await import('drizzle-orm')
  const { logSafeError } = await import('./errors')
  after(() => closeDb())

  /** A real DrizzleQueryError: the secret is a bound parameter of a query that fails. */
  async function failedQuery(): Promise<unknown> {
    try {
      await db.execute(sql`SELECT ${SECRET}::int AS n, ${'second-' + SECRET}::text AS t`)
    } catch (err) {
      return err
    }
    throw new Error('the query did not fail')
  }

  /** What the global error handler writes for `err`, through Fastify's own logger (pino). */
  async function logged(transform: (err: unknown) => unknown): Promise<string> {
    let out = ''
    const stream = new Writable({
      write(chunk, _enc, cb) {
        out += chunk.toString()
        cb()
      },
    })
    const app = Fastify({ logger: { level: 'info', stream } })
    app.get('/boom', async () => {
      throw await failedQuery()
    })
    app.setErrorHandler((err, req, reply) => {
      req.log.error(transform(err))
      return reply.code(500).send({ error: { code: 'INTERNAL', message: 'Internal server error' } })
    })
    const r = await app.inject({ method: 'GET', url: '/boom' })
    assert.equal(r.statusCode, 500)
    await app.close()
    return out
  }

  it('as logged until now (the error object itself), the values are in the log', async () => {
    const err = await failedQuery()
    assert.equal((err as Error).constructor.name, 'DrizzleQueryError')
    const out = await logged((e) => e)
    assert.ok(out.includes(SECRET), 'baseline: drizzle puts the parameters in the message')
  })

  it('through logSafeError the values are gone, the query text and Postgres code stay', async () => {
    const out = await logged(logSafeError)
    assert.ok(!out.includes(SECRET), out)
    assert.match(out, /Failed query: SELECT \$1::int/)
    assert.match(out, /22P02/) // invalid_text_representation, from the Postgres error
  })

  it('other errors pass through unchanged', () => {
    const e = new Error('plain')
    assert.equal(logSafeError(e), e)
    assert.equal(logSafeError('x'), 'x')
  })
})
