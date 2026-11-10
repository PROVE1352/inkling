// Search scope across workspaces through the MCP server (docs/adr/2185-*, 2186-*): workspaceId by
// name in find_context and the other tools with a workspace argument, errors that list candidates,
// labels only when an answer spans workspaces.
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.DATA_DIR ||= `${process.env.TMPDIR || '/tmp'}/inkling-wsscope-${process.pid}`

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, describe, it } from 'node:test'

const HAS_DB = !!process.env.DATABASE_URL

describe('[db] workspace scope: names as workspaceId, labels across workspaces', { skip: !HAS_DB }, async () => {
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

  // a word no other test writes, so find_context sees only these pages
  const word = `zq${randomBytes(4).toString('hex')}`
  let mcp: Awaited<ReturnType<typeof h.connectMcp>>
  let wind: { id: string }
  let air: { id: string }
  let foreign: { id: string }

  before(async () => {
    const me = await h.makeUser('scope')
    const stranger = await h.makeUser('stranger')
    wind = await h.makeWorkspace(me, [], 'Wind Cup 2026')
    air = await h.makeWorkspace(me, [], 'Air Quality')
    await h.makeWorkspace(me, [], 'Twin')
    await h.makeWorkspace(me, [], 'twin')
    foreign = await h.makeWorkspace(stranger, [], 'Secret Stranger Space')
    mcp = await h.connectMcp(app, me, await h.mintToken(me))
    for (const [w, t] of [
      [wind, 'Validate'],
      [air, 'Validate'],
    ] as const) {
      const r = await mcp.tool('create_page', { workspaceId: w.id, title: 'HARNESS.md', markdown: `## ${t}\n${word} harness validation for ${w === wind ? 'wind' : 'air'}` })
      assert.equal(r.isError, false, r.text)
    }
  })

  it('find_context across two workspaces names them; by name it is one workspace and unlabelled', async () => {
    const all = (await mcp.tool('find_context', { query: `${word} validation` })).text
    assert.match(all, /^\[1\] \{(Wind Cup 2026|Air Quality)\} HARNESS\.md › Validate$/m)
    assert.match(all, /^\[2\] \{(Wind Cup 2026|Air Quality)\} HARNESS\.md › Validate$/m)
    assert.match(all, new RegExp(`^Results come from 2 workspaces \\(\\{name\\} on each line\\): (${wind.id.slice(0, 8)}|${air.id.slice(0, 8)}) \\[1\\], `, 'm'))
    for (const ref of ['wind cup 2026', 'Wind', wind.id.slice(0, 8), wind.id]) {
      const one = await mcp.tool('find_context', { query: `${word} validation`, workspaceId: ref })
      assert.equal(one.isError, false, `${ref}: ${one.text}`)
      assert.match(one.text, /for wind/)
      assert.doesNotMatch(one.text, /for air|\{Wind|Results come from/)
    }
  })

  it('other tools with a workspace argument take the name too', async () => {
    const pages = await mcp.tool('list_pages', { workspaceId: 'air quality', format: 'lines' })
    assert.equal(pages.isError, false, pages.text)
    assert.match(pages.text, /- HARNESS\.md [0-9a-f-]{36}/)
    const created = await mcp.tool('create_page', { workspaceId: 'Wind Cup', title: 'Made by name', markdown: 'x' })
    assert.equal(created.isError, false, created.text)
    assert.equal((JSON.parse(created.text) as { workspaceId: string }).workspaceId, wind.id)
  })

  it('ambiguous and unknown names are errors that list ids and names; another member\'s workspace stays unknown', async () => {
    const twin = await mcp.tool('find_context', { query: word, workspaceId: 'TWIN' })
    assert.equal(twin.isError, true)
    assert.match(twin.text, /^Error: the name "TWIN" matches 2 of your workspaces: [0-9a-f]{8} "Twin", [0-9a-f]{8} "twin"\. Pass one of these ids/)
    const none = await mcp.tool('list_pages', { workspaceId: 'Secret Stranger Space' })
    assert.equal(none.isError, true)
    assert.match(none.text, /no workspace of yours is named "Secret Stranger Space" \(or a name starting with it\)\. Yours: .*"Wind Cup 2026"/)
    assert.doesNotMatch(none.text, new RegExp(foreign.id.slice(0, 8)))
    // too long for a name or an id: refused by the schema, with what is expected
    const long = await mcp.tool('find_context', { query: word, workspaceId: 'x'.repeat(101) })
    assert.equal(long.isError, true)
    assert.match(long.text, /expected a workspace id or name/)
  })
})
