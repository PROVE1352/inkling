/**
 * Per-call output cost of the 0.15.1 MCP output changes (docs/adr/1942-*, 1944-*, 1946-*). Not CI.
 *
 *   cd apps/server
 *   DATABASE_URL=postgres://…/scratch npx tsx scripts/mcp-output-cost.ts
 *
 * Uses a migrated SCRATCH database (inserts pages, never cleans up). Seeds the evaluation wiki
 * (context/evalSet.ts ALL_EVAL_PAGES, padded with padPages: 6 extra sections per page, like
 * context.db.test) into a fresh workspace through create_page, then for every page:
 *   - outline: the 0.15.1 answer vs the 0.15.0 lines rebuilt from the same route answer
 *     (`- §<full anchor>  <heading path>  ~N tok  v=…` + the old header), and a repeat with known=;
 *   - full read: the header before the body (0.15.1 vs the 0.15.0 header rebuilt from the same facts:
 *     36-character id, workspaceId, parentId, wrapper id);
 * and once: list_pages and search with no format (0.15.1 compact) vs format json (0.15.0 default).
 * Tokens: context/tokens.ts estimateTokens (ASCII/4, Hangul 1, other 1/2), both sides.
 */
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.DATA_DIR ||= `${process.env.TMPDIR || '/tmp'}/inkling-outputcost-${process.pid}`

async function main() {
  const h = await import('../src/mcpTools/testHarness')
  const { closeDb } = await import('../src/db/index')
  const { ALL_EVAL_PAGES, padPages } = await import('../src/context/evalSet')
  const { estimateTokens } = await import('../src/context/tokens')
  const collab = await import('../src/collab')
  const app = await h.buildTestApp()
  const owner = await h.makeUser('bench')
  const ws = await h.makeWorkspace(owner)
  const mcp = await h.connectMcp(app, owner, await h.mintToken(owner), { user: { ...owner, via: 'Bench' } })
  const pages = padPages(ALL_EVAL_PAGES)
  const ids: string[] = []
  for (const p of pages) {
    const r = await mcp.tool('create_page', { workspaceId: ws.id, title: p.title, markdown: p.markdown })
    if (r.isError) throw new Error(r.text)
    ids.push((JSON.parse(r.text) as { id: string }).id)
  }
  const sum = { outlineOld: 0, outlineNew: 0, outlineKnown: 0, headOld: 0, headNew: 0, sections: 0, uuidsOld: 0, uuidsNew: 0 }
  const uuidCount = (s: string) => (s.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g) ?? []).length
  for (const id of ids) {
    const route = (await app.inject({ method: 'GET', url: `/api/pages/${id}/outline`, headers: { cookie: owner.cookie } })).json() as {
      page: { id: string; title: string; kind: string; updatedAt?: string }
      sections: { anchor: string; headingPath: string; tokens: number; version: string }[]
      tokens: number
    }
    const now = (await mcp.tool('read_page', { pageId: id, outline: true })).text
    const old = [
      `# ${route.page.title}`,
      `(page ${route.page.id}, ${route.page.kind}${route.page.updatedAt ? `, updated ${route.page.updatedAt.slice(0, 10)}` : ''}, ~${route.tokens} tok)`,
      now.split('\n')[2], // can: line, unchanged
      ...route.sections.map((s) => `- §${s.anchor}  ${s.headingPath || '(intro)'}  ~${s.tokens} tok  v=${s.version}`),
    ].join('\n')
    sum.outlineOld += estimateTokens(old)
    sum.outlineNew += estimateTokens(now)
    sum.sections += route.sections.length
    const v = /, v=([0-9a-f]{12})\)/.exec(now)![1]
    sum.outlineKnown += estimateTokens((await mcp.tool('read_page', { pageId: id, outline: true, known: v })).text)
    // full read: everything but the body
    const full = (await mcp.tool('read_page', { pageId: id })).text
    const i = full.indexOf('<untrusted_content')
    const j = full.indexOf('>', i)
    const headNew = full.slice(0, j + 1) + full.slice(full.lastIndexOf('</untrusted_content>'))
    const headOld = headNew
      .replace(`- id: ${id.slice(0, 8)}`, `- id: ${id}`)
      .replace(`- workspaceId: ${ws.id.slice(0, 8)}`, `- workspaceId: ${ws.id}`)
      .replace(` id="${id.slice(0, 8)}"`, ` id="${id}"`)
    sum.headOld += estimateTokens(headOld)
    sum.headNew += estimateTokens(headNew)
    sum.uuidsOld += uuidCount(headOld)
    sum.uuidsNew += uuidCount(headNew)
  }
  const listNew = estimateTokens((await mcp.tool('list_pages', { workspaceId: ws.id })).text)
  const listOld = estimateTokens((await mcp.tool('list_pages', { workspaceId: ws.id, format: 'json' })).text)
  const searchNew = estimateTokens((await mcp.tool('search', { query: 'deploy', workspaceId: ws.id })).text)
  const searchOld = estimateTokens((await mcp.tool('search', { query: 'deploy', workspaceId: ws.id, format: 'json' })).text)
  const pct = (a: number, b: number) => `${(((b - a) / a) * 100).toFixed(1)}%`
  console.log(`pages ${ids.length}, sections ${sum.sections}`)
  console.log(`outline: 0.15.0 ${sum.outlineOld} tok, 0.15.1 ${sum.outlineNew} tok (${pct(sum.outlineOld, sum.outlineNew)}); repeat with known= ${sum.outlineKnown} tok (${pct(sum.outlineOld, sum.outlineKnown)})`)
  console.log(`full read header+wrapper: 0.15.0 ${sum.headOld} tok, 0.15.1 ${sum.headNew} tok (${pct(sum.headOld, sum.headNew)}); full uuids ${sum.uuidsOld} → ${sum.uuidsNew}`)
  console.log(`list_pages default: json ${listOld} tok → compact ${listNew} tok (${pct(listOld, listNew)})`)
  console.log(`search "deploy" default: json ${searchOld} tok → compact ${searchNew} tok (${pct(searchOld, searchNew)})`)
  await mcp.close()
  await collab.destroyCollab()
  await app.close()
  await closeDb()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
