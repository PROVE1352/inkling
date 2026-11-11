// The instance storage fuse (docs/adr/2532-*) and POST /oauth/register (docs/adr/2536-*) meet here:
// registering a client needs no account and writes a row, so a server that is out of storage
// refuses it. Without LIMIT_INSTANCE_STORAGE_MB nothing is measured and nothing is refused.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'inkling-oauthfull-'))

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, describe, it } from 'node:test'

const BASE_URL = process.env.DATABASE_URL

describe('[db] /oauth/register while the instance is full', { skip: !BASE_URL }, async () => {
  if (!BASE_URL) return
  const { db, closeDb } = await import('../db/index')
  const { sql } = await import('drizzle-orm')
  const { setLimitsForTests } = await import('../limits')
  const I = await import('../quota/instance')

  const Fastify = (await import('fastify')).default
  const app = Fastify()
  await app.register(import('@fastify/cookie'))
  await app.register(async (root) => {
    await (await import('../routes/oauth')).registerOAuthRoutes(root)
  })
  await app.ready()
  after(async () => {
    I._setInstanceStorageForTests(null)
    await app.close()
    await closeDb()
  })

  const tag = () => randomBytes(4).toString('hex')
  const register = (name: string) =>
    app.inject({
      method: 'POST',
      url: '/oauth/register',
      remoteAddress: `198.51.100.${1 + Math.floor(Math.random() * 200)}`,
      payload: { client_name: name, redirect_uris: ['https://app.example.com/cb'] },
    })
  const rowsNamed = async (name: string) =>
    ((await db.execute(sql`SELECT count(*)::int AS n FROM oauth_clients WHERE name = ${name}`)) as unknown as { n: number }[])[0]!.n

  it('full: 503 temporarily_unavailable and no row; back under the limit: registered', async () => {
    const restore = setLimitsForTests({ instanceStorageMb: 1 })
    try {
      I._setInstanceStorageForTests({ dbBytes: 2 * 1024 * 1024, fileBytes: 0 })
      const name = `full-${tag()}`
      const refused = await register(name)
      assert.equal(refused.statusCode, 503, refused.body)
      assert.equal(refused.json().error, 'temporarily_unavailable')
      assert.equal(await rowsNamed(name), 0)

      I._setInstanceStorageForTests({ dbBytes: 0, fileBytes: 0 })
      const ok = await register(name)
      assert.equal(ok.statusCode, 201, ok.body)
      assert.equal(await rowsNamed(name), 1)
    } finally {
      I._setInstanceStorageForTests(null)
      restore()
    }
  })

  it('unset: registering is not refused whatever the measured size', async () => {
    I._setInstanceStorageForTests({ dbBytes: 10 * 1024 * 1024 * 1024, fileBytes: 0 })
    try {
      const name = `unset-${tag()}`
      const res = await register(name)
      assert.equal(res.statusCode, 201, res.body)
      assert.equal(await rowsNamed(name), 1)
    } finally {
      I._setInstanceStorageForTests(null)
    }
  })
})
