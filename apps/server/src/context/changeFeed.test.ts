// Change feed: diff, section change detection, cursor, fold (pure) and changes_since end to end ([db]).
// docs/adr/0932-*, 0933-*.
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
// The merge assertions need that no other process issues a changes_since cursor between two edits
// (the high-water mark is database-wide, docs/adr/1080-*), so in --db mode this file runs alone:
// run-tests: db-exclusive
process.env.PUBLIC_URL ||= 'https://notes.example.com/'

import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'
import type { AnyBlock } from '../md/convert'
import { decodeCursor, encodeCursor, foldRows } from './changeFeed'
import type { FeedRow } from './changeFeed'
import { DIFF_LIMITS, diffText, myers, splitUnits } from './diff'
import { computeSectionChanges, longestIncreasingSubsequence } from './sectionChanges'
import type { SectionLike } from './sectionChanges'

const HAS_DB = !!process.env.DATABASE_URL

// ---------------------------------------------------------------------------
// diff
// ---------------------------------------------------------------------------

const lines = (n: number, f: (i: number) => string) => Array.from({ length: n }, (_, i) => f(i)).join('\n')
const LONG_A =
  'The deploy runs every night at two. Rollback uses the previous image tag and takes about five minutes. ' +
  'Alerts go to the on-call channel, and the incident doc is linked from the runbook header.'
const LONG_KO =
  '배포는 매일 밤 두 시에 실행된다. 롤백은 이전 이미지 태그를 사용하며 약 오 분이 걸린다. 알림은 당번 채널로 간다. ' +
  '이 문단은 길어서 문장 단위로 나뉘어야 한다.'

/** Scenario table: before, after, expected hunk lines. Also the "diff accuracy" measurement. */
export const DIFF_SCENARIOS: { name: string; before: string; after: string; expect: string[] }[] = [
  { name: 'identical', before: 'a\nb', after: 'a\nb', expect: [] },
  { name: 'one line changed', before: 'a\nb\nc', after: 'a\nB\nc', expect: ['  a', '- b', '+ B'] },
  { name: 'append', before: 'a\nb', after: 'a\nb\nc', expect: ['  b', '+ c'] },
  { name: 'prepend', before: 'b', after: 'a\nb', expect: ['+ a'] },
  { name: 'delete first', before: 'a\nb\nc', after: 'b\nc', expect: ['- a'] },
  { name: 'delete last', before: 'a\nb\nc', after: 'a\nb', expect: ['  b', '- c'] },
  { name: 'from empty', before: '', after: 'x\ny', expect: ['+ x', '+ y'] },
  { name: 'to empty', before: 'x\ny', after: '', expect: ['- x', '- y'] },
  {
    name: 'two distant hunks',
    before: lines(8, (i) => `l${i}`),
    after: lines(8, (i) => (i === 1 || i === 6 ? `L${i}` : `l${i}`)),
    expect: ['  l0', '- l1', '+ L1', '…', '  l5', '- l6', '+ L6'],
  },
  {
    name: 'hunks one line apart share context',
    before: 'l0\nl1\nl2\nl3\nl4',
    after: 'l0\nL1\nl2\nL3\nl4',
    expect: ['  l0', '- l1', '+ L1', '  l2', '- l3', '+ L3'],
  },
  { name: 'blank line is not context', before: 'a\n\nb', after: 'a\n\nB', expect: ['- b', '+ B'] },
  {
    name: 'block replaced 3→2',
    before: 'h\nx1\nx2\nx3\nt',
    after: 'h\ny1\ny2\nt',
    expect: ['  h', '- x1', '- x2', '- x3', '+ y1', '+ y2'],
  },
  { name: 'line moved to end', before: 'a\nb\nc\nd', after: 'b\nc\nd\na', expect: ['- a', '…', '  d', '+ a'] },
  {
    name: 'one sentence in a long line',
    before: LONG_A,
    after: LONG_A.replace('five minutes', 'ten minutes'),
    expect: [
      '  The deploy runs every night at two.',
      '- Rollback uses the previous image tag and takes about five minutes.',
      '+ Rollback uses the previous image tag and takes about ten minutes.',
    ],
  },
  {
    name: 'Korean sentence in a long line',
    before: LONG_KO,
    after: LONG_KO.replace('오 분', '십 분'),
    expect: [
      '  배포는 매일 밤 두 시에 실행된다.',
      '- 롤백은 이전 이미지 태그를 사용하며 약 오 분이 걸린다.',
      '+ 롤백은 이전 이미지 태그를 사용하며 약 십 분이 걸린다.',
    ],
  },
  {
    name: 'list item edited',
    before: '- buy milk\n- call bob\n- send report',
    after: '- buy milk\n- call alice\n- send report',
    expect: ['  - buy milk', '- - call bob', '+ - call alice'],
  },
  {
    name: 'long context line is cut',
    before: `${'x'.repeat(100)}\nold`,
    after: `${'x'.repeat(100)}\nnew`,
    expect: [`  ${'x'.repeat(DIFF_LIMITS.contextChars)}…`, '- old', '+ new'],
  },
]

