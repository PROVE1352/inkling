// MCP tool surface, 0.15.1 (docs/adr/1940-* .. 1946-*): id arguments without patterns in the tool
// list, which kind each id field resolves as, the slimmed tools/list answer and outline lines. No database: the server is built with an inert
// context and listed in memory.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { z } from 'zod'
import { estimateTokens } from '../context/tokens'
import { FIELD_KINDS, idArg, isIdOrPrefix, planOf, planOfShape } from './idSchema'
import { slimToolListAnswer } from './toolList'

async function listTools() {
  const { buildMcpServer } = await import('../mcp')
  const server = buildMcpServer({
    app: {} as never,
    token: 'x',
    ip: '127.0.0.1',
    user: { id: '00000000-0000-4000-8000-000000000000', email: 'a@example.com', name: 'A' } as never,
    origin: 'https://notes.example.com',
    canWrite: true,
  })
  const [a, b] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'surface', version: '1' })
  await Promise.all([server.connect(a), client.connect(b)])
  const { tools } = await client.listTools()
  await client.close()
  return { tools, server }
}

describe('id arguments (docs/adr/1940-*)', () => {
  it('accepts full ids and 8–32 hex prefixes, with or without the dashes of a full id', () => {
    for (const ok of ['1a2b3c4d', '1A2B3C4D', '1a2b3c4d-5e6f', '1a2b3c4d5e6f7a8b', '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d', ' 1a2b3c4d ']) {
      assert.ok(isIdOrPrefix(ok), ok)
    }
    for (const bad of ['', '1a2b3c4', 'zzzzzzzz', 'root', '1a2b3c4d/x', '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d0', 'current']) {
      assert.ok(!isIdOrPrefix(bad), bad)
    }
  })

  it('the schema says which id is expected (better than "Invalid UUID")', () => {
    const r = z.object({ pageId: idArg('page') }).safeParse({ pageId: 'nope' })
    assert.equal(r.success, false)
    assert.match(r.error!.issues[0].message, /^expected a page id: the full id or its first 8\+ hex characters/)
    const full = z.object({ version: idArg('full') }).safeParse({ version: '1a2b3c4d' })
    assert.match(full.error!.issues[0].message, /expected a full id/)
  })

  it('plans follow optional, nullable, arrays, nested objects and unions; field names give uuid() its kind', async () => {
    const { uuid } = await import('./core')
    const shape = {
      pageId: uuid(),
      parentId: uuid().nullable().describe('x'),
      workspaceId: uuid().optional(),
      ids: z.array(idArg('page')),
      edits: z.array(z.object({ target: uuid().optional(), name: z.string() })),
      version: z.union([z.literal('current'), idArg('full')]),
      other: uuid(),
      title: z.string(),
    }
    const plan = Object.fromEntries(planOfShape(shape))
    assert.deepEqual(plan.pageId, { t: 'id', kind: 'page' })
    assert.deepEqual(plan.parentId, { t: 'id', kind: 'page' })
    assert.deepEqual(plan.workspaceId, { t: 'id', kind: 'workspace' })
    assert.deepEqual(plan.ids, { t: 'array', of: { t: 'id', kind: 'page' } })
    assert.deepEqual(plan.edits, { t: 'array', of: { t: 'object', fields: [['target', { t: 'id', kind: 'page' }]] } })
    assert.deepEqual(plan.version, { t: 'union', of: { t: 'id', kind: 'full' } })
    assert.deepEqual(plan.other, { t: 'id', kind: 'full' }, 'an unlisted uuid() field takes a full id only')
    assert.equal(plan.title, undefined)
    assert.equal(planOf(z.string(), 'pageId'), null, 'a plain string named pageId is not an id field')
  })

  it('every id field of every tool resolves as a known kind; no uuid() field falls back to "full" by accident', async () => {
    const { server } = await listTools()
    const registered = (server as unknown as { _registeredTools: Record<string, { inputSchema?: unknown }> })._registeredTools
    const seen: string[] = []
    const walk = (tool: string, plan: ReturnType<typeof planOf>, field: string) => {
      if (!plan) return
      if (plan.t === 'id') seen.push(`${tool}.${field}:${plan.kind}`)
      else if (plan.t === 'array' || plan.t === 'union') walk(tool, plan.of, field)
      else for (const [k, p] of plan.fields) walk(tool, p, k)
    }
    for (const [name, t] of Object.entries(registered)) {
      const inner = (t.inputSchema as { _zod?: { def?: { shape?: Record<string, unknown> } } })?._zod?.def?.shape ?? t.inputSchema
      for (const [field, plan] of planOfShape(inner)) walk(name, plan, field)
    }
    // full-id-only fields are the ones no tool prints short: versions and suggestions
    const full = seen.filter((s) => s.endsWith(':full')).sort()
    assert.deepEqual(full, ['diff_versions.from:full', 'diff_versions.to:full', 'restore_version.version:full', 'withdraw_suggestion.suggestionId:full'])
    assert.ok(seen.includes('patch_section.pageId:page'), 'patch_section (contextTools.ts) takes short page ids through the shared resolver')
    assert.ok(seen.includes('find_context.workspaceId:workspace'))
    assert.ok(seen.includes('restore_page.pageId:trashedPage'))
    assert.ok(seen.includes('reply_comment.threadId:thread'))
    for (const k of Object.values(FIELD_KINDS)) assert.ok(['page', 'workspace', 'thread'].includes(k))
  })
})

