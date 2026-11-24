// changes_since takes the cursor line as printed (`cursor: …`, `next cursor: …`, `fresh cursor: …`,
// any case, any spaces after the colon) as well as the bare token; other strings fail as before.
// Run: cd apps/server && DATABASE_URL=postgres://… node --import tsx --test src/mcpTools/changesSinceCursorLine.db.test.ts
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.APP_URL ||= 'https://notes.example.com'

import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'

const HAS_DB = !!process.env.DATABASE_URL

describe('[db] changes_since cursor line', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const h = await import('./testHarness')
  const { closeDb } = await import('../db/index')
  const { drainChangeLog } = await import('../context/changeLog')
  const { encodeCursor } = await import('../context/changeFeed')
  const app = await h.buildTestApp()
  const alice = await h.makeUser('alice')
  const ws = await h.makeWorkspace(alice)
  const mcp = await h.connectMcp(app, alice, await h.mintToken(alice))
  after(async () => {
    await mcp.close()
    await app.close()
    await closeDb()
  })

  const lastLine = (t: string) => t.trimEnd().split('\n').at(-1) ?? ''
  // The answer without its last line: the next cursor carries the server-wide sequence, which other
  // test files running against the same database move between two calls.
  const body = (r: { text: string; isError: boolean }) => ({ isError: r.isError, text: r.text.trimEnd().split('\n').slice(0, -1).join('\n') })
  const tokenOf = (line: string) => {
    const m = /cursor: (\S+)$/.exec(line)
    assert.ok(m, `no cursor in: ${line}`)
    return m[1]
  }

  it('token, `cursor: token`, `Cursor:token` and the printed `next cursor:` line give the same answer', async () => {
    const start = await mcp.tool('changes_since', { workspaceId: ws.id })
    assert.equal(start.isError, false, start.text)
    const startLine = lastLine(start.text)
    assert.match(startLine, /^cursor: \S+$/)
    const token = tokenOf(startLine)
    await mcp.tool('create_page', { workspaceId: ws.id, title: 'Cursor line', markdown: '## A\n\nHello.' })
    await drainChangeLog()

    const plain = await mcp.tool('changes_since', { workspaceId: ws.id, cursor: token })
    assert.equal(plain.isError, false, plain.text)
    assert.match(plain.text, /Cursor line/)
    for (const cursor of [startLine, `Cursor:${token}`, `CURSOR:   ${token}`]) {
      const r = await mcp.tool('changes_since', { workspaceId: ws.id, cursor })
      assert.deepEqual(body(r), body(plain), cursor)
      assert.match(lastLine(r.text), /^next cursor: \S+$/, cursor)
    }
    // the line every normal answer ends with, passed whole
    const nextLine = lastLine(plain.text)
    assert.match(nextLine, /^next cursor: \S+$/)
    const viaLine = await mcp.tool('changes_since', { workspaceId: ws.id, cursor: nextLine })
    const viaToken = await mcp.tool('changes_since', { workspaceId: ws.id, cursor: tokenOf(nextLine) })
    assert.equal(viaLine.isError, false, viaLine.text)
    assert.deepEqual(body(viaLine), body(viaToken))
  })

  it('the longest valid token with the longest label fits the argument limit', async () => {
    const longest = encodeCursor({ seq: 999_999_999_999_999, at: 999_999_999_999_999, ws: ws.id })
    assert.ok(longest.length >= 95, String(longest.length))
    const r = await mcp.tool('changes_since', { workspaceId: ws.id, cursor: `fresh cursor: ${longest}` })
    // accepted by the schema; the server then judges the cursor itself (far in the future: not an argument error)
    assert.doesNotMatch(r.text, /Input validation|too_big|at most 200/i, r.text)
  })

  it('other strings fail as before', async () => {
    for (const cursor of ['not-a-cursor', 'cursor:', 'next: abc', 'cursor: !!!']) {
      const r = await mcp.tool('changes_since', { workspaceId: ws.id, cursor })
      assert.equal(r.isError, true, `${cursor}: ${r.text}`)
      assert.match(r.text, /invalid cursor: call changes_since without a cursor to get a fresh one/, `${cursor}: ${r.text}`)
    }
  })
})