describe('diff', () => {
  for (const s of DIFF_SCENARIOS) {
    it(`scenario: ${s.name}`, () => {
      const d = diffText(s.before, s.after)
      assert.equal(d.large, false)
      assert.deepEqual(d.lines, s.expect)
    })
  }

  it('diff accuracy over the scenario table', (t) => {
    let ok = 0
    for (const s of DIFF_SCENARIOS) {
      const d = diffText(s.before, s.after)
      if (!d.large && JSON.stringify(d.lines) === JSON.stringify(s.expect)) ok++
    }
    t.diagnostic(`diff accuracy: ${ok}/${DIFF_SCENARIOS.length}`)
    assert.equal(ok, DIFF_SCENARIOS.length)
  })

  it('splits only long lines into sentences', () => {
    assert.deepEqual(splitUnits('short. line.'), ['short. line.'])
    assert.equal(splitUnits(LONG_A).length, 3)
    assert.deepEqual(splitUnits(''), [])
  })

  it('myers is a valid and minimal edit script (fuzz against LCS DP)', () => {
    let seed = 7
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed / 0x7fffffff
    }
    const word = () => 'abcd'[Math.floor(rnd() * 4)]
    for (let t = 0; t < 500; t++) {
      const a = Array.from({ length: Math.floor(rnd() * 25) }, word)
      const b = Array.from({ length: Math.floor(rnd() * 25) }, word)
      const ops = myers(a, b, 1000)
      assert.ok(ops)
      assert.deepEqual(ops.filter((o) => o.t !== '+').map((o) => o.s), a)
      assert.deepEqual(ops.filter((o) => o.t !== '-').map((o) => o.s), b)
      // LCS by DP: the edit count must be n + m - 2·LCS
      const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
      for (let i = 1; i <= a.length; i++)
        for (let j = 1; j <= b.length; j++)
          dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1])
      const edits = ops.filter((o) => o.t !== '=').length
      assert.equal(edits, a.length + b.length - 2 * dp[a.length][b.length])
    }
  })

  it('work cap is a deterministic counter, shareable across diffs', () => {
    assert.equal(diffText('a\nb\nc', 'x\ny\nz', { ...DIFF_LIMITS, maxWork: 3 }).large, true)
    assert.equal(diffText('a', 'b', undefined, { left: 0 }).large, true)
    const shared = { left: 1_000 }
    const d = diffText('a\nb', 'a\nc', undefined, shared)
    assert.deepEqual(d.lines, ['  a', '- b', '+ c'])
    assert.ok(shared.left < 1_000 && shared.left > 0)
    // same input → same output, every time
    const x = lines(200, (i) => `l${i % 7}`)
    const y = lines(200, (i) => `l${(i * 3) % 7}`)
    assert.deepEqual(diffText(x, y), diffText(x, y))
  })

  it('falls back to large over the caps', () => {
    const a = lines(600, (i) => `a${i}`)
    const b = lines(600, (i) => `b${i}`)
    assert.equal(diffText(a, b).large, true) // D = 1200 > maxD
    const big = lines(DIFF_LIMITS.maxUnits + 10, (i) => `x${i}`)
    assert.equal(diffText(big, `${big}\ny`).large, false) // common prefix trimmed first
    assert.equal(diffText(`q\n${big}`, `${big}\nq`.replace(/x/g, 'z')).large, true) // too many units
  })
})

// ---------------------------------------------------------------------------
// section change detection
// ---------------------------------------------------------------------------

const sec = (anchor: string, text: string, order: number, blockId: string | null = null, version?: string): SectionLike => ({
  anchor,
  headingPath: anchor,
  blockId,
  text,
  version: version ?? `${anchor}:${text}`,
  order,
})
const kinds = (cs: { kind: string; anchor: string; prevAnchor: string | null }[]) =>
  cs.map((c) => `${c.kind}:${c.prevAnchor ? `${c.prevAnchor}>` : ''}${c.anchor}`).sort()

