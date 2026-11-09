/**
 * MCP token-saving bench (0.12 step 2, docs/adr/1540-* .. 1543-*). Not part of CI.
 *
 *   cd apps/server
 *   DATABASE_URL=postgres://…/scratch npx tsx scripts/mcp-token-bench.ts [--questions 8] [--runs 20]
 *
 * Uses a migrated SCRATCH database (inserts ~2,000 pages, never cleans up). One workspace of 2,000
 * pages: the padded evaluation wiki (context/evalSet.ts) under "Wiki", 100 weekly meeting notes,
 * 365 daily logs, 96 numbered experiment logs (Korean), 60 sprint folders with Planning/Review,
 * 40 projects × 8 docs, 150 customer pages and uniquely titled notes up to 2,000. Every page has
 * a body and is indexed, so find_context ranks against all of them.
 *
 * Tokens are the server's estimate (context/tokens.ts estimateTokens: ASCII/4, Hangul 1, other 1/2),
 * the same function every budget uses; both sides of each comparison are measured with it.
 * Latency is wall time of the in-memory MCP call (client → server → app.inject → Postgres).
 *
 * Scenarios
 *   1. Three agents (three OAuth clients of one user) run the same flow per question:
 *      find_context → read_page of up to the first 3 pages it names; then twice: find_context again
 *      → the same reads again (pass 2: nothing changed; pass 3: a person edited the top page of every
 *      question first). Before: plain re-reads. After: re-reads pass known=<version last read>. Also: how many responses are byte-identical across
 *      the three agents (prompt-cache eligible).
 *   2. list_pages of the whole tree: json / lines / compact, one call; and the complete tree
 *      (root at depth 1 + one call per top-level folder, each under the 500-line cap).
 *   3. The meeting folder (100 dated siblings) and the daily log folder (365): lines vs compact.
 *   4. Smaller rows: search lines vs compact, read_pages with known, patch_sections vs 3 × patch_section,
 *      and find_context with 8-character ids (measured, not adopted).
 */
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.DATA_DIR ||= `${process.env.TMPDIR || '/tmp'}/inkling-tokenbench-${process.pid}`

import { performance } from 'node:perf_hooks'
import { sql } from 'drizzle-orm'

const arg = (name: string, d: number) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? Number(process.argv[i + 1]) || d : d
}
const QUESTIONS = arg('questions', 8)
const RUNS = arg('runs', 20)
const TOTAL_PAGES = 2000

const pct = (before: number, after: number) => `${(((before - after) / before) * 100).toFixed(1)}%`
const q = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]
}
const ms = (x: number) => `${x.toFixed(1)} ms`

