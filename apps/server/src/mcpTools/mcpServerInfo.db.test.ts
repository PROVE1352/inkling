// MCP initialize reports the app version as serverInfo.version, the same value as /api/version
// (SERVER_VERSION in version.ts), not a fixed '1.0.0'.
// Run: cd apps/server && DATABASE_URL=postgres://… node --import tsx --test src/mcpTools/mcpServerInfo.db.test.ts
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.APP_URL ||= 'https://notes.example.com'
// SERVER_VERSION prefers APP_VERSION; without it the value is package.json's version
delete process.env.APP_VERSION

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, describe, it } from 'node:test'

const HAS_DB = !!process.env.DATABASE_URL

describe('[db] MCP serverInfo', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const h = await import('./testHarness')
  const { closeDb } = await import('../db/index')
  const app = await h.buildTestApp()
  const alice = await h.makeUser('alice')
  await h.makeWorkspace(alice)
  const mcp = await h.connectMcp(app, alice, await h.mintToken(alice))
  after(async () => {
    await mcp.close()
    await app.close()
    await closeDb()
  })

  it('initialize answers with the version in apps/server/package.json', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }
    const info = mcp.client.getServerVersion()
    assert.equal(info?.name, 'inkling')
    assert.equal(info?.version, pkg.version)
    assert.notEqual(info?.version, '1.0.0')
  })
})
