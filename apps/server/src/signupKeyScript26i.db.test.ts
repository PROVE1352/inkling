// deploy/signup-key.sh makes 28-character keys since 0.25.4 (sec26 A-F3, seven groups of four); the
// server's own keys stay 16 characters. A key the script made and stored with the script's own INSERT
// must sign someone up: the register schema takes 1–200 characters and the server hashes the upper-case
// key (secretsAtRest.canonicalCode), which is what the script stores.
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.SIGNUP_REQUIRE_KEY = '1'
for (const k of ['DELEGATED_AUTH_URL', 'SMTP_HOST', 'MAIL_FROM', 'REQUIRE_EMAIL_VERIFICATION']) delete process.env[k]

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { after, describe, it } from 'node:test'

const HAS_DB = !!process.env.DATABASE_URL
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..')
const SCRIPT = readFileSync(path.join(ROOT, 'deploy/signup-key.sh'), 'utf8')

/** A key from the script's own gen_key. */
function scriptKey(): string {
  const fn = /^gen_key\(\) \{\n[\s\S]*?\n\}\n/m.exec(SCRIPT)
  assert.ok(fn, 'gen_key() not found')
  return execFileSync('bash', ['-c', `set -euo pipefail\n${fn[0]}\ngen_key`], { encoding: 'utf8' })
}

/** The script's INSERT for `new <note> 1` without expiry, with the shell values filled in. */
function scriptInsert(key: string): string {
  const m = /psql -q -c "(INSERT INTO signup_keys[\s\S]*?)"\n/.exec(SCRIPT)
  assert.ok(m, 'the INSERT of `new` not found')
  return m[1]
    .replace(/\$\( \[\[ -n "\$note" \]\][^\n]*?\)/, 'NULL')
    .replace(/\$key/g, key)
    .replace(/\$uses/g, '1')
    .replace(/\$expires/g, 'NULL')
}

describe('[db] a signup key from deploy/signup-key.sh signs up', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const { db, closeDb } = await import('./db/index')
  const schema = await import('./db/schema')
  const { eq, sql } = await import('drizzle-orm')
  const { hashSignupKey } = await import('./secretsAtRest')
  const { AppError } = await import('./errors')
  const { ZodError } = await import('zod')
  const Fastify = (await import('fastify')).default
  const app = Fastify()
  await app.register(import('@fastify/cookie'))
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.code(err.status).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.code(400).send({ error: { code: 'VALIDATION', message: err.message } })
    return reply.code(500).send({ error: { code: 'INTERNAL', message: String(err) } })
  })
  await app.register(async (api) => (await import('./routes/auth')).registerAuthRoutes(api), { prefix: '/api' })
  await app.ready()
  after(async () => {
    await app.close()
    await closeDb()
  })

  const register = (signupKey: string) =>
    app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: `key28-${randomBytes(4).toString('hex')}@example.com`, name: 'Key 28', password: 'password123', signupKey },
    })

  it('a 28-character script key, typed as printed or in lower case, signs up once', async () => {
    for (const typed of [(k: string) => k, (k: string) => ` ${k.toLowerCase()} `]) {
      const key = scriptKey()
      assert.match(key, /^[A-Z2-9]{4}(-[A-Z2-9]{4}){6}$/)
      assert.equal(key.replace(/-/g, '').length, 28)
      await db.execute(sql.raw(scriptInsert(key)))
      const [row] = await db.select().from(schema.signupKeys).where(eq(schema.signupKeys.key, hashSignupKey(key)))
      assert.ok(row, 'the script stores the hash the server looks up')
      assert.equal(row.keyHint, key.slice(-4))
      const r = await register(typed(key))
      assert.equal(r.statusCode, 200, r.body)
      // one use
      const again = await register(key)
      assert.equal(again.statusCode, 403, again.body)
      assert.match(again.body, /INVALID_SIGNUP_KEY/)
    }
  })
})
