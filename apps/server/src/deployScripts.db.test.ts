// deploy/reset-password.sh cuts off what the app's own password change cuts off (accounts.ts
// setPassword): sessions, reset codes, OAuth grants (MCP connections and agent tokens), personal API
// tokens and the iCal feed (0.25.4 security fix A-F4). The test runs the script's SQL block against
// the test database the way psql would (its :'uid' and :'h' variables filled in) and looks at the rows.
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { after, describe, it } from 'node:test'

const HAS_DB = !!process.env.DATABASE_URL
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..')

describe('[db] deploy/reset-password.sh ends every login and token of the account', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const h = await import('./mcpTools/testHarness')
  const { db, closeDb } = await import('./db/index')
  const { sql } = await import('drizzle-orm')
  after(() => closeDb())

  const script = readFileSync(path.join(ROOT, 'deploy/reset-password.sh'), 'utf8')
  const m = /<<'SQL'\n([\s\S]*?)\nSQL\n/.exec(script)
  assert.ok(m, 'SQL heredoc not found in deploy/reset-password.sh')
  const block = m[1]
  const lit = (s: string) => `'${s.replace(/'/g, "''")}'`
  // BEGIN/COMMIT of the script become one drizzle transaction (the pool refuses a bare BEGIN)
  const runScriptSql = (uid: string, hash: string) => {
    const filled = block.replaceAll(":'uid'", lit(uid)).replaceAll(":'h'", lit(hash))
    const statements = filled
      .split(/;\s*\n/)
      .map((s) => s.replace(/;\s*$/, '').trim())
      .filter((s) => s && !/^(BEGIN|COMMIT)$/i.test(s))
    assert.ok(/^BEGIN;/m.test(block) && /^COMMIT;/m.test(block), 'the script runs its SQL in one transaction')
    return db.transaction(async (tx) => {
      for (const s of statements) await tx.execute(sql.raw(s))
    })
  }

  const count = async (table: string, uid: string) => {
    const rows = (await db.execute(sql.raw(`SELECT count(*)::int AS n FROM ${table} WHERE user_id = ${lit(uid)}`))) as unknown as { n: number }[]
    return Number(rows[0]?.n ?? 0)
  }

  async function seed(uid: string) {
    await h.mintToken({ id: uid })
    await db.execute(
      sql`INSERT INTO api_tokens (user_id, name, token_hash, prefix, scope) VALUES (${uid}, 'script', ${randomBytes(16).toString('hex')}, 'ink_pat_abcd', 'notes')`,
    )
    await db.execute(sql`INSERT INTO ical_tokens (user_id, token_hash) VALUES (${uid}, ${randomBytes(16).toString('hex')})`)
  }

  it('sessions, OAuth grants, API tokens and the iCal feed of that account are gone; others stay', async () => {
    const victim = await h.makeUser('victim') // has a session
    const other = await h.makeUser('other')
    await seed(victim.id)
    await seed(other.id)
    for (const t of ['sessions', 'oauth_grants', 'api_tokens', 'ical_tokens']) assert.equal(await count(t, victim.id), 1, t)

    await runScriptSql(victim.id, '$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNoaGFzaA')

    for (const t of ['sessions', 'oauth_grants', 'api_tokens', 'ical_tokens']) {
      assert.equal(await count(t, victim.id), 0, `${t} of the reset account`)
      assert.equal(await count(t, other.id), 1, `${t} of another account`)
    }
    const [u] = (await db.execute(sql`SELECT password_hash FROM users WHERE id = ${victim.id}`)) as unknown as { password_hash: string }[]
    assert.match(u.password_hash, /^\$argon2id\$/)
  })
})