describe('section changes', () => {
  it('LIS returns a longest strictly increasing subsequence', () => {
    assert.deepEqual(longestIncreasingSubsequence([]), [])
    assert.deepEqual(longestIncreasingSubsequence([0, 1, 2]), [0, 1, 2])
    assert.equal(longestIncreasingSubsequence([2, 1, 0]).length, 1)
    assert.deepEqual(longestIncreasingSubsequence([3, 0, 1, 2]), [1, 2, 3])
    // random: increasing and as long as the O(n²) DP
    let seed = 3
    for (let t = 0; t < 200; t++) {
      const n = (t % 30) + 1
      const seq = Array.from({ length: n }, () => (seed = (seed * 69069 + 1) % 1000))
      const idx = longestIncreasingSubsequence(seq)
      for (let i = 1; i < idx.length; i++) assert.ok(idx[i] > idx[i - 1] && seq[idx[i]] > seq[idx[i - 1]])
      const dp = seq.map(() => 1)
      for (let i = 0; i < n; i++) for (let j = 0; j < i; j++) if (seq[j] < seq[i]) dp[i] = Math.max(dp[i], dp[j] + 1)
      assert.equal(idx.length, Math.max(...dp))
    }
  })

  it('modified, added, removed', () => {
    const before = [sec('a', 'x', 0), sec('b', 'y', 1), sec('c', 'z', 2)]
    const after = [sec('a', 'x2', 0), sec('c', 'z', 1), sec('d', 'w', 2)]
    assert.deepEqual(kinds(computeSectionChanges(before, after)), ['added:d', 'modified:a', 'removed:b'])
  })

  it('inserting a section in the middle moves nothing', () => {
    const before = [sec('a', '1', 0), sec('b', '2', 1), sec('c', '3', 2)]
    const after = [sec('a', '1', 0), sec('n', 'new', 1), sec('b', '2', 2), sec('c', '3', 3)]
    assert.deepEqual(kinds(computeSectionChanges(before, after)), ['added:n'])
  })

  it('moving one section reports only that one (LIS)', () => {
    const before = [sec('a', '1', 0), sec('b', '2', 1), sec('c', '3', 2), sec('d', '4', 3)]
    const after = [sec('d', '4', 0), sec('a', '1', 1), sec('b', '2', 2), sec('c', '3', 3)]
    const cs = computeSectionChanges(before, after)
    assert.deepEqual(kinds(cs), ['moved:d'])
    assert.equal(cs[0].before, '3')
    assert.equal(cs[0].after, '0')
  })

  it('renamed: identical body under a new anchor, and a parent rename cascades', () => {
    const before = [sec('deploy', 'intro', 0), sec('deploy/rollback', 'steps', 1)]
    const after = [sec('ship', 'intro', 0), sec('ship/rollback', 'steps', 1)]
    assert.deepEqual(kinds(computeSectionChanges(before, after)), ['renamed:deploy/rollback>ship/rollback', 'renamed:deploy>ship'])
  })

  it('renamed by heading block id even when the body changed', () => {
    const cs = computeSectionChanges([sec('old', 'body', 0, 'blk1')], [sec('new', 'body v2', 0, 'blk1')])
    assert.deepEqual(kinds(cs), ['renamed:old>new'])
    assert.equal(cs[0].before, 'body')
    assert.equal(cs[0].after, 'body v2')
  })

  it('heading text change that keeps the slug is a rename of the same anchor', () => {
    const cs = computeSectionChanges([sec('notes', 'b', 0, null, 'v1')], [sec('notes', 'b', 0, null, 'v2')])
    assert.deepEqual(kinds(cs), ['renamed:notes>notes'])
  })

  it('a large page is cheap (no quadratic step)', () => {
    const n = 20_000
    const before = Array.from({ length: n }, (_, i) => sec(`s${i}`, `t${i}`, i))
    const after = [...before.slice(1), { ...before[0], order: n - 1 }].map((s, i) => ({ ...s, order: i }))
    const t0 = Date.now()
    const cs = computeSectionChanges(before, after)
    assert.deepEqual(kinds(cs), ['moved:s0'])
    assert.ok(Date.now() - t0 < 1_000)
  })
})

// ---------------------------------------------------------------------------
// cursor + fold
// ---------------------------------------------------------------------------

describe('cursor', () => {
  it('round-trips and rejects garbage', () => {
    const c = { seq: 12345, at: 1_762_000_000_000, ws: '0b9e7f3a-1111-4222-8333-944455556666' }
    assert.deepEqual(decodeCursor(encodeCursor(c)), c)
    assert.deepEqual(decodeCursor(encodeCursor({ ...c, ws: null })), { ...c, ws: null })
    assert.equal(decodeCursor('not a cursor!'), null)
    assert.equal(decodeCursor(Buffer.from('c1.x.1.').toString('base64url')), null)
    assert.equal(decodeCursor(Buffer.from('c2.1.1.').toString('base64url')), null)
    assert.equal(decodeCursor(''), null)
  })
})

