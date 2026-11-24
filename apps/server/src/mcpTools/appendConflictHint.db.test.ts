// Version conflicts on modes that only add text (append/prepend/insert_after) tell the agent it can send the
// edit again without baseVersion; replace/delete conflicts keep their message. Several agents appending to one
// section kept losing the race when they retried with the new version each time.
// Run: cd apps/server && DATABASE_URL=postgres://… node --import tsx --test src/mcpTools/appendConflictHint.db.test.ts
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.DATA_DIR ||= `${process.env.TMPDIR || '/tmp'}/inkling-appendhint-${process.pid}`

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

const HAS_DB = !!process.env.DATABASE_URL
const HINT =
  'This mode does not change existing text, so sending it again without baseVersion adds it to the current content; first check the current content does not already have your lines.'

describe('[db] append conflicts point at retrying without baseVersion', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const h = await import('./testHarness')
  const { closeDb } = await import('../db/index')
  const collab = await import('../collab')
  const app = await h.buildTestApp()
  after(async () => {
    await collab.destroyCollab()
    await app.close()
    await closeDb()
  })

  let ws: { id: string }
  let mcp: Awaited<ReturnType<typeof h.connectMcp>>

  const create = async (title: string) => {
    const r = await mcp.tool('create_page', { workspaceId: ws.id, title, markdown: '## Log\n\nfirst line\n\n## Other\n\nkeep' })
    assert.equal(r.isError, false, r.text)
    return (JSON.parse(r.text) as { id: string }).id
  }
  const logVersion = async (pageId: string) => {
    const r = await mcp.tool('read_page', { pageId, outline: true })
    const v = /- §log .* v=([0-9a-f]+)/.exec(r.text)?.[1]
    assert.ok(v, r.text)
    return v
  }

  before(async () => {
    const owner = await h.makeUser('owner')
    ws = await h.makeWorkspace(owner, [])
    mcp = await h.connectMcp(app, owner, await h.mintToken(owner), { user: { ...owner, via: 'Test Agent' } })
  })

  it('patch_section append with a stale baseVersion: the conflict adds the hint; the same call without baseVersion keeps both lines', async () => {
    const pageId = await create('Team log A')
    const v1 = await logVersion(pageId)
    const other = await mcp.tool('patch_section', { pageId, section: 'log', mode: 'append', markdown: 'line from agent 2', baseVersion: v1 })
    assert.equal(other.isError, false, other.text)
    const stale = await mcp.tool('patch_section', { pageId, section: 'log', mode: 'append', markdown: 'line from agent 1', baseVersion: v1 })
    assert.equal(stale.isError, true)
    assert.ok(stale.text.split('\n')[0]!.endsWith(HINT), stale.text)
    const retry = await mcp.tool('patch_section', { pageId, section: 'log', mode: 'append', markdown: 'line from agent 1' })
    assert.equal(retry.isError, false, retry.text)
    const body = (await mcp.tool('read_page', { pageId, section: 'log' })).text
    assert.ok(body.includes('line from agent 2') && body.includes('line from agent 1'), body)
    assert.ok(body.indexOf('line from agent 2') < body.indexOf('line from agent 1'), body)
  })

  it('patch_section replace with a stale baseVersion: the conflict message is unchanged (no hint)', async () => {
    const pageId = await create('Team log B')
    const v1 = await logVersion(pageId)
    assert.equal((await mcp.tool('patch_section', { pageId, section: 'log', mode: 'append', markdown: 'more', baseVersion: v1 })).isError, false)
    const v2 = await logVersion(pageId)
    const stale = await mcp.tool('patch_section', { pageId, section: 'log', mode: 'replace', markdown: 'overwrite', baseVersion: v1 })
    assert.equal(stale.isError, true)
    assert.equal(
      stale.text.split('\n')[0],
      `Conflict: Section "log" changed since baseVersion ${v1}; nothing was written. Merge your edit into the current content and retry with baseVersion ${v2}.`,
    )
    assert.ok(!stale.text.includes(HINT))
  })

  it('patch_sections append with a stale baseVersion: the edit line adds the hint; without baseVersion both lines stay', async () => {
    const pageId = await create('Team log C')
    const v1 = await logVersion(pageId)
    assert.equal((await mcp.tool('patch_section', { pageId, section: 'log', mode: 'append', markdown: 'line from agent 2', baseVersion: v1 })).isError, false)
    const v2 = await logVersion(pageId)
    const stale = await mcp.tool('patch_sections', { pageId, edits: [{ section: 'log', mode: 'append', markdown: 'line from agent 1', baseVersion: v1 }] })
    assert.equal(stale.isError, true)
    assert.ok(stale.text.includes(`- edit 1 §log: changed since baseVersion ${v1} (now v=${v2}). ${HINT}`), stale.text)
    const replace = await mcp.tool('patch_sections', { pageId, edits: [{ section: 'log', mode: 'replace', markdown: 'x', baseVersion: v1 }] })
    assert.ok(replace.text.includes(`- edit 1 §log: changed since baseVersion ${v1} (now v=${v2})\n`), replace.text)
    assert.ok(!replace.text.includes(HINT))
    const retry = await mcp.tool('patch_sections', { pageId, edits: [{ section: 'log', mode: 'append', markdown: 'line from agent 1' }] })
    assert.equal(retry.isError, false, retry.text)
    const body = (await mcp.tool('read_page', { pageId, section: 'log' })).text
    assert.ok(body.includes('line from agent 2') && body.includes('line from agent 1'), body)
  })
})
