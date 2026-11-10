// find_context with several queries (0.14, docs/adr/1720-* .. 1722-*): queries=[…] merged by RRF
// under one budget, each section once with `matched:`, header and footer once, the single-query
// answer byte-identical, per-query and bundle cache entries, determinism, permissions, and the
// measurement of N separate calls vs one bundle (tokens.ts estimate; the table in docs/PERFORMANCE.md).
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.APP_URL ||= 'https://notes.example.com'

import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'
import type { Blocks as CorpusBlocks } from './multiQueryCorpus'

const HAS_DB = !!process.env.DATABASE_URL

describe('[db] find_context queries=[…] (docs/adr/1720-*)', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const h = await import('./testHarness')
  const { closeDb } = await import('../db/index')
  const { reindexPageChunks } = await import('../context/chunkIndex')
  const { drainChangeLog } = await import('../context/changeLog')
  const cache = await import('../context/contextCache')
  const C = await import('./multiQueryCorpus')

  const app = await h.buildTestApp()
  const closers: (() => Promise<void>)[] = []
  after(async () => {
    for (const c of closers) await c()
    await app.close()
    await closeDb()
  })

  const alice = await h.makeUser('alice')
  const bob = await h.makeUser('bob')
  const ws = await h.makeWorkspace(alice, [bob])
  const ids = new Map<string, string>()
  type Blocks = Parameters<typeof h.makeDocPage>[3]
  async function newPage(title: string, blocks: CorpusBlocks, owner = alice, extra: Record<string, unknown> = {}) {
    const pg = await h.makeDocPage(ws.id, owner.id, title, blocks as Blocks, extra)
    await reindexPageChunks(pg.id, blocks as never)
    ids.set(title, pg.id)
    return pg
  }
  for (const [title, sections] of Object.entries(C.TOPICS)) await newPage(title, C.doc(sections))
  for (const f of C.fillerPages()) await newPage(f.title, f.blocks)
  await newPage('Alice secret', C.doc({ Rollback: 'private roll back deployment notes zeppelin' }), alice, { scope: 'private' })
  await drainChangeLog(500)
  const pageIdOf = (title: string) => ids.get(title)!

  async function agent(u: typeof alice) {
    const m = await h.connectMcp(app, u, await h.mintToken(u))
    closers.push(m.close)
    return m
  }
  const A = await agent(alice)
  const B = await agent(bob)
  const ROLLBACK = C.BUNDLES[0]

  it('one query, or queries with one distinct entry, prints exactly the single-query answer', async () => {
    const one = await A.tool('find_context', { query: 'roll back deployment' })
    assert.equal(one.isError, false, one.text)
    assert.equal((await A.tool('find_context', { queries: ['roll back deployment'] })).text, one.text)
    assert.equal((await A.tool('find_context', { query: 'roll back deployment', queries: ['  Roll back   DEPLOYMENT '] })).text, one.text)
    assert.doesNotMatch(one.text, /matched:/)
  })

  it('a bundle: one header naming the queries, each section once with matched, one footer, one budget', async () => {
    const r = await A.tool('find_context', { queries: ROLLBACK.queries })
    assert.equal(r.isError, false, r.text)
    assert.match(r.text, /^\d+ result\(s\) for 3 queries \(1 "roll back deployment", 2 "배포 되돌리기", 3 "revert release"\), ~(\d+)\/3500 tokens\n/)
    const used = Number(/~(\d+)\/3500/.exec(r.text)![1])
    assert.ok(used <= 3500)
    const headers = [...r.text.matchAll(/\(page ([0-9a-f-]{36}); ([^\n]*?)(?:; truncated)?; matched: ([\d,s]+)/g)]
    assert.ok(headers.length > 3)
    const sections = headers.flatMap((m) => [...m[2].matchAll(/§([^ ,]+) v=/g)].map((s) => `${m[1]}#${s[1]}`))
    assert.equal(new Set(sections).size, sections.length, 'a section printed twice')
    assert.equal(r.text.match(/<untrusted_content/g)?.length, 1)
    assert.equal(r.text.match(/^Next: /gm)?.length, 1)
    // both answers (English and Korean pages) are in the one answer
    for (const g of ROLLBACK.gold) assert.ok(C.includesSection(r.text, pageIdOf(g.title), g.anchor), `${g.title} §${g.anchor} missing`)
    // the English answer section was found by queries 1 and 3, the Korean one by query 2
    assert.match(r.text, new RegExp(`\\(page ${pageIdOf('Release runbook')}; §rollback v=\\w+; matched: 1(,2)?,3;`))
  })

  it('the same bundle gives the same bytes, also when recomputed', async () => {
    const a = await A.tool('find_context', { queries: ROLLBACK.queries })
    cache._resetContextCache()
    const b = await A.tool('find_context', { queries: ROLLBACK.queries })
    assert.equal(b.text, a.text)
  })

  it('cache: queries asked alone are not recomputed in a bundle; the bundle has its own entry', async () => {
    cache._resetContextCache()
    for (const q of ROLLBACK.queries) await A.tool('find_context', { query: q })
    assert.deepEqual({ ...cache.contextCacheStats }, { hits: 0, misses: 3, batchHits: 0, batchMisses: 0 })
    await A.tool('find_context', { queries: ROLLBACK.queries })
    assert.deepEqual({ ...cache.contextCacheStats }, { hits: 3, misses: 3, batchHits: 0, batchMisses: 1 })
    await A.tool('find_context', { queries: ROLLBACK.queries })
    assert.equal(cache.contextCacheStats.batchHits, 1)
    // a bundle that shares two queries computes only the third
    await A.tool('find_context', { queries: [ROLLBACK.queries[0], ROLLBACK.queries[1], 'freeze window'] })
    assert.equal(cache.contextCacheStats.misses, 4)
    // order is part of the bundle (matched numbers), but not of the per-query entries
    await A.tool('find_context', { queries: [...ROLLBACK.queries].reverse() })
    assert.equal(cache.contextCacheStats.batchMisses, 3)
    assert.equal(cache.contextCacheStats.misses, 4)
  })

  it('cache: an edit and reindex makes the bundle miss and show the new text', async () => {
    const blocks = C.doc({ ...C.TOPICS['Cache rules'], Invalidation: 'Invalidate by key prefix after every write; revert release caches with the quokka switch.' })
    await reindexPageChunks(pageIdOf('Cache rules'), blocks as never)
    const r = await A.tool('find_context', { queries: ROLLBACK.queries })
    assert.match(r.text, /quokka switch/)
  })

  it('permissions are the single query\'s: another member never sees a private page through a bundle', async () => {
    assert.match((await A.tool('find_context', { queries: ['zeppelin', 'roll back deployment'] })).text, /Alice secret/)
    const r = await B.tool('find_context', { queries: ['zeppelin', 'roll back deployment'] })
    assert.doesNotMatch(r.text, /Alice secret|zeppelin notes/)
  })

  it('refusals: neither query nor queries, more than 5 different queries', async () => {
    const none = await A.tool('find_context', {})
    assert.equal(none.isError, true)
    assert.match(none.text, /query or queries is required/)
    const six = await A.tool('find_context', { query: 'a1', queries: ['b2', 'c3', 'd4', 'e5', 'f6'] })
    assert.equal(six.isError, true)
    assert.match(six.text, /at most 5 different queries/)
    // repeats do not count
    assert.equal((await A.tool('find_context', { query: 'cache', queries: ['cache', 'CACHE', 'b2', 'c3', 'd4'] })).isError, false)
  })

  it('REST: repeated q returns the merged result with queries and matched', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/context?q=cache%20invalidation&q=%EC%BA%90%EC%8B%9C%20%EB%AC%B4%ED%9A%A8%ED%99%94', headers: { cookie: alice.cookie } })
    assert.equal(res.statusCode, 200, res.body)
    const body = res.json() as { queries: string[]; fragments: { matched: string[] }[] }
    assert.deepEqual(body.queries, ['cache invalidation', '캐시 무효화'])
    assert.ok(body.fragments.every((f) => f.matched.length > 0))
    const single = await app.inject({ method: 'GET', url: '/api/context?q=cache%20invalidation', headers: { cookie: alice.cookie } })
    assert.equal('queries' in (single.json() as object), false)
  })

  it('measurement: N separate calls vs one bundle (tokens, round trips, answer sections)', async () => {
    cache._resetContextCache()
    const rows = []
    for (const b of C.BUNDLES) rows.push(await C.measureBundle(A.tool, b, pageIdOf))
    console.log(`\nfind_context, default budget, ${Object.keys(C.TOPICS).length} topic pages + ${C.FILLER} filler pages\n${C.measureTable(rows)}`)
    const small = []
    for (const b of C.BUNDLES) small.push(await C.measureBundle(A.tool, b, pageIdOf, 1200))
    console.log(`\nbudget 1200\n${C.measureTable(small)}`)
    for (const r of [...rows, ...small]) {
      assert.ok(r.bundled.tokens < r.separate.tokens, `${r.name}: ${r.bundled.tokens} >= ${r.separate.tokens}`)
      assert.equal(r.bundled.calls, 1)
    }
    for (const r of rows) assert.equal(r.bundled.gold, r.separate.gold, `${r.name}: an answer section lost in the bundle`)
  })
})