let seqN = 0
const row = (o: Partial<FeedRow>): FeedRow => ({
  seq: ++seqN,
  pageId: 'p1',
  anchor: 'a',
  prevAnchor: null,
  headingPath: 'A',
  kind: 'modified',
  hasBefore: true,
  hasAfter: true,
  bh: 'h0',
  ah: 'h1',
  smallBefore: null,
  smallAfter: null,
  actorName: null,
  via: null,
  changedAt: 0,
  visibleNow: true,
  title: 'P',
  ...o,
})

describe('fold', () => {
  it('add then delete cancels; edit back to the start cancels', () => {
    assert.deepEqual(foldRows([row({ kind: 'added', hasBefore: false, bh: null }), row({ kind: 'removed', hasAfter: false, ah: null, bh: 'h1' })]), [])
    assert.deepEqual(foldRows([row({ bh: 'h0', ah: 'h1' }), row({ bh: 'h1', ah: 'h0' })]), [])
  })

  it('repeated edits collapse to first before / last after', () => {
    const rs = [row({ bh: 'h0', ah: 'h1' }), row({ bh: 'h1', ah: 'h2' }), row({ bh: 'h2', ah: 'h3' })]
    const u = foldRows(rs)
    assert.equal(u.length, 1)
    assert.equal(u[0].kind, 'modified')
    assert.equal(u[0].group!.beforeSeq, rs[0].seq)
    assert.equal(u[0].group!.afterSeq, rs[2].seq)
  })

  it('follows renames across anchors and reports net rename + edit', () => {
    const u = foldRows([
      row({ anchor: 'a', bh: 'h0', ah: 'h1' }),
      row({ kind: 'renamed', anchor: 'b', prevAnchor: 'a', bh: 'h1', ah: 'h1' }),
      row({ anchor: 'b', bh: 'h1', ah: 'h2' }),
    ])
    assert.equal(u.length, 1)
    assert.equal(u[0].kind, 'renamed')
    assert.equal(u[0].group!.origAnchor, 'a')
    assert.equal(u[0].group!.anchor, 'b')
    assert.equal(u[0].textChanged, true)
  })

  it('page no longer visible collapses to one line; created-and-gone is dropped', () => {
    const gone = foldRows([row({ pageId: 'p2', visibleNow: false, title: null }), row({ pageId: 'p2', anchor: 'b', visibleNow: false, title: null })])
    assert.deepEqual(gone.map((u) => u.kind), ['gone'])
    const never = foldRows([
      row({ pageId: 'p3', anchor: null, kind: 'page_added', visibleNow: false, title: null }),
      row({ pageId: 'p3', anchor: null, kind: 'page_trashed', visibleNow: false, title: null }),
    ])
    assert.deepEqual(never, [])
  })

  it('trash then restore nets out; moved back nets out', () => {
    assert.deepEqual(
      foldRows([row({ anchor: null, kind: 'page_trashed' }), row({ anchor: null, kind: 'page_restored' })]),
      [],
    )
    assert.deepEqual(
      foldRows([
        row({ kind: 'moved', smallBefore: '0', smallAfter: '2' }),
        row({ kind: 'moved', smallBefore: '2', smallAfter: '0' }),
      ]),
      [],
    )
  })
})

// ---------------------------------------------------------------------------
// [db] end to end
// ---------------------------------------------------------------------------

const p = (t: string): AnyBlock => ({ type: 'paragraph', content: [{ type: 'text', text: t, styles: {} }] as never })
const h = (t: string, level = 2): AnyBlock => ({ type: 'heading', props: { level }, content: [{ type: 'text', text: t, styles: {} }] as never })