async function main() {
  const h = await import('../src/mcpTools/testHarness')
  const { db, closeDb } = await import('../src/db/index')
  const schema = await import('../src/db/schema')
  const { ALL_EVAL_PAGES, EVAL_QUESTIONS, padPages, fillerText } = await import('../src/context/evalSet')
  const { estimateTokens } = await import('../src/context/tokens')
  const { reindexPageChunks } = await import('../src/context/chunkIndex')
  const { blocksToStateBuffer } = await import('../src/md/convert')
  const collab = await import('../src/collab')
  const app = await h.buildTestApp()

  const owner = await h.makeUser('bench')
  const ws = await h.makeWorkspace(owner)
  const names = ['Claude', 'Cursor', 'Other AI']
  const agents = await Promise.all(names.map(async (n) => h.connectMcp(app, { ...owner, via: n }, await h.mintToken(owner, 'notes', n))))
  const human = await h.connectMcp(app, owner, await h.mintToken(owner, 'notes', 'Editor'))
  const tool = async (m: (typeof agents)[number], name: string, args: Record<string, unknown>) => {
    const t0 = performance.now()
    const r = await m.tool(name, args)
    const dt = performance.now() - t0
    if (r.isError) throw new Error(`${name} failed: ${r.text.slice(0, 300)}`)
    return { text: r.text, ms: dt, tokens: estimateTokens(r.text) }
  }

  // ---------------------------------------------------------------------------------------------
  // workspace
  // ---------------------------------------------------------------------------------------------
  let x = 11
  const rnd = (n: number) => {
    x = (x * 1103515245 + 12345) >>> 0
    return x % n
  }
  const vocab = 'deploy rollback backup retention schedule restore paging incident severity limit requests plan price member flag rollout search index latency cache session database migration alert release launch beta billing invoice onboarding'.split(' ')
  const nouns = 'notes checklist overview review proposal summary playbook guide report brief'.split(' ')
  const people = 'Acme Globex Initech Umbrella Hooli Vandelay Stark Wayne Wonka Tyrell Cyberdyne Soylent Aperture Monarch Gringotts'.split(' ')
  let sort = 0
  const t0 = performance.now()
  let made = 0
  const insert = async (title: string, parentId: string | null, body = true): Promise<string> => {
    const [p] = await db
      .insert(schema.pages)
      .values({ workspaceId: ws.id, title, createdBy: owner.id, kind: 'doc', parentId, sortOrder: sort++ })
      .returning({ id: schema.pages.id })
    const blocks: unknown[] = []
    if (body) {
      const ko = /[가-힣]/.test(title)
      for (let s = 0; s < 2 + rnd(2); s++) {
        blocks.push({ type: 'heading', props: { level: 2 }, content: [{ type: 'text', text: ['Notes', 'Decisions', 'Open questions', '결정 사항', '회고'][rnd(5)], styles: {} }] })
        const words = Array.from({ length: 12 }, () => vocab[rnd(vocab.length)]).join(' ')
        blocks.push({ type: 'paragraph', content: [{ type: 'text', text: `${fillerText(made + s, 40, ko)} ${words}`, styles: {} }] })
      }
    } else blocks.push({ type: 'paragraph', content: [{ type: 'text', text: 'Folder.', styles: {} }] })
    await db.insert(schema.pageDocs).values({ pageId: p.id, state: blocksToStateBuffer(blocks as never) })
    await reindexPageChunks(p.id, blocks as never, { log: false })
    made++
    return p.id
  }
  const date = (start: string, plusDays: number) => new Date(Date.parse(`${start}T00:00:00Z`) + plusDays * 86_400_000).toISOString().slice(0, 10)

  const wiki = await insert('Wiki', null, false)
  const evalIds = new Map<string, string>()
  for (const p of padPages(ALL_EVAL_PAGES)) {
    const r = await tool(human, 'create_page', { workspaceId: ws.id, title: p.title, markdown: p.markdown, parentId: wiki })
    evalIds.set(p.title, (JSON.parse(r.text) as { id: string }).id)
    made++
  }
  const meetings = await insert('Meetings', null, false)
  for (let i = 0; i < 100; i++) await insert(`Weekly sync ${date('2024-12-02', i * 7)}`, meetings)
  const daily = await insert('Daily log', null, false)
  for (let i = 0; i < 365; i++) await insert(date('2025-11-01', i), daily)
  const exp = await insert('실험', null, false)
  for (let m = 1; m <= 12; m++) for (let n = 1; n <= 8; n++) await insert(`실험 일지 ${m}-${n}`, exp)
  const sprints = await insert('Sprints', null, false)
  for (let i = 1; i <= 60; i++) {
    const s = await insert(`Sprint ${i}`, sprints, false)
    await insert('Planning', s)
    await insert('Review', s)
  }
  const projects = await insert('Projects', null, false)
  for (let i = 0; i < 40; i++) {
    const p = await insert(`Project ${vocab[i % vocab.length]} ${people[i % people.length]}`, projects, false)
    for (const d of ['Spec', 'Design', 'Decisions', 'Risks', 'Retro', 'Launch checklist', 'Metrics', 'FAQ']) await insert(d, p)
  }
  const customers = await insert('Customers', null, false)
  for (let i = 0; i < 150; i++) await insert(`${people[i % people.length]} ${['Corp', 'Labs', 'Group', 'Systems', 'Partners', 'Health', 'Bank', 'Retail', 'Media', 'Energy'][Math.floor(i / people.length) % 10]}`, customers)
  const notes = await insert('Notes', null, false)
  while (made < TOTAL_PAGES) await insert(`${vocab[rnd(vocab.length)]} ${vocab[rnd(vocab.length)]} ${nouns[rnd(nouns.length)]}`.replace(/^./, (c) => c.toUpperCase()), notes)
  const buildMs = performance.now() - t0
  await db.execute(sql`ANALYZE page_chunks`)
  await db.execute(sql`ANALYZE pages`)
  const [{ n: pageCount }] = (await db.execute(sql`SELECT count(*)::int AS n FROM pages WHERE workspace_id = ${ws.id} AND deleted_at IS NULL`)) as unknown as { n: number }[]
  console.log(`workspace: ${pageCount} pages built and indexed in ${(buildMs / 1000).toFixed(1)} s`)

  // ---------------------------------------------------------------------------------------------
  // 1. three agents, same question flow
  // ---------------------------------------------------------------------------------------------
  const questions = EVAL_QUESTIONS.filter((e) => e.split === 'dev').slice(0, QUESTIONS)
  // fragments first, then "Also relevant" and title-only pages, in the order find_context lists them
  const pagesOf = (fc: string) => [...new Set([...fc.matchAll(/\(page ([0-9a-f-]{36})[;),]/g)].map((m) => m[1]))].slice(0, 3)
  const flow = { fc: 0, read1: 0, reread: 0, rereadKnown: 0, calls: 0, reads1: 0 }
  // per pass: re-reads plain vs with known (pass 2: nothing changed; pass 3: a person edited the top page of every question)
  const pass = [2, 3].map(() => ({ plain: 0, known: 0 }))
  const lat = { full: [] as number[], known: [] as number[] }
  const outputs: string[][] = names.map(() => [])
  const versions = new Map<string, string>()
  // pass 1: every agent asks and reads
  for (const [ai, a] of agents.entries()) {
    for (const qq of questions) {
      const fc = await tool(a, 'find_context', { query: qq.q, workspaceId: ws.id })
      flow.fc += fc.tokens
      outputs[ai].push(fc.text)
      for (const id of pagesOf(fc.text)) {
        const r = await tool(a, 'read_page', { pageId: id })
        flow.read1 += r.tokens
        flow.reads1++
        lat.full.push(r.ms)
        outputs[ai].push(r.text)
        versions.set(`${ai}:${id}`, /- version: ([0-9a-f]+)/.exec(r.text)![1])
      }
      flow.calls += 4
    }
  }
  const edited = new Set<string>()
  for (const [pi, label] of ['unchanged', 'edited'].entries()) {
    if (label === 'edited') {
      // a person edits the top page of every question once
      for (const qq of questions) {
        const fc = await tool(human, 'find_context', { query: qq.q, workspaceId: ws.id })
        const top = pagesOf(fc.text)[0]
        if (!top || edited.has(top)) continue
        edited.add(top)
        await tool(human, 'update_page', { pageId: top, mode: 'append', markdown: 'Edited by a person between the two passes.' })
      }
    }
    // ask again, re-read the same pages (before: plain, after: known=)
    for (const [ai, a] of agents.entries()) {
      for (const qq of questions) {
        const fc = await tool(a, 'find_context', { query: qq.q, workspaceId: ws.id })
        flow.fc += fc.tokens
        for (const id of pagesOf(fc.text)) {
          const plain = await tool(a, 'read_page', { pageId: id })
          pass[pi].plain += plain.tokens
          lat.full.push(plain.ms)
          const v = versions.get(`${ai}:${id}`)
          const k = await tool(a, 'read_page', { pageId: id, ...(v ? { known: v } : {}) })
          pass[pi].known += k.tokens
          lat.known.push(k.ms)
          const nv = /- version: ([0-9a-f]+)/.exec(k.text)?.[1]
          if (nv) versions.set(`${ai}:${id}`, nv)
        }
        flow.calls += 4
      }
    }
  }
  flow.reread = pass[0].plain + pass[1].plain
  flow.rereadKnown = pass[0].known + pass[1].known
  const beforeTotal = flow.fc + flow.read1 + flow.reread
  const afterTotal = flow.fc + flow.read1 + flow.rereadKnown
  let identical = 0
  let identicalTokens = 0
  let allTokens = 0
  for (let i = 0; i < outputs[0].length; i++) {
    const same = outputs.every((o) => o[i] === outputs[0][i])
    allTokens += estimateTokens(outputs[0][i]) * 3
    if (same) {
      identical++
      identicalTokens += estimateTokens(outputs[0][i]) * 2 // the 2nd and 3rd agent could hit a shared prefix cache
    }
  }

  // ---------------------------------------------------------------------------------------------
  // 2–3. trees and lists
  // ---------------------------------------------------------------------------------------------
  const A = agents[0]
  const timed = async (name: string, args: Record<string, unknown>) => {
    const times: number[] = []
    let r = await tool(A, name, args)
    for (let i = 0; i < RUNS; i++) {
      r = await tool(A, name, args)
      times.push(r.ms)
    }
    return { tokens: r.tokens, text: r.text, p50: q(times, 50), p95: q(times, 95) }
  }
  const shown = (t: string, compact: boolean) =>
    compact
      ? t.split('\n').reduce((n, l) => n + (/ ids: /.test(l) ? l.split(' ids: ')[1].split(',').length : /^\s*- /.test(l) ? 1 : 0), 0)
      : t.split('\n').filter((l) => /^\s*- /.test(l)).length
  const tree: Record<string, { tokens: number; p50: number; p95: number; shown: number }> = {}
  for (const format of ['json', 'lines', 'compact'] as const) {
    const r = await timed('list_pages', { workspaceId: ws.id, format })
    tree[format] = { tokens: r.tokens, p50: r.p50, p95: r.p95, shown: format === 'json' ? (JSON.parse(r.text).pages as unknown[]).length : shown(r.text, format === 'compact') }
  }
  // complete tree: root depth 1 + one call per top-level folder
  const tops = [wiki, meetings, daily, exp, sprints, projects, customers, notes]
  const complete: Record<string, number> = {}
  for (const format of ['lines', 'compact'] as const) {
    let tokens = (await tool(A, 'list_pages', { workspaceId: ws.id, format, depth: 1 })).tokens
    for (const t of tops) tokens += (await tool(A, 'list_pages', { workspaceId: ws.id, format, parentId: t })).tokens
    complete[format] = tokens
  }
  const folder: Record<string, Record<string, number>> = {}
  for (const [label, id] of [['meetings (100 weekly)', meetings], ['daily log (365)', daily], ['실험 일지 (96)', exp]] as const) {
    folder[label] = {}
    for (const format of ['json', 'lines', 'compact'] as const) folder[label][format] = (await tool(A, 'list_pages', { workspaceId: ws.id, parentId: id, format })).tokens
  }

  // ---------------------------------------------------------------------------------------------
  // 4. smaller rows
  // ---------------------------------------------------------------------------------------------
  const searchLines = (await tool(A, 'search', { query: 'sync', workspaceId: ws.id, format: 'lines' })).tokens
  const searchCompact = (await tool(A, 'search', { query: 'sync', workspaceId: ws.id, format: 'compact' })).tokens
  const three = [...evalIds.values()].slice(0, 3)
  const rp = await tool(A, 'read_pages', { pageIds: three })
  const known = Object.fromEntries(three.map((id) => [id, new RegExp(`\\(page ${id}, [^)]*v=([0-9a-f]{12})`).exec(rp.text)![1]]))
  const rpTimes: number[] = []
  const rpkTimes: number[] = []
  let rpk = rp
  for (let i = 0; i < RUNS; i++) {
    rpTimes.push((await tool(A, 'read_pages', { pageIds: three })).ms)
    rpk = await tool(A, 'read_pages', { pageIds: three, known })
    rpkTimes.push(rpk.ms)
  }
  // patch_sections vs three patch_section calls (outputs and round trips)
  const target = evalIds.get('Deploy runbook')!
  const outline = (await tool(A, 'read_page', { pageId: target, outline: true })).text
  const anchors = [...outline.matchAll(/- §(\S+) .* v=([0-9a-f]+)/g)].slice(0, 3).map((m) => m[1])
  let singleTokens = 0
  const singleTimes: number[] = []
  const batchTimes: number[] = []
  let batchTokens = 0
  for (let i = 0; i < Math.min(RUNS, 10); i++) {
    let t = 0
    singleTokens = 0
    for (const s of anchors) {
      const r = await tool(A, 'patch_section', { pageId: target, section: s, mode: 'append', markdown: `Single ${i}.` })
      t += r.ms
      singleTokens += r.tokens
    }
    singleTimes.push(t)
    const b = await tool(A, 'patch_sections', { pageId: target, edits: anchors.map((s) => ({ section: s, mode: 'append', markdown: `Batch ${i}.` })) })
    batchTimes.push(b.ms)
    batchTokens = b.tokens
  }
  // find_context with 8-character ids instead of full ids (not adopted, see ADR 1541)
  let fcFull = 0
  let fcShort = 0
  for (const qq of questions) {
    const t = (await tool(A, 'find_context', { query: qq.q, workspaceId: ws.id })).text
    fcFull += estimateTokens(t)
    fcShort += estimateTokens(t.replace(/([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '$1'))
  }
  // tool list bytes, identical across connections
  const lists = await Promise.all(agents.map(async (a) => JSON.stringify((await a.client.listTools()).tools)))

  // ---------------------------------------------------------------------------------------------
  const out = {
    env: { node: process.version, pages: pageCount, questions: questions.length, runs: RUNS },
    flow: {
      ...flow,
      beforeTotal,
      afterTotal,
      saved: pct(beforeTotal, afterTotal),
      rereadSaved: pct(flow.reread, flow.rereadKnown),
      passUnchanged: { ...pass[0], saved: pct(pass[0].plain, pass[0].known) },
      passEdited: { ...pass[1], saved: pct(pass[1].plain, pass[1].known) },
      editedPages: edited.size,
      readPageFull: { p50: q(lat.full, 50), p95: q(lat.full, 95) },
      readPageKnown: { p50: q(lat.known, 50), p95: q(lat.known, 95) },
      identicalAcrossAgents: `${identical}/${outputs[0].length}`,
      cacheEligibleShare: `${((identicalTokens / allTokens) * 100).toFixed(1)}%`,
    },
    tree,
    treeSaved: { linesVsJson: pct(tree.json.tokens, tree.lines.tokens), compactVsLines: pct(tree.lines.tokens, tree.compact.tokens) },
    completeTree: { ...complete, saved: pct(complete.lines, complete.compact) },
    folder,
    search: { lines: searchLines, compact: searchCompact, saved: pct(searchLines, searchCompact) },
    readPages: { full: rp.tokens, known: rpk.tokens, saved: pct(rp.tokens, rpk.tokens), fullP50: q(rpTimes, 50), knownP50: q(rpkTimes, 50), fullP95: q(rpTimes, 95), knownP95: q(rpkTimes, 95) },
    patch: { singleOutputTokens: singleTokens, batchOutputTokens: batchTokens, singleP50: q(singleTimes, 50), batchP50: q(batchTimes, 50), singleP95: q(singleTimes, 95), batchP95: q(batchTimes, 95), roundTrips: `${anchors.length} → 1` },
    findContextShortIds: { full: fcFull, short: fcShort, saved: pct(fcFull, fcShort) },
    toolList: { identicalAcrossConnections: lists.every((l) => l === lists[0]), tokens: estimateTokens(lists[0]) },
  }
  console.log(JSON.stringify(out, null, 2))
  console.log(
    `\nflow (3 agents × ${questions.length} questions, ${flow.calls} calls): ${beforeTotal} → ${afterTotal} tokens (${out.flow.saved}); re-reads ${flow.reread} → ${flow.rereadKnown} (${out.flow.rereadSaved})`,
  )
  console.log(`read_page p50 ${ms(out.flow.readPageFull.p50)} full vs ${ms(out.flow.readPageKnown.p50)} known`)
  console.log(`tree one call: json ${tree.json.tokens} / lines ${tree.lines.tokens} / compact ${tree.compact.tokens} tokens (pages shown ${tree.json.shown}/${tree.lines.shown}/${tree.compact.shown})`)
  console.log(`complete tree: lines ${complete.lines} → compact ${complete.compact} (${out.completeTree.saved})`)
  for (const [k, v] of Object.entries(folder)) console.log(`${k}: json ${v.json} / lines ${v.lines} / compact ${v.compact}`)

  for (const a of [...agents, human]) await a.close()
  await collab.destroyCollab()
  await app.close()
  await closeDb()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
