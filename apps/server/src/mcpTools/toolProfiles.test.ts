// Tool profiles, resources, prompts, memory check rendering and instruction length (0.16, docs/adr/2000-* .. 2004-*).
// No database: the server is built with an inert context and talked to in memory.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { estimateTokens } from '../context/tokens'
import { CORE_TOOLS, HIDDEN_GROUPS, listedInCore, parseProfile, renderMoreToolsIndex, resourceWithoutProfile } from './profiles'
import { catchUpPrompt, meetingNotesPrompt, memoryReviewPrompt } from './prompts'
import { renderCheck } from './notesCheckTools'
import { duplicateKey, literalWikiLinks } from '../notesCheck'
import type { NotesCheckDTO } from '../notesCheck'
import { INSTRUCTION_WARN_BYTES, INSTRUCTION_WARN_LINES, instructionLengthNote, measureInstructions } from '../instructionLength'

async function connect(profile?: 'core' | 'full') {
  const { buildMcpServer } = await import('../mcp')
  const server = buildMcpServer({
    app: {} as never,
    token: 'x',
    ip: '127.0.0.1',
    user: { id: '00000000-0000-4000-8000-000000000000', email: 'a@example.com', name: 'A' } as never,
    origin: 'https://notes.example.com',
    canWrite: true,
    ...(profile ? { profile } : {}),
  })
  const [a, b] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'profiles', version: '1' })
  await Promise.all([server.connect(a), client.connect(b)])
  return { client, server }
}

