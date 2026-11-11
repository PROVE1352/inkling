// MCP tool annotations (docs/adr/2460-*): every registered tool, in both profiles, states the four
// hints of the MCP ToolAnnotations type, from the one table in annotations.ts. No database: the
// server is built with an inert context and listed in memory. The read-only connection check is
// toolAnnotations.db.test.ts.
// Run alone: cd apps/server && node --import tsx --test --test-reporter=spec src/mcpTools/toolAnnotations.test.ts
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { annotateTools, annotationsOf, TOOL_ANNOTATIONS } from './annotations'
import { renderToolSpec } from './profiles'

const HINTS = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']

async function listed(profile: 'core' | 'full') {
  const { buildMcpServer } = await import('../mcp')
  const server = buildMcpServer({
    app: {} as never,
    token: 'x',
    ip: '127.0.0.1',
    user: { id: '00000000-0000-4000-8000-000000000000', email: 'a@example.com', name: 'A' } as never,
    origin: 'https://notes.example.com',
    canWrite: true,
    profile,
  })
  const [a, b] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'annotations', version: '1' })
  await Promise.all([server.connect(a), client.connect(b)])
  const { tools } = await client.listTools()
  const registered = Object.keys((server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools)
  await client.close()
  return { tools, registered }
}

describe('tool annotations (docs/adr/2460-*)', () => {
  it('every listed tool, in both profiles, has exactly the four hints as booleans, from the table', async () => {
    for (const profile of ['full', 'core'] as const) {
      const { tools } = await listed(profile)
      assert.ok(tools.length > 0)
      for (const t of tools) {
        const a = t.annotations as Record<string, unknown> | undefined
        assert.ok(a, `${t.name} (${profile}) has no annotations: add a row to mcpTools/annotations.ts`)
        // the order is part of the listed bytes (docs/adr/1543-*); no title (docs/adr/2460-*)
        assert.deepEqual(Object.keys(a), HINTS, `${t.name} (${profile})`)
        for (const k of HINTS) assert.equal(typeof a[k], 'boolean', `${t.name}.${k}`)
        assert.deepEqual(a, TOOL_ANNOTATIONS[t.name], t.name)
      }
    }
  })

  it('the table has one row per registered tool (48 tools and more_tools), no more', async () => {
    const full = await listed('full')
    const core = await listed('core')
    const registered = new Set([...full.registered, ...core.registered])
    assert.equal(full.tools.length, 48)
    assert.ok(registered.has('more_tools'))
    assert.deepEqual([...registered].sort(), Object.keys(TOOL_ANNOTATIONS).sort())
  })

  it('the hints agree with each other', () => {
    for (const [name, a] of Object.entries(TOOL_ANNOTATIONS)) {
      // a read-only tool updates nothing: the two write hints keep false (idempotent: the spec default)
      if (a.readOnlyHint) assert.ok(!a.destructiveHint && !a.idempotentHint, name)
      // no tool reaches a destination the agent picks (ADR 2460, openWorldHint)
      assert.equal(a.openWorldHint, false, name)
    }
    const count = (f: (a: (typeof TOOL_ANNOTATIONS)[string]) => boolean) => Object.values(TOOL_ANNOTATIONS).filter(f).length
    // the split the ADR records; a change here is a change of a verdict and belongs in the ADR
    assert.equal(count((a) => a.readOnlyHint), 20)
    assert.equal(count((a) => !a.readOnlyHint && a.destructiveHint), 11)
    assert.equal(count((a) => !a.readOnlyHint && !a.destructiveHint), 18)
  })

  it('a tool without a row, or with its own annotations, stops the build', () => {
    assert.throws(() => annotationsOf('no_such_tool'), /no row for tool "no_such_tool"/)
    assert.throws(() => annotationsOf('constructor'), /no row for tool "constructor"/)
    const unknown = new McpServer({ name: 't', version: '1' })
    unknown.registerTool('no_such_tool', { description: 'x' }, async () => ({ content: [] }))
    assert.throws(() => annotateTools(unknown), /no row for tool "no_such_tool"/)
    const inline = new McpServer({ name: 't', version: '1' })
    inline.registerTool('search', { description: 'x', annotations: { readOnlyHint: true } }, async () => ({ content: [] }))
    assert.throws(() => annotateTools(inline), /sets its own annotations/)
  })

  it('every tool gets its own copy (changing one does not change the table)', () => {
    const a = annotationsOf('search')
    a.readOnlyHint = false
    assert.equal(TOOL_ANNOTATIONS.search.readOnlyHint, true)
  })

  it('more_tools(tool) prints the hints that are true', () => {
    assert.match(renderToolSpec({ name: 'rename_page', annotations: { ...annotationsOf('rename_page') } }), /^rename_page \(destructive, idempotent\): /)
    assert.match(renderToolSpec({ name: 'list_trash', annotations: { ...annotationsOf('list_trash') } }), /^list_trash \(readOnly\): /)
    assert.match(renderToolSpec({ name: 'create_view', annotations: { ...annotationsOf('create_view') } }), /^create_view: /)
  })
})
