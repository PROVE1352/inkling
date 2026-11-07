/**
 * Before/after evaluation of agent retrieval (docs/adr/0927-*). Drives the real MCP tools through
 * the in-memory client (mcpTools/testHarness.ts), so the measured text is exactly what an agent
 * receives. Token counts use estimateTokens (context/tokens.ts) on both sides.
 *
 * "Before" simulates the old flow with an oracle stop (favourable to it): search(full question);
 * if empty, search each term (longest first, at most 3); then read_page on results in order until
 * the expected page has been read (at most 3 reads). "After": one find_context call; if the expected
 * section is not among the returned fragments but its page is mentioned, one read_page(section).
 */
import { queryTerms } from './rank'
import { estimateTokens } from './tokens'
import type { EvalQuestion } from './evalSet'

type ToolFn = (name: string, args?: Record<string, unknown>) => Promise<{ text: string; isError: boolean }>

export interface QuestionResult {
  q: string
  before: { calls: number; tokens: number; found: boolean; pageRank: number }
  after: { calls: number; tokens: number; found: boolean; sectionRank: number; pageRank: number; firstCallTokens: number }
}

export interface EvalSummary {
  n: number
  before: { meanTokens: number; medianTokens: number; meanCalls: number; success: number; pageAt1: number; pageAt3: number; pageAt5: number }
  after: {
    meanTokens: number
    medianTokens: number
    meanCalls: number
    success: number
    sectionAt1: number
    sectionAt3: number
    sectionAt5: number
    pageAt1: number
    pageAt3: number
    pageAt5: number
  }
  rows: QuestionResult[]
}

/** Fragment headers of find_context output: [(pageId, anchors[])] in rank order. */
export function parseFragments(out: string): { pageId: string; anchors: string[] }[] {
  const res: { pageId: string; anchors: string[] }[] = []
  const re = /^\(page ([0-9a-f-]{36}); (.+)\)$/gm
  for (let m = re.exec(out); m; m = re.exec(out)) {
    const anchors = [...m[2].matchAll(/§(\S+) v=/g)].map((x) => x[1])
    res.push({ pageId: m[1], anchors })
  }
  return res
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? s[Math.floor((s.length - 1) / 2)] : 0
}
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
const rate = (xs: boolean[]) => (xs.length ? xs.filter(Boolean).length / xs.length : 0)

export async function runEval(
  tool: ToolFn,
  questions: EvalQuestion[],
  pageIdByTitle: Map<string, string>,
  findArgs: Record<string, unknown> = {},
): Promise<EvalSummary> {
  const rows: QuestionResult[] = []
  for (const qq of questions) {
    const expected = pageIdByTitle.get(qq.page)
    if (!expected) throw new Error(`eval page missing: ${qq.page}`)

    // ---- before
    let calls = 0
    let tokens = 0
    let results: { id: string }[] = []
    const search = async (q: string) => {
      const r = await tool('search', { query: q, ...(findArgs.workspaceId ? { workspaceId: findArgs.workspaceId } : {}) })
      calls++
      tokens += estimateTokens(r.text)
      return r.isError ? [] : ((JSON.parse(r.text) as { results: { id: string }[] }).results ?? [])
    }
    results = await search(qq.q)
    if (results.length === 0) {
      const terms = [...queryTerms(qq.q)].sort((a, b) => b.length - a.length).slice(0, 3)
      for (const t of terms) {
        results = await search(t)
        if (results.length) break
      }
    }
    const pageRank = results.findIndex((r) => r.id === expected) + 1
    let found = false
    for (const r of results.slice(0, 3)) {
      const out = await tool('read_page', { pageId: r.id })
      calls++
      tokens += estimateTokens(out.text)
      if (r.id === expected) {
        found = true
        break
      }
    }
    const before = { calls, tokens, found, pageRank }

    // ---- after
    const fc = await tool('find_context', { query: qq.q, ...findArgs })
    const frags = parseFragments(fc.text)
    const sectionRank = frags.findIndex((f) => f.pageId === expected && f.anchors.includes(qq.anchor)) + 1
    const pageRankAfter = frags.findIndex((f) => f.pageId === expected) + 1
    let aCalls = 1
    let aTokens = estimateTokens(fc.text)
    let aFound = sectionRank > 0
    if (!aFound && fc.text.includes(expected)) {
      const sec = await tool('read_page', { pageId: expected, section: qq.anchor })
      aCalls++
      aTokens += estimateTokens(sec.text)
      aFound = !sec.isError
    }
    rows.push({
      q: qq.q,
      before,
      after: { calls: aCalls, tokens: aTokens, found: aFound, sectionRank, pageRank: pageRankAfter, firstCallTokens: estimateTokens(fc.text) },
    })
  }
  const at = (xs: number[], k: number) => rate(xs.map((r) => r > 0 && r <= k))
  return {
    n: rows.length,
    before: {
      meanTokens: Math.round(mean(rows.map((r) => r.before.tokens))),
      medianTokens: median(rows.map((r) => r.before.tokens)),
      meanCalls: Number(mean(rows.map((r) => r.before.calls)).toFixed(2)),
      success: rate(rows.map((r) => r.before.found)),
      pageAt1: at(rows.map((r) => r.before.pageRank), 1),
      pageAt3: at(rows.map((r) => r.before.pageRank), 3),
      pageAt5: at(rows.map((r) => r.before.pageRank), 5),
    },
    after: {
      meanTokens: Math.round(mean(rows.map((r) => r.after.tokens))),
      medianTokens: median(rows.map((r) => r.after.tokens)),
      meanCalls: Number(mean(rows.map((r) => r.after.calls)).toFixed(2)),
      success: rate(rows.map((r) => r.after.found)),
      sectionAt1: at(rows.map((r) => r.after.sectionRank), 1),
      sectionAt3: at(rows.map((r) => r.after.sectionRank), 3),
      sectionAt5: at(rows.map((r) => r.after.sectionRank), 5),
      pageAt1: at(rows.map((r) => r.after.pageRank), 1),
      pageAt3: at(rows.map((r) => r.after.pageRank), 3),
      pageAt5: at(rows.map((r) => r.after.pageRank), 5),
    },
    rows,
  }
}