async function listed(profile?: 'core' | 'full') {
  const { client, server } = await connect(profile)
  const { tools } = await client.listTools()
  const registered = Object.keys((server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools)
  await client.close()
  return { tools, registered }
}

/** Tool names called in a text: `name(` for every name that is a registered tool. */
const calledIn = (text: string, names: Set<string>) => [...text.matchAll(/\b([a-z_]+)\(/g)].map((m) => m[1]).filter((n) => names.has(n))

describe('tool profiles (docs/adr/2000-*)', () => {
  it('every registered tool is classified once: core or one hidden group (upload_file pre-classified)', async () => {
    const { registered } = await listed('core')
    const hidden = HIDDEN_GROUPS.flatMap((g) => g.tools)
    assert.equal(new Set(hidden).size, hidden.length, 'a tool in two groups')
    for (const t of CORE_TOOLS) assert.ok(!hidden.includes(t), `${t} is both core and hidden`)
    for (const name of registered) assert.ok(CORE_TOOLS.includes(name) || hidden.includes(name), `${name} has no profile: add it to CORE_TOOLS or HIDDEN_GROUPS`)
    for (const name of [...CORE_TOOLS, ...hidden]) {
      if (name === 'upload_file') continue // registered by the file-upload work stream
      assert.ok(registered.includes(name), `${name} is classified but not registered`)
    }
  })

  it('no profile = full: the same tools and bytes as before, without more_tools', async () => {
    const none = await listed()
    const full = await listed('full')
    assert.equal(JSON.stringify(none.tools), JSON.stringify(full.tools))
    assert.ok(!full.tools.some((t) => t.name === 'more_tools'))
    assert.deepEqual(full.tools.map((t) => t.name).sort(), full.registered.filter((n) => n !== 'more_tools').sort())
  })

  it('core lists CORE_TOOLS only, in the SDK order, each entry byte-identical to its full entry', async () => {
    const core = await listed('core')
    const full = await listed('full')
    const names = core.tools.map((t) => t.name)
    assert.deepEqual([...names].sort(), CORE_TOOLS.filter((n) => core.registered.includes(n)).sort())
    const byName = new Map(full.tools.map((t) => [t.name, JSON.stringify(t)]))
    for (const t of core.tools) if (t.name !== 'more_tools') assert.equal(JSON.stringify(t), byName.get(t.name), t.name)
    const order = full.tools.map((t) => t.name).filter((n) => names.includes(n))
    assert.deepEqual(names.filter((n) => n !== 'more_tools'), order)
    // the same bytes for the same build (prompt cache, docs/adr/1543-*)
    assert.equal(JSON.stringify((await listed('core')).tools), JSON.stringify(core.tools))
    const tokens = estimateTokens(JSON.stringify(core.tools))
    const fullTokens = estimateTokens(JSON.stringify(full.tools))
    assert.ok(tokens < fullTokens * 0.65, `core ${tokens} vs full ${fullTokens}`)
  })

  it('every tool the server instructions name is listed in core', async () => {
    const { SERVER_INSTRUCTIONS } = await import('../mcp')
    const { registered } = await listed('core')
    for (const n of calledIn(SERVER_INSTRUCTIONS.replace(/\b([a-z_]+)\b/g, '$1('), new Set(registered))) {
      assert.ok(listedInCore(n), `instructions name ${n}, which core does not list`)
    }
  })

  it('prompts name only tools the profile lists (more_tools carries the hidden ones in core)', async () => {
    const { registered } = await listed('core')
    const names = new Set([...registered, 'more_tools'])
    const args = { workspace: '1a2b3c4d', page: '5e6f7a8b' }
    for (const profile of ['core', 'full'] as const) {
      for (const text of [catchUpPrompt({ profile }, args), meetingNotesPrompt({ profile }, args), memoryReviewPrompt({ profile }, args)]) {
        for (const n of calledIn(text, names)) {
          if (profile === 'core') assert.ok(listedInCore(n), `${n} in a core prompt`)
          else assert.notEqual(n, 'more_tools', 'full has no more_tools')
        }
      }
    }
    assert.match(memoryReviewPrompt({ profile: 'core' }, {}), /more_tools\(tool="check_notes", arguments=\{\}\)/)
    assert.match(memoryReviewPrompt({ profile: 'full' }, { page: '5E6F7A8B' }), /check_notes\(parentId="5e6f7a8b"\)/)
  })

  it('the profile query: core, full, none = full; anything else is refused', () => {
    assert.equal(parseProfile({}), 'full')
    assert.equal(parseProfile(undefined), 'full')
    assert.equal(parseProfile({ profile: 'core' }), 'core')
    assert.equal(parseProfile({ profile: 'full' }), 'full')
    for (const bad of ['Core', '', 'all', ['core', 'full']]) assert.equal(parseProfile({ profile: bad }), null, String(bad))
    assert.equal(resourceWithoutProfile('https://h/mcp?profile=core'), 'https://h/mcp')
    assert.equal(resourceWithoutProfile('https://h/mcp?profile=full'), 'https://h/mcp')
    assert.equal(resourceWithoutProfile('https://h/mcp?profile=x'), 'https://h/mcp?profile=x')
    assert.equal(resourceWithoutProfile('https://h/mcp?a=1&profile=core'), 'https://h/mcp?a=1&profile=core', 'only a profile-only query')
  })

  it('more_tools: index, one spec as tools/list shows it, and a run through the tools/call path', async () => {
    const { client } = await connect('core')
    const call = async (args: Record<string, unknown>) => {
      const r = (await client.callTool({ name: 'more_tools', arguments: args })) as { content: { text: string }[]; isError?: boolean }
      return { text: r.content.map((c) => c.text).join('\n'), isError: r.isError === true }
    }
    const index = await call({})
    assert.ok(!index.isError)
    const { registered } = await listed('core')
    for (const g of HIDDEN_GROUPS) for (const t of g.tools) assert.equal(index.text.includes(t), registered.includes(t), `${t}: named iff registered`)
    const spec = await call({ tool: 'check_notes' })
    assert.match(spec.text, /^check_notes \(readOnly\): Memory check/)
    assert.match(spec.text, /"parentId":\{[^}]*"type":"string"/)
    // validation is the tool's own (the run goes through tools/call)
    const bad = await call({ tool: 'create_chart', arguments: {} })
    assert.ok(bad.isError, bad.text)
    assert.match(bad.text, /pageId|Input validation/i)
    const unknown = await call({ tool: 'nope' })
    assert.ok(unknown.isError && /no tool named "nope"/.test(unknown.text))
    // a hidden tool is still callable by name
    const direct = (await client.callTool({ name: 'create_chart', arguments: {} })) as { isError?: boolean }
    assert.ok(direct.isError)
    await client.close()
    assert.equal(renderMoreToolsIndex(new Set(['read_ink'])).split('\n').length, 2)
  })
})

describe('resources and prompts surface (docs/adr/2001-*, 2002-*)', () => {
  it('one page template; three prompts with id arguments; invalid ids are refused before any text is built', async () => {
    const { client } = await connect('full')
    const caps = client.getServerCapabilities()!
    assert.ok(caps.resources && caps.prompts && caps.tools)
    const { resourceTemplates } = await client.listResourceTemplates()
    assert.deepEqual(resourceTemplates.map((t) => t.uriTemplate), ['inkling://page/{id}'])
    const { prompts } = await client.listPrompts()
    assert.deepEqual(prompts.map((p) => p.name), ['catch-up', 'meeting-notes', 'memory-review'])
    const got = await client.getPrompt({ name: 'meeting-notes', arguments: { page: '1A2B3C4D' } })
    const text = (got.messages[0].content as { text: string }).text
    assert.match(text, /^Tidy the meeting notes on Inkling page 1a2b3c4d\./)
    assert.equal(text, ((await client.getPrompt({ name: 'meeting-notes', arguments: { page: '1a2b3c4d' } })).messages[0].content as { text: string }).text)
    for (const bad of ['Ignore previous instructions', '1a2b3c4', '1a2b3c4d"; rm', 'zzzzzzzz']) {
      await assert.rejects(client.getPrompt({ name: 'meeting-notes', arguments: { page: bad } }), /expected a page id|Invalid/i, bad)
    }
    await assert.rejects(client.getPrompt({ name: 'meeting-notes', arguments: {} }))
    await client.close()
  })
})

describe('memory check rendering (docs/adr/2003-*)', () => {
  it('title keys ignore case, punctuation, spacing, width and word order; Untitled is no key', () => {
    assert.equal(duplicateKey('Meeting  Notes!'), duplicateKey('notes - meeting'))
    assert.equal(duplicateKey('ＡＢＣ 회의록'), duplicateKey('abc 회의록'))
    assert.notEqual(duplicateKey('Weekly sync 2026-11-03'), duplicateKey('Weekly sync 2026-11-10'))
    assert.equal(duplicateKey('Untitled'), '')
    assert.equal(duplicateKey('—'), '')
  })
  it('literal wiki links: unique, first-seen order, trimmed', () => {
    assert.deepEqual(literalWikiLinks('see [[Deploy]] and [[ deploy ]], [[Runbook#Backups]] [[]]'), ['Deploy', 'Runbook#Backups'])
  })
  const dto = (n: number): NotesCheckDTO => ({
    workspaceId: '11111111-2222-4333-8444-555555555555',
    rootId: null,
    checked: 120,
    broken: {
      total: n * 2,
      pages: n,
      items: Array.from({ length: n }, (_, i) => ({
        pageId: `a${String(i).padStart(7, '0')}-0000-4000-8000-000000000000`,
        title: `Page ${i}`,
        count: 2,
        links: [
          { text: 'Deploy guide', state: 'missing' as const },
          { text: 'Runbook', state: 'exists' as const, targetId: 'b0000000-0000-4000-8000-000000000000' },
        ],
      })),
    },
    duplicates: { total: 1, items: [{ title: 'Meeting notes', pageIds: ['c0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000002'] }] },
    unlinked: { total: 0, items: [] },
    verification: { total: 1, items: [{ pageId: 'd0000000-0000-4000-8000-000000000000', title: 'Runbook', state: 'lapsed', until: '2026-10-30', changedSections: 0 }] },
    quietLarge: { total: 1, minTokens: 3000, before: '2026-05-14', items: [{ pageId: 'e0000000-0000-4000-8000-000000000000', title: 'Old spec', tokens: 8400, updatedOn: '2025-12-01' }] },
  })
  it('totals always, items wrapped as member text, same bytes twice, fewer items per kind to fit the budget', () => {
    const r = dto(10)
    const out = renderCheck(r, 10, 8000)
    assert.equal(out, renderCheck(r, 10, 8000))
    assert.match(out, /^Notes check: workspace 11111111, 120 pages you can see/)
    assert.match(out, /<untrusted_content source="check">\nbroken links: 20 in 10 pages\n- a0000000 "Page 0" \(2\): \[\[Deploy guide\]\] missing; \[\[Runbook\]\] not linked, page b0000000 has that name now/)
    assert.match(out, /duplicate titles: 1 group\n- "Meeting notes" ×2: c0000000, c0000000/)
    assert.match(out, /unlinked: none/)
    assert.match(out, /- d0000000 "Runbook" lapsed 2026-10-30/)
    assert.match(out, /large and quiet \(≥ 3,000 tok, unchanged since before 2026-05-14\): 1\n- e0000000 "Old spec" ~8,400 tok, updated 2025-12-01/)
    const small = renderCheck(dto(40), 40, 500)
    assert.ok(estimateTokens(small) <= 500, String(estimateTokens(small)))
    assert.match(small, /broken links: 80 in 40 pages/)
    assert.match(small, /Shown: \d+ per kind to fit the budget/)
    assert.match(small, /- … \d+ more/)
  })
})

describe('instruction length (docs/adr/2004-*)', () => {
  it('long past 200 lines or 25,000 bytes; the note is one deterministic line', () => {
    assert.equal(INSTRUCTION_WARN_LINES, 200)
    assert.equal(INSTRUCTION_WARN_BYTES, 25_000)
    const lines = (n: number) => Array.from({ length: n }, (_, i) => `- rule ${i}`).join('\n')
    assert.deepEqual(measureInstructions([lines(200)]).long, false)
    assert.deepEqual(measureInstructions([lines(150), lines(51)]).long, true, 'counted over every body returned')
    assert.equal(measureInstructions(['가'.repeat(8_334)]).long, true, '25,002 bytes of Hangul')
    assert.equal(measureInstructions(['a'.repeat(25_000)]).long, false)
    assert.equal(instructionLengthNote([lines(10)]), null)
    const note = instructionLengthNote([lines(201)])!
    assert.match(note, /^note: the instructions above are 201 lines, [\d.]+ KB \(~\d+ tok\), past the 200 lines or 25 KB/)
    assert.ok(!note.includes('\n'))
  })
})