describe('[db] change feed', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const { db, closeDb } = await import('../db/index')
  const schema = await import('../db/schema')
  const { and, eq, gt, sql } = await import('drizzle-orm')
  const H = await import('../mcpTools/testHarness')
  const { reindexPageChunks } = await import('./chunkIndex')
  const { blocksToStateBuffer } = await import('../md/convert')
  const { withEditActor } = await import('./attribution')
  const { estimateTokens } = await import('./tokens')
  const { purgeOldChanges, drainChangeLog } = await import('./changeLog')

  const app = await H.buildTestApp()
  const alice = await H.makeUser('alice')
  const bob = await H.makeUser('bob')
  const ws = await H.makeWorkspace(alice, [bob])
  const A = await H.connectMcp(app, alice, await H.mintToken(alice, 'notes', 'Claude Desktop'))
  const B = await H.connectMcp(app, bob, await H.mintToken(bob))
  const Bro = await H.connectMcp(app, bob, await H.mintToken(bob, 'read'), { canWrite: false })

  after(async () => {
    await A.close()
    await B.close()
    await Bro.close()
    await app.close()
    await closeDb()
  })

  async function setDoc(pageId: string, blocks: AnyBlock[]) {
    await db.update(schema.pageDocs).set({ state: blocksToStateBuffer(blocks) }).where(eq(schema.pageDocs.pageId, pageId))
    await reindexPageChunks(pageId, blocks)
    // The log is written by the outbox consumer (docs/adr/1080-*); tests that read page_changes
    // directly wait for it (changes_since itself drains before reading).
    await drainChangeLog()
  }
  async function newPage(owner: { id: string }, title: string, blocks: AnyBlock[], extra: Record<string, unknown> = {}, wsId = ws.id) {
    const pg = await H.makeDocPage(wsId, owner.id, title, blocks, extra)
    await reindexPageChunks(pg.id, blocks)
    await drainChangeLog()
    return pg
  }
  const cursorIn = (text: string) => {
    const m = /(?:next cursor|fresh cursor|^cursor): (\S+)/m.exec(text)
    assert.ok(m, `no cursor in: ${text}`)
    return m[1]
  }
  async function start(c = B, args: Record<string, unknown> = {}) {
    const r = await c.tool('changes_since', args)
    assert.equal(r.isError, false, r.text)
    assert.match(r.text, /Start tracking from here/)
    return cursorIn(r.text)
  }
  async function since(c: typeof B, cursor: string, args: Record<string, unknown> = {}) {
    const r = await c.tool('changes_since', { cursor, ...args })
    assert.equal(r.isError, false, r.text)
    return r.text
  }
  const doc = (sections: Record<string, string>) => Object.entries(sections).flatMap(([k, v]) => [h(k), p(v)])

  it('recall: every changed section after N edits, and tokens vs a full re-read', async (t) => {
    const NPAGES = 5
    const NSEC = 20
    const pagesState: Record<string, string>[] = []
    const pgs = []
    for (let i = 0; i < NPAGES; i++) {
      const s: Record<string, string> = {}
      for (let j = 0; j < NSEC; j++) {
        s[`Topic ${i}-${j}`] = `Body of topic ${i}-${j}. ${'Some filler sentence about the topic. '.repeat(6)}Rev 0.`
      }
      pagesState.push(s)
      pgs.push(await newPage(alice, `Recall page ${i}`, doc(s)))
    }
    const cursor = await start()
    // 40 edits over 12 distinct sections in 4 pages (repeats on the same section are merged)
    const changed = new Map<string, string>() // `${page}|Topic` → final text
    for (let e = 1; e <= 40; e++) {
      const pi = e % 4
      const key = `Topic ${pi}-${(e * 7) % 12}`
      pagesState[pi][key] = pagesState[pi][key].replace(/Rev \d+\.$/, `Rev ${e}.`)
      changed.set(`${pi}|${key}`, `Rev ${e}.`)
      await setDoc(pgs[pi].id, doc(pagesState[pi]))
    }
    const out = await since(B, cursor, { budget: 12_000 })
    let found = 0
    // Split the output per page block, then look for the section and its final sentence.
    const blocks = new Map<string, string>()
    for (const part of out.split(/\n(?=page )/)) {
      const id = /^page "[^"]*" ([0-9a-f-]{36})/.exec(part)?.[1]
      if (id) blocks.set(id, part)
    }
    for (const [k, finalSentence] of changed) {
      const [pi, key] = k.split('|')
      const anchor = key.toLowerCase().replace(/\s+/g, '-')
      const part = blocks.get(pgs[Number(pi)].id) ?? ''
      const at = part.indexOf(`  modified ${anchor} `)
      const next = part.indexOf('\n  modified ', at + 1)
      const entry = at >= 0 ? part.slice(at, next < 0 ? undefined : next) : ''
      if (entry.includes(`+ ${finalSentence}`)) found++
    }
    const recall = found / changed.size
    // Full re-read of the changed pages with read_page
    let fullTokens = 0
    for (let i = 0; i < 4; i++) fullTokens += estimateTokens((await B.tool('read_page', { pageId: pgs[i].id })).text)
    const feedTokens = estimateTokens(out)
    t.diagnostic(
      `recall ${found}/${changed.size} = ${recall.toFixed(3)}; changes_since tokens ${feedTokens} vs read_page x4 ${fullTokens} (${((feedTokens / fullTokens) * 100).toFixed(1)}%)`,
    )
    const rows = await db.select({ n: sql<number>`count(*)::int` }).from(schema.pageChanges).where(
      and(sql`${schema.pageChanges.pageId} IN (${sql.join(pgs.map((pg) => sql`${pg.id}::uuid`), sql`, `)})`, gt(schema.pageChanges.seq, 0), eq(schema.pageChanges.kind, 'modified')),
    )
    t.diagnostic(`log rows after 40 edits on ${changed.size} sections: ${rows[0].n}`)
    assert.equal(recall, 1)
    assert.ok(feedTokens < fullTokens)
  })

  it('add then delete cancels; no change says so', async () => {
    const pg = await newPage(alice, 'Cancel page', doc({ Keep: 'stays' }))
    const cursor = await start()
    await setDoc(pg.id, doc({ Keep: 'stays', Temporary: 'short lived' }))
    await setDoc(pg.id, doc({ Keep: 'stays' }))
    const out = await since(B, cursor)
    assert.doesNotMatch(out, /temporary/i)
    assert.match(out, /^No changes since the cursor/)
  })

  it('merges edits of one section within the window, never across an issued cursor', async () => {
    const pg = await newPage(alice, 'Merge page', doc({ Notes: 'v0' }))
    const c0 = await start()
    const seq0 = decodeCursor(c0)!.seq
    const countRows = async () =>
      (
        await db
          .select({ n: sql<number>`count(*)::int` })
          .from(schema.pageChanges)
          .where(and(eq(schema.pageChanges.pageId, pg.id), gt(schema.pageChanges.seq, seq0)))
      )[0].n
    await setDoc(pg.id, doc({ Notes: 'v1' }))
    await setDoc(pg.id, doc({ Notes: 'v2' }))
    assert.equal(await countRows(), 1)
    const out1 = await since(B, c0)
    assert.match(out1, /- v0\n\s+\+ v2/)
    const c1 = cursorIn(out1)
    await setDoc(pg.id, doc({ Notes: 'v3' }))
    assert.equal(await countRows(), 2) // the row behind c1 was not rewritten
    const out2 = await since(B, c1)
    assert.match(out2, /- v2\n\s+\+ v3/)
    // window: a row older than the merge window is not merged into
    await setDoc(pg.id, doc({ Notes: 'v4' }))
    assert.equal(await countRows(), 3) // out2 issued a cursor past the v3 row
    await setDoc(pg.id, doc({ Notes: 'v5' }))
    assert.equal(await countRows(), 3) // merged into the unseen v4 row
    // window: a row older than the merge window is not merged into
    await db.execute(sql`UPDATE page_changes SET changed_at = now() - interval '11 minutes' WHERE page_id = ${pg.id} AND seq = (SELECT max(seq) FROM page_changes WHERE page_id = ${pg.id})`)
    await setDoc(pg.id, doc({ Notes: 'v6' }))
    assert.equal(await countRows(), 4)
    // edited back to where an unseen row started (v5 → v6 → v5): the row is dropped
    await setDoc(pg.id, doc({ Notes: 'v5' }))
    assert.equal(await countRows(), 3)
    const out3 = await since(B, cursorIn(out2))
    assert.match(out3, /- v3\n\s+\+ v5/)
  })

  it('other users’ private pages never appear', async () => {
    const cursor = await start()
    const secret = await newPage(alice, 'Secret plans XYZZY', doc({ Plan: 'hidden' }), { scope: 'private' })
    await setDoc(secret.id, doc({ Plan: 'hidden v2', More: 'also hidden' }))
    const out = await since(B, cursor)
    assert.ok(!out.includes(secret.id))
    assert.doesNotMatch(out, /XYZZY|hidden/)
    // Alice sees her own private page
    const outA = await since(A, cursor)
    assert.ok(outA.includes(secret.id))
  })

  it('shared → private shows only "removed (no longer visible)"', async () => {
    const pg = await newPage(alice, 'Was shared QWERTY', doc({ Info: 'public info' }))
    const cursor = await start()
    await setDoc(pg.id, doc({ Info: 'public info v2' }))
    const r = await app.inject({ method: 'PATCH', url: `/api/pages/${pg.id}`, headers: { cookie: alice.cookie }, payload: { scope: 'private' } })
    assert.equal(r.statusCode, 200, r.body)
    await setDoc(pg.id, doc({ Info: 'private now' }))
    const out = await since(B, cursor)
    assert.ok(out.includes(`page ${pg.id}: removed (no longer visible)`))
    assert.doesNotMatch(out, /QWERTY|public info|private now|info/i)
    // private → shared reaches Bob
    const c2 = cursorIn(out)
    const r2 = await app.inject({ method: 'PATCH', url: `/api/pages/${pg.id}`, headers: { cookie: alice.cookie }, payload: { scope: 'shared' } })
    assert.equal(r2.statusCode, 200, r2.body)
    const out2 = await since(B, c2)
    assert.match(out2, /visibility: private → shared/)
  })

  it('trash and restore', async () => {
    const pg = await newPage(alice, 'Trash me', doc({ X: 'x' }))
    const cursor = await start()
    const r = await app.inject({ method: 'DELETE', url: `/api/pages/${pg.id}`, headers: { cookie: alice.cookie } })
    assert.equal(r.statusCode, 204)
    const out = await since(B, cursor)
    assert.ok(out.includes(`page ${pg.id}: removed (no longer visible)`))
    assert.ok(!out.includes('Trash me'))
    const c2 = cursorIn(out)
    const r2 = await app.inject({ method: 'POST', url: `/api/pages/${pg.id}/restore`, headers: { cookie: alice.cookie } })
    assert.equal(r2.statusCode, 200, r2.body)
    const out2 = await since(B, c2)
    assert.match(out2, /page "Trash me" .*\n\s+restored from trash/)
  })

  it('soft-deleted workspace disappears from the feed', async () => {
    const ws2 = await H.makeWorkspace(alice, [bob])
    const cursor = await start()
    const pg = await newPage(alice, 'In doomed workspace', doc({ D: 'd' }), {}, ws2.id)
    await setDoc(pg.id, doc({ D: 'd2' }))
    assert.ok((await since(B, cursor)).includes(pg.id))
    await db.update(schema.workspaces).set({ deletedAt: new Date() }).where(eq(schema.workspaces.id, ws2.id))
    const out = await since(B, cursor)
    assert.ok(!out.includes(pg.id))
    const r = await B.tool('changes_since', { cursor, workspaceId: ws2.id })
    assert.equal(r.isError, true)
  })

  it('page rename, move, duplicate and provenance (no emails)', async () => {
    const parent = await newPage(alice, 'Parent folder', doc({ P: 'p' }))
    const pg = await newPage(alice, 'Old title', doc({ Body: 'b0' }))
    const cursor = await start()
    const rn = await A.tool('rename_page', { pageId: pg.id, title: 'New title' })
    assert.equal(rn.isError, false, rn.text)
    const mv = await app.inject({ method: 'PATCH', url: `/api/pages/${pg.id}`, headers: { cookie: alice.cookie }, payload: { parentId: parent.id } })
    assert.equal(mv.statusCode, 200, mv.body)
    await withEditActor([pg.id], { userId: alice.id, via: 'Claude Desktop' }, () => setDoc(pg.id, doc({ Body: 'b1' })))
    const dup = await app.inject({ method: 'POST', url: `/api/pages/${parent.id}/duplicate`, headers: { cookie: alice.cookie } })
    assert.equal(dup.statusCode, 200, dup.body)
    const out = await since(B, cursor)
    assert.match(out, /title: "Old title" → "New title"/)
    assert.match(out, /moved under "Parent folder"/)
    assert.match(out, /via Claude Desktop/)
    assert.match(out, /by alice/)
    assert.match(out, /page added: "Copy of Parent folder"/)
    assert.doesNotMatch(out, /@t\.t/)
  })

  it('via shown after MCP writes (rename_page, update_page)', async () => {
    const pg = await newPage(alice, 'Agent edited', doc({ Steps: 'one' }))
    const cursor = await start()
    const rn = await A.tool('rename_page', { pageId: pg.id, title: 'Agent edited v2' })
    assert.equal(rn.isError, false, rn.text)
    const up = await A.tool('update_page', { pageId: pg.id, markdown: '## Steps\n\none\n\ntwo', mode: 'replace' })
    assert.equal(up.isError, false, up.text)
    const out = await since(B, cursor)
    assert.match(out, /page "Agent edited v2" [0-9a-f-]{36} \(by alice via Claude Desktop\)/)
    assert.match(out, /modified steps \(Steps\)\n\s+one\n\s+\+ two/)
  })

  it('deterministic: identical text except the last (cursor) line; invisible edits elsewhere change nothing', async () => {
    const pg = await newPage(alice, 'Stable page', doc({ Alpha: 'a0', Beta: 'b0' }))
    const cursor = await start()
    await withEditActor([pg.id], { userId: alice.id, via: 'Claude Desktop' }, () => setDoc(pg.id, doc({ Alpha: 'a1', Beta: 'b0', Gamma: 'g' })))
    await setDoc(pg.id, doc({ Alpha: 'a1', Beta: 'b1', Gamma: 'g' }))
    const body = (t: string) => {
      const ls = t.split('\n')
      assert.match(ls[ls.length - 1], /^next cursor: \S+$/)
      return ls.slice(0, -1).join('\n')
    }
    const o1 = await since(B, cursor)
    const o2 = await since(B, cursor)
    assert.equal(body(o2), body(o1))
    // Another workspace Bob is not in, and Alice's private page in Bob's workspace
    const carol = await H.makeUser('carol')
    const wsC = await H.makeWorkspace(carol)
    const other = await newPage(carol, 'Carol page', doc({ X: 'x' }), {}, wsC.id)
    await setDoc(other.id, doc({ X: 'x2' }))
    const priv = await newPage(alice, 'Alice private', doc({ P: 'p' }), { scope: 'private' })
    await setDoc(priv.id, doc({ P: 'p2' }))
    const o3 = await since(B, cursor)
    assert.equal(body(o3), body(o1))
    // Start/resync/no-change texts also end with the cursor line
    assert.match((await B.tool('changes_since', {})).text, /\ncursor: \S+$/)
    assert.match(await since(B, cursorIn(o3)), /^No changes since the cursor\.\nnext cursor: \S+$/)
  })

  it('read-only tokens can call it', async () => {
    const r = await Bro.tool('changes_since', {})
    assert.equal(r.isError, false, r.text)
  })

  it('budget: overflow is listed without detail; cursors continue past the row cap', async () => {
    const big: Record<string, string> = {}
    for (let j = 0; j < 30; j++) big[`Big ${j}`] = `${'Original sentence number one here. '.repeat(20)}`
    const pg = await newPage(alice, 'Budget page', doc(big))
    const cursor = await start()
    for (let j = 0; j < 30; j++) big[`Big ${j}`] = `${'Rewritten sentence number two here. '.repeat(20)}`
    await setDoc(pg.id, doc(big))
    const out = await since(B, cursor, { budget: 600 })
    assert.match(out, /truncated: \d+ changes listed without detail/)
    assert.ok(estimateTokens(out) <= 600 + 50, `tokens ${estimateTokens(out)}`)

    // Row cap: 2100 rows logged at once; following next cursors lists every anchor exactly once or more, none missing.
    const pg2 = await newPage(alice, 'Many rows', doc({ Z: 'z' }))
    const c0 = await start()
    const rows = Array.from({ length: 2100 }, (_, i) => ({
      workspaceId: ws.id,
      pageId: pg2.id,
      anchor: `row-${i}`,
      headingPath: `Row ${i}`,
      kind: 'removed',
      beforeText: 'x',
      scope: 'shared',
      ownerId: alice.id,
    }))
    for (let i = 0; i < rows.length; i += 500) await db.insert(schema.pageChanges).values(rows.slice(i, i + 500))
    const seen = new Set<string>()
    let cur = c0
    for (let k = 0; k < 40; k++) {
      const o = await since(B, cur, { budget: 12_000, detail: 'none' })
      for (const m of o.matchAll(/removed (row-\d+)/g)) seen.add(m[1])
      cur = cursorIn(o)
      if (!/more changes remain/.test(o)) break
    }
    assert.equal(seen.size, 2100)
  })

  it('a cut always advances the cursor (page-level unit listed before an older section unit)', async () => {
    const t1 = '가'.repeat(300)
    const t2 = '나'.repeat(300)
    const pg = await newPage(alice, t1, doc({ S: 's0' }))
    const cursor = await start()
    await setDoc(pg.id, doc({ S: 's1' })) // older row: section
    const r = await app.inject({ method: 'PATCH', url: `/api/pages/${pg.id}`, headers: { cookie: alice.cookie }, payload: { title: t2 } })
    assert.equal(r.statusCode, 200, r.body)
    let cur = cursor
    let calls = 0
    for (;;) {
      const o = await since(B, cur, { budget: 300 })
      const next = cursorIn(o)
      assert.ok(decodeCursor(next)!.seq > decodeCursor(cur)!.seq || !/more changes remain/.test(o), o)
      cur = next
      if (!/more changes remain/.test(o)) break
      assert.ok(++calls < 10, 'cursor loop did not terminate')
    }
  })

  it('retention: an old cursor gets resync_required with a fresh cursor', async () => {
    const old = encodeCursor({ seq: 1, at: Date.now() - 31 * 24 * 60 * 60 * 1000, ws: null })
    const out = await since(B, old)
    assert.match(out, /^resync_required: /)
    assert.match(out, /list_pages/)
    const fresh = cursorIn(out)
    assert.match(out, /\nfresh cursor: \S+$/)
    assert.match(await since(B, fresh), /^No changes since the cursor/)
    const bad = await B.tool('changes_since', { cursor: 'garbage' })
    assert.equal(bad.isError, true)
    assert.match(bad.text, /without a cursor/)
    // housekeeping removes only rows older than the window
    const pg = await newPage(alice, 'Old rows', doc({ O: 'o' }))
    // Huge retention so the shared scratch DB loses nothing but this fixture row.
    await db.insert(schema.pageChanges).values({ workspaceId: ws.id, pageId: pg.id, anchor: 'o', kind: 'modified', scope: 'shared', changedAt: new Date(Date.now() - 11_000 * 86_400_000) })
    const n = await purgeOldChanges(new Date(), 10_000)
    assert.ok(n >= 1)
    const left = await db.select({ n: sql<number>`count(*)::int` }).from(schema.pageChanges).where(eq(schema.pageChanges.pageId, pg.id))
    assert.equal(left[0].n, 1) // the page_added row of today
  })
})