describe('tools/list (docs/adr/1945-*)', () => {
  it('no uuid patterns, no $schema, no default execution; the same bytes twice', async () => {
    const a = JSON.stringify((await listTools()).tools)
    const b = JSON.stringify((await listTools()).tools)
    assert.equal(a, b)
    assert.doesNotMatch(a, /"format":"uuid"|\[0-9a-fA-F\]\{8\}-/)
    assert.doesNotMatch(a, /"\$schema"/)
    assert.doesNotMatch(a, /"execution"/)
    // the fixed cost this release set out to cut (16,504 estimated tokens in 0.15.0)
    const tokens = estimateTokens(a)
    console.log(`[surface] tools/list ${a.length} chars, ~${tokens} tok`)
    assert.ok(tokens < 12_900, `tools/list ~${tokens} tok`)
  })

  it('only dialect-neutral JSON Schema keywords are used, so dropping $schema changes no meaning', async () => {
    const { tools } = await listTools()
    const allowed = new Set([
      'type', 'properties', 'required', 'description', 'enum', 'const', 'anyOf', 'items', 'minimum', 'maximum',
      'minLength', 'maxLength', 'minItems', 'maxItems', 'pattern', 'propertyNames', 'additionalProperties', 'default',
      'exclusiveMinimum', 'exclusiveMaximum',
    ])
    const bad = new Set<string>()
    const walk = (s: unknown, inProps = false) => {
      if (!s || typeof s !== 'object') return
      if (Array.isArray(s)) return s.forEach((x) => walk(x))
      for (const [k, v] of Object.entries(s)) {
        if (inProps) walk(v)
        else {
          if (!allowed.has(k)) bad.add(k)
          if (k === 'items' && Array.isArray(v)) bad.add('items[] (tuple)')
          walk(v, k === 'properties')
        }
      }
    }
    for (const t of tools) walk(t.inputSchema)
    assert.deepEqual([...bad], [])
  })

  it('slimToolListAnswer drops only the defaults', () => {
    const out = slimToolListAnswer({
      tools: [
        { name: 'a', inputSchema: { $schema: 'x', type: 'object' }, execution: { taskSupport: 'forbidden' } },
        { name: 'b', inputSchema: { type: 'object' }, execution: { taskSupport: 'optional' } },
      ],
    })
    assert.deepEqual(out.tools, [
      { name: 'a', inputSchema: { type: 'object' } },
      { name: 'b', inputSchema: { type: 'object' }, execution: { taskSupport: 'optional' } },
    ])
  })
})

describe('outline lines and anchors (docs/adr/1942-*)', () => {
  it('one line per section: indent by depth, full anchor, no repeated heading text', async () => {
    const { outlineLines, outlineVersion } = await import('../mcp')
    const sections = [
      { anchor: '_intro', headingPath: '', tokens: 3, version: 'v0' },
      { anchor: '요강-요약', headingPath: '요강 요약', tokens: 1, version: 'v1' },
      { anchor: '요강-요약/판결-입력-scripts-verdict-py-재판결용-원본-이후-수정-금지', headingPath: '요강 요약 › 판결 입력 (scripts/verdict.py 재판결용, 원본 이후 수정 금지)', tokens: 9, version: 'v2' },
      { anchor: 'alpha/decided', headingPath: 'Alpha › Decided', tokens: 2, version: 'v3' },
      { anchor: 'section', headingPath: '🚀', tokens: 1, version: 'v5' },
    ]
    assert.deepEqual(outlineLines(sections, () => null), [
      '- §_intro ~3 tok v=v0',
      '- §요강-요약 ~1 tok v=v1',
      ' - §요강-요약/판결-입력-scripts-verdict-py-재판결용-원본-이후-수정-금지 ~9 tok v=v2',
      ' - §alpha/decided ~2 tok v=v3',
      '- §section ~1 tok v=v5 (🚀)',
    ])
    const v = outlineVersion({ page: { id: 'p', title: 'T', kind: 'doc' }, sections })
    assert.equal(v, outlineVersion({ page: { id: 'p', title: 'T', kind: 'doc' }, sections: sections.map((s) => ({ ...s })) }))
    assert.notEqual(v, outlineVersion({ page: { id: 'p', title: 'T2', kind: 'doc' }, sections }))
  })
})
