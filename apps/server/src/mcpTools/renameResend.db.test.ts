// Renumbered headings do not send unchanged bodies again (docs/adr/2597-*): an agent replaces a
// 10-section page with every heading renumbered ("1. Alpha" → "2. Alpha"); a reader holding the old
// anchors gets `§old → §new v=…` lines from read_page(knownSections) and changes_since, a body only
// where the body changed; a replace that only renumbers or drops sections no longer resends the
// sections that moved up as "body changed"; update_page replace says how many bodies changed.
// Run: cd apps/server && DATABASE_URL=postgres://… node --import tsx --test src/mcpTools/renameResend.db.test.ts
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.APP_URL ||= 'https://notes.example.com'
process.env.DATA_DIR ||= `${process.env.TMPDIR || '/tmp'}/inkling-rename-resend-${process.pid}`

import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'

const HAS_DB = !!process.env.DATABASE_URL

describe('[db] renamed sections without resending bodies', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const h = await import('./testHarness')
  const { db, closeDb } = await import('../db/index')
  const schema = await import('../db/schema')
  const { eq } = await import('drizzle-orm')
  const { drainChangeLog } = await import('../context/changeLog')
  const { reindexPageChunks } = await import('../context/chunkIndex')
  const { blocksToStateBuffer, stateToBlocks } = await import('../md/convert')
  const collab = await import('../collab')
  const app = await h.buildTestApp()
  const alice = await h.makeUser('alice')
  const bob = await h.makeUser('bob')
  const A = await h.connectMcp(app, alice, await h.mintToken(alice, 'notes', 'Reader Agent'))
  const B = await h.connectMcp(app, bob, await h.mintToken(bob, 'notes', 'Writer Agent'), { user: { ...bob, via: 'Writer Agent' } })
  after(async () => {
    await A.close()
    await B.close()
    await collab.destroyCollab()
    await app.close()
    await closeDb()
  })

  const TOPICS = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel', 'India', 'Juliet']
  const body = (i: number, salt = '') => `${TOPICS[i]}${salt} body line one.\n\n${TOPICS[i]}${salt} body line two with more words.`
  const md = (secs: { n: number; i: number; salt?: string }[]) => secs.map((s) => `## ${s.n}. ${TOPICS[s.i]}\n\n${body(s.i, s.salt)}`).join('\n\n')
  const base = TOPICS.map((_, i) => ({ n: i + 1, i }))
  const slug = (n: number, i: number) => `${n}-${TOPICS[i].toLowerCase()}`

  const outline = async (pageId: string) => {
    const r = await A.tool('read_page', { pageId, outline: true })
    assert.equal(r.isError, false, r.text)
    return Object.fromEntries([...r.text.matchAll(/- §(\S+) .* v=([0-9a-f]+)/g)].map((m) => [m[1], m[2]]))
  }
  /** A fresh workspace and page; the reader's cursor and section versions before the change. */
  async function setup(name: string) {
    const ws = await h.makeWorkspace(alice, [bob])
    const created = await B.tool('create_page', { workspaceId: ws.id, title: `Plan ${name}`, markdown: md(base) })
    assert.equal(created.isError, false, created.text)
    const pageId = (JSON.parse(created.text) as { id: string }).id
    await drainChangeLog()
    const start = await A.tool('changes_since', { workspaceId: ws.id })
    const cursor = /cursor: (\S+)$/.exec(start.text.trim())![1]
    return { ws, pageId, cursor, known: await outline(pageId) }
  }
  const replace = async (pageId: string, markdown: string) => {
    const r = await B.tool('update_page', { pageId, mode: 'replace', markdown })
    assert.equal(r.isError, false, r.text)
    await drainChangeLog()
    return r.text
  }
  const noBodyOf = (text: string, topics: string[]) => {
    for (const t of topics) assert.doesNotMatch(text, new RegExp(`${t} body line`), `${t}'s body was sent again:\n${text}`)
  }

  it('(c) every heading renumbered, bodies equal: rename lines with the new versions and no bodies', async () => {
    const s = await setup('c')
    const out = await replace(s.pageId, md(base.map((x) => ({ ...x, n: x.n + 1 }))))
    assert.match(out, /\nhint: 0 of 10 sections changed their body \(headings and order aside\); patch_sections /)
    const now = await outline(s.pageId)

    const ks = await A.tool('read_page', { pageId: s.pageId, knownSections: s.known })
    assert.equal(ks.isError, false, ks.text)
    assert.match(ks.text, /0 changed or new, 0 unchanged, 10 renamed \(body unchanged\), 0 removed of your 10 known sections/)
    for (const x of base) assert.ok(ks.text.includes(`§${slug(x.n, x.i)} → §${slug(x.n + 1, x.i)} v=${now[slug(x.n + 1, x.i)]}`), ks.text)
    noBodyOf(ks.text, TOPICS)
    // deterministic
    assert.equal((await A.tool('read_page', { pageId: s.pageId, knownSections: s.known })).text, ks.text)

    for (const detail of [undefined, 'full', 'none']) {
      const cs = await A.tool('changes_since', { workspaceId: s.ws.id, cursor: s.cursor, ...(detail ? { detail } : {}) })
      for (const x of base) assert.ok(cs.text.includes(`renamed ${slug(x.n, x.i)} → ${slug(x.n + 1, x.i)} v=${now[slug(x.n + 1, x.i)]} (`), cs.text)
      noBodyOf(cs.text, TOPICS)
    }
  })

  it('(d) renumbered and one body changed: only that body (as before), the rest as rename lines', async () => {
    const s = await setup('d')
    const out = await replace(s.pageId, md(base.map((x) => ({ ...x, n: x.n + 1, salt: x.i === 3 ? 'X' : '' }))))
    assert.match(out, /\nhint: 1 of 10 sections changed their body/)
    const now = await outline(s.pageId)
    const ks = await A.tool('read_page', { pageId: s.pageId, knownSections: s.known })
    assert.match(ks.text, /1 changed or new, 0 unchanged, 9 renamed \(body unchanged\), 1 removed of your 10 known sections/)
    assert.match(ks.text, /DeltaX body line one/)
    noBodyOf(ks.text, TOPICS.filter((t) => t !== 'Delta'))
    assert.ok(ks.text.includes(`§1-alpha → §2-alpha v=${now['2-alpha']}`), ks.text)

    const cs = await A.tool('changes_since', { workspaceId: s.ws.id, cursor: s.cursor })
    assert.match(cs.text, /renamed 4-delta → 5-delta \(5\. Delta\), body changed/)
    assert.match(cs.text, /\+ DeltaX body line one\./)
    assert.ok(cs.text.includes(`renamed 1-alpha → 2-alpha v=${now['2-alpha']} (2. Alpha)`), cs.text)
    noBodyOf(cs.text.replace(/[-+] Delta.*\n/g, ''), TOPICS.filter((t) => t !== 'Delta'))
  })

  it('(e) two sections dropped and the rest renumbered: removed + renamed, no body resent', async () => {
    const s = await setup('e')
    const kept = base.filter((x) => x.i !== 2 && x.i !== 6).map((x, k) => ({ ...x, n: k + 1 }))
    const out = await replace(s.pageId, md(kept))
    assert.match(out, /\nhint: 0 of 8 sections changed their body/)
    const now = await outline(s.pageId)
    const cs = await A.tool('changes_since', { workspaceId: s.ws.id, cursor: s.cursor })
    assert.match(cs.text, /\n {2}removed 3-charlie \(3\. Charlie\)\n/)
    assert.match(cs.text, /\n {2}removed 7-golf \(7\. Golf\)\n/)
    assert.ok(cs.text.includes(`renamed 4-delta → 3-delta v=${now['3-delta']} (3. Delta)`), cs.text)
    assert.ok(cs.text.includes(`renamed 8-hotel → 6-hotel v=${now['6-hotel']} (6. Hotel)`), cs.text)
    assert.doesNotMatch(cs.text, /body changed/)
    noBodyOf(cs.text, TOPICS)

    const ks = await A.tool('read_page', { pageId: s.pageId, knownSections: s.known })
    // 1. Alpha and 2. Bravo kept their numbers
    assert.match(ks.text, /0 changed or new, 2 unchanged, 6 renamed \(body unchanged\), 2 removed of your 10 known sections/)
    assert.match(ks.text, /removed: §3-charlie, §7-golf/)
    noBodyOf(ks.text, TOPICS)
  })

  it('a heading renumbered in the editor (same block ids) reads the same way', async () => {
    const s = await setup('w')
    const [row] = await db.select().from(schema.pageDocs).where(eq(schema.pageDocs.pageId, s.pageId))
    const blocks = stateToBlocks(row.state) as { type: string; content: { text: string }[] }[]
    for (const b of blocks) if (b.type === 'heading') b.content[0].text = b.content[0].text.replace(/^(\d+)\./, (_, n: string) => `${Number(n) + 1}.`)
    await db.update(schema.pageDocs).set({ state: blocksToStateBuffer(blocks as never) }).where(eq(schema.pageDocs.pageId, s.pageId))
    await reindexPageChunks(s.pageId, blocks as never)
    await drainChangeLog()
    const now = await outline(s.pageId)
    const ks = await A.tool('read_page', { pageId: s.pageId, knownSections: s.known })
    assert.match(ks.text, /10 renamed \(body unchanged\)/)
    noBodyOf(ks.text, TOPICS)
    const cs = await A.tool('changes_since', { workspaceId: s.ws.id, cursor: s.cursor })
    assert.ok(cs.text.includes(`renamed 10-juliet → 11-juliet v=${now['11-juliet']} (11. Juliet)`), cs.text)
  })

  it('a body edited before the renumbering: the reader holding the older version gets the body', async () => {
    const s = await setup('stale')
    const p = await B.tool('patch_section', { pageId: s.pageId, section: '1-alpha', mode: 'append', markdown: 'Added later.' })
    assert.equal(p.isError, false, p.text)
    await drainChangeLog()
    const mid = await outline(s.pageId)
    const page = await B.tool('read_page', { pageId: s.pageId })
    const v = /- version: ([0-9a-f]+)/.exec(page.text)![1]
    const r = await B.tool('update_page', { pageId: s.pageId, mode: 'replace', baseVersion: v, markdown: md(base.map((x) => ({ ...x, n: x.n + 1 }))).replace('Alpha body line two with more words.', 'Alpha body line two with more words.\n\nAdded later.') })
    assert.equal(r.isError, false, r.text)
    await drainChangeLog()
    const stale = await A.tool('read_page', { pageId: s.pageId, knownSections: s.known })
    assert.match(stale.text, /1 changed or new, 0 unchanged, 9 renamed \(body unchanged\), 1 removed/)
    assert.match(stale.text, /§2-alpha v=\S+ › 2\. Alpha\n## 2\. Alpha\n\nAlpha body line one\./)
    // holding the version after the edit, the same renumbering is a rename only
    const fresh = await A.tool('read_page', { pageId: s.pageId, knownSections: { ...s.known, '1-alpha': mid['1-alpha'] } })
    assert.match(fresh.text, /0 changed or new, 0 unchanged, 10 renamed \(body unchanged\)/)
  })

  it('a replace that rewrites every section has no hint; a page with fewer than 3 sections has none either', async () => {
    const s = await setup('all')
    const out = await replace(s.pageId, md(base.map((x) => ({ ...x, salt: 'Z' }))))
    assert.doesNotMatch(out, /hint:/)
    const small = await B.tool('create_page', { workspaceId: s.ws.id, title: 'Small', markdown: '## One\n\nx\n\n## Two\n\ny' })
    const id = (JSON.parse(small.text) as { id: string }).id
    await drainChangeLog()
    assert.doesNotMatch(await replace(id, '## One\n\nx\n\n## Two\n\ny2'), /hint:/)
  })
})
