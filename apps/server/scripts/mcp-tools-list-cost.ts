/**
 * Fixed MCP cost: the tools/list answer and the server instructions every client puts into the
 * model's context before the first call (0.15.1, docs/adr/1940-*). Not part of CI; no database.
 *
 *   cd apps/server
 *   npx tsx scripts/mcp-tools-list-cost.ts [--json] [--by-tool] [--profile core|full] [--surface]
 *
 * --profile picks the tool profile of the connection (docs/adr/2000-*; default full). --surface also
 * measures the rest of what a client receives before the first call (0.16, docs/adr/2001-*, 2002-*):
 * the initialize result (capabilities, server info, instructions), resources/templates/list and
 * prompts/list. resources/list needs a database (pages); its size per entry is measured by the
 * [db] test mcpTools/resourcesPrompts.db.test.ts.
 *
 * Builds the MCP server for a read-write connection with an inert context, connects an in-memory
 * client and measures `JSON.stringify(tool)` of every listed tool (what the SDK sends, minus the
 * JSON-RPC envelope) with the server's estimator (context/tokens.ts: ASCII/4, Hangul 1, other 1/2),
 * split into description and inputSchema. Counts are exact for the build; nothing is random.
 */
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.DATABASE_URL ||= 'postgres://nobody:nobody@127.0.0.1:1/none'
process.env.DATA_DIR ||= `${process.env.TMPDIR || '/tmp'}/inkling-toolcost-${process.pid}`

async function main() {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js')
  const { buildMcpServer, SERVER_INSTRUCTIONS } = await import('../src/mcp')
  const { estimateTokens } = await import('../src/context/tokens')
  const pi = process.argv.indexOf('--profile')
  const profile = (pi > 0 ? process.argv[pi + 1] : 'full') as 'core' | 'full'
  if (profile !== 'core' && profile !== 'full') throw new Error('--profile core|full')
  const ctx = {
    profile,
    app: {} as never,
    token: 'x',
    ip: '127.0.0.1',
    user: { id: '00000000-0000-4000-8000-000000000000', email: 'a@example.com', name: 'A', scope: 'mcp' } as never,
    origin: 'https://notes.example.com',
    canWrite: true,
  }
  const server = buildMcpServer(ctx)
  const [a, b] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'cost', version: '1' })
  // the initialize result as the client receives it (the server's answer to `initialize`)
  let initResult: unknown = null
  const origSend = a.send.bind(a)
  a.send = async (m, o) => {
    if ('result' in m && m.id === 0) initResult = m.result
    return origSend(m, o)
  }
  await Promise.all([server.connect(a), client.connect(b)])
  const { tools } = await client.listTools()
  const instructions = client.getInstructions() ?? ''
  const rows = tools.map((t) => {
    const all = JSON.stringify(t)
    const schema = JSON.stringify(t.inputSchema ?? {})
    const desc = t.description ?? ''
    return {
      name: t.name,
      chars: all.length,
      tokens: estimateTokens(all),
      descTokens: estimateTokens(desc),
      schemaTokens: estimateTokens(schema),
      uuidPatterns: (schema.match(/"pattern":"\^\(\[0-9a-fA-F\]\{8\}/g) ?? []).length,
    }
  })
  const whole = JSON.stringify(tools)
  const sum = (k: 'chars' | 'tokens' | 'descTokens' | 'schemaTokens' | 'uuidPatterns') => rows.reduce((s, r) => s + r[k], 0)
  const totals = {
    tools: tools.length,
    chars: whole.length,
    tokens: estimateTokens(whole),
    descTokens: sum('descTokens'),
    schemaTokens: sum('schemaTokens'),
    uuidPatterns: sum('uuidPatterns'),
    instructionsChars: instructions.length,
    instructionsTokens: estimateTokens(instructions),
    serverInstructionsTokens: estimateTokens(SERVER_INSTRUCTIONS),
  }
  let surface: Record<string, { chars: number; tokens: number; items?: number }> | null = null
  if (process.argv.includes('--surface')) {
    const m = (v: unknown, items?: number) => ({ chars: JSON.stringify(v).length, tokens: estimateTokens(JSON.stringify(v)), ...(items !== undefined ? { items } : {}) })
    const caps = client.getServerCapabilities()
    const templates = caps?.resources ? (await client.listResourceTemplates()).resourceTemplates : []
    const prompts = caps?.prompts ? (await client.listPrompts()).prompts : []
    surface = {
      initialize: m(initResult),
      capabilities: m(caps ?? {}),
      resourceTemplates: m(templates, templates.length),
      prompts: m(prompts, prompts.length),
    }
  }
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ profile, totals, rows, ...(surface ? { surface } : {}) }, null, 1))
  } else {
    console.log(`tools/list: ${totals.tools} tools, ${totals.chars} chars, ~${totals.tokens} tok (descriptions ~${totals.descTokens}, schemas ~${totals.schemaTokens}); uuid patterns: ${totals.uuidPatterns}`)
    console.log(`profile: ${profile}`)
    console.log(`instructions: ${totals.instructionsChars} chars, ~${totals.instructionsTokens} tok`)
    if (surface) for (const [k, v] of Object.entries(surface)) console.log(`${k}: ${v.chars} chars, ~${v.tokens} tok${v.items !== undefined ? ` (${v.items})` : ''}`)
    if (process.argv.includes('--by-tool')) {
      console.log('| tool | chars | tok | desc tok | schema tok | uuid patterns |')
      console.log('|---|---|---|---|---|---|')
      for (const r of [...rows].sort((x, y) => y.tokens - x.tokens)) {
        console.log(`| ${r.name} | ${r.chars} | ${r.tokens} | ${r.descTokens} | ${r.schemaTokens} | ${r.uuidPatterns} |`)
      }
    }
  }
  await client.close()
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
