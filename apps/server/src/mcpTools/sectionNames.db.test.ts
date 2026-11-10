// Which section a write means when its name passed to another section (docs/adr/1960-*): a short
// anchor from find_context (ADR 1212) or an exact anchor that a new heading took over is refused
// with the sections it could mean unless the version the agent read picks one; the usual
// find_context → patch_section flow needs no extra call. Also the find_context → other tools round
// trip of the printed 8-character page id and short anchor (ADR 1906, 1941).
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.DATA_DIR ||= `${process.env.TMPDIR || '/tmp'}/inkling-sectionnames-${process.pid}`

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

const HAS_DB = !!process.env.DATABASE_URL

describe('[db] section names that moved to another section (ADR 1960)', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const h = await import('./testHarness')
  const { db, closeDb } = await import('../db/index')
  const schema = await import('../db/schema')
  const { sha256 } = await import('../oauth')
  const { eq } = await import('drizzle-orm')
  const { drainChangeLog } = await import('../context/changeLog')
  const collab = await import('../collab')
  const app = await h.buildTestApp()

  type U = Awaited<ReturnType<typeof h.makeUser>>
  let alice: U
  let bob: U
  let ws: { id: string }
  let A: Awaited<ReturnType<typeof h.connectMcp>>
  let B: Awaited<ReturnType<typeof h.connectMcp>>
  // the connection's user as the /mcp handler builds it (claims need the grant)
  const agent = async (u: U, client: string) => {
    const token = await h.mintToken(u, 'notes', client)
    const [g] = await db.select({ id: schema.oauthGrants.id }).from(schema.oauthGrants).where(eq(schema.oauthGrants.accessHash, sha256(token)))
    return h.connectMcp(app, u, token, { user: { ...u, via: client, grantId: g.id } })
  }
  before(async () => {
    alice = await h.makeUser('Alice')
    bob = await h.makeUser('Bob')
    ws = await h.makeWorkspace(alice, [bob])
    A = await agent(alice, 'Agent A')
    B = await agent(bob, 'Agent B')
  })
  after(async () => {
    await A.close()
    await B.close()
    await collab.destroyCollab()
    await app.close()
    await closeDb()
  })

  const create = async (title: string, markdown: string) => {
    const r = await A.tool('create_page', { workspaceId: ws.id, title, markdown })
    assert.equal(r.isError, false, r.text)
    await drainChangeLog()
    return (JSON.parse(r.text) as { id: string }).id
  }
  /** The first result of find_context, as an agent reads it: printed page id, §anchor, v. */
  const found = async (query: string) => {
    const out = (await A.tool('find_context', { query })).text
    const m = /\(page ([0-9a-f]{8,}); §(\S+) v=([0-9a-f]+)/.exec(out)
    assert.ok(m, out)
    return { page: m[1], anchor: m[2], v: m[3] }
  }
  const section = async (pageId: string, anchor: string) => (await A.tool('read_page', { pageId, section: anchor })).text
  const versionOf = (text: string) => /v=([0-9a-f]{12})/.exec(text)![1]

  it('the counterexample: a new "# Beta / ## Decided" takes the short anchor; the write is refused, then lands where the error points', async () => {
    const id = await create('One decided', '# Alpha\n\n## Decided\n\nkeep me qorvexite')
    const f = await found('qorvexite')
    assert.equal(f.anchor, 'decided', 'find_context prints the short anchor')
    assert.equal(f.page, id.slice(0, 8))
    // another agent inserts a second "Decided" under a new top heading: the old section becomes beta/decided~2
    const ins = await B.tool('patch_section', { pageId: id, section: 'alpha', mode: 'insert_after', markdown: '# Beta\n\n## Decided\n\nnew one' })
    assert.equal(ins.isError, false, ins.text)

    // 0.15.0 appended to the new beta/decided here; now: refused, both sections named, nothing written
    const r = await A.tool('patch_section', { pageId: f.page, section: f.anchor, mode: 'append', markdown: 'appended by A' })
    assert.equal(r.isError, true, r.text)
    assert.match(r.text, /now names §beta\/decided, but §beta\/decided~2 answered to that name before/)
    assert.match(r.text, /Nothing was written\. Read the one you mean with read_page\(pageId, section=<anchor>\) and retry with that anchor and its version as baseVersion/)
    // the version read with it does not pick either: the heading path of the old section changed
    const rv = await A.tool('patch_section', { pageId: f.page, section: f.anchor, mode: 'append', markdown: 'appended by A', baseVersion: f.v })
    assert.equal(rv.isError, true, rv.text)
    assert.match(rv.text, new RegExp(`none of them has version ${f.v}`))
    assert.doesNotMatch(rv.text, /v=[0-9a-f]{12}/, 'the error hands out no version')
    // the same name in the other section tools
    const batch = await A.tool('patch_sections', { pageId: f.page, edits: [{ section: f.anchor, mode: 'append', markdown: 'appended by A' }] })
    assert.equal(batch.isError, true, batch.text)
    assert.match(batch.text, /answered to that name before/)
    const claim = await A.tool('claim_section', { pageId: f.page, section: f.anchor })
    assert.equal(claim.isError, true, claim.text)
    assert.match(claim.text, /§beta\/decided~2/)
    assert.doesNotMatch(claim.text, /baseVersion/, 'claims take no version: the error does not ask for one')
    const comment = await A.tool('add_comment', { pageId: f.page, section: f.anchor, text: 'which one?' })
    assert.equal(comment.isError, true, comment.text)
    assert.match(comment.text, /§beta\/decided~2/)
    for (const t of [await section(id, 'beta/decided'), await section(id, 'beta/decided~2')]) assert.doesNotMatch(t, /appended by A/)

    // doing what the error says: read the one meant, retry with its anchor and version
    const old = await section(f.page, 'beta/decided~2')
    assert.match(old, /keep me/)
    const ok = await A.tool('patch_section', { pageId: f.page, section: 'beta/decided~2', mode: 'append', markdown: 'appended by A', baseVersion: versionOf(old) })
    assert.equal(ok.isError, false, ok.text)
    assert.match(await section(id, 'beta/decided~2'), /keep me[^]*appended by A/)
    assert.doesNotMatch(await section(id, 'beta/decided'), /appended by A/)
    // the full anchor of the time still follows the moved section (ADR 1501)
    const full = await A.tool('patch_section', { pageId: id, section: 'alpha/decided', mode: 'append', markdown: 'via the old full anchor' })
    assert.equal(full.isError, false, full.text)
    assert.match(await section(id, 'beta/decided~2'), /via the old full anchor/)
    assert.equal(
      (await A.tool('claim_section', { pageId: f.page, section: 'beta/decided~2' })).isError,
      false,
      'a full anchor claims without a version',
    )
  })

  it('a short anchor that fits two sections now: refused without a version, the version read picks the section (no extra call)', async () => {
    const id = await create('Two decided', '# Alpha\n\n## Decided\n\nalpha body zentrofil')
    const f = await found('zentrofil')
    assert.equal(f.anchor, 'decided')
    const page = await B.tool('read_page', { pageId: id })
    const pv = /^- version: (\S+)$/m.exec(page.text)![1]
    const rep = await B.tool('update_page', {
      pageId: id,
      mode: 'replace',
      baseVersion: pv,
      markdown: '# Beta\n\n## Decided\n\nbeta body\n\n# Alpha\n\n## Decided\n\nalpha body zentrofil',
    })
    assert.equal(rep.isError, false, rep.text)
    const r = await A.tool('patch_section', { pageId: f.page, section: f.anchor, mode: 'append', markdown: 'note from A' })
    assert.equal(r.isError, true, r.text)
    assert.match(r.text, /Section "decided" fits 2 sections: §beta\/decided, §alpha\/decided/)
    // the v=… find_context printed next to the anchor: unchanged section, same version → that one
    const ok = await A.tool('patch_section', { pageId: f.page, section: f.anchor, mode: 'append', markdown: 'note from A', baseVersion: f.v })
    assert.equal(ok.isError, false, ok.text)
    assert.match(ok.text, /§alpha\/decided is now v=/)
    assert.match(await section(id, 'alpha/decided'), /note from A/)
    assert.doesNotMatch(await section(id, 'beta/decided'), /note from A/)
  })

  it('an exact anchor a new heading took over (`decided` → `decided~2`): refused without a version, the version picks the old section', async () => {
    const id = await create('Top decided', 'intro line\n\n## Decided\n\nkeep me plumbrix')
    const f = await found('plumbrix')
    assert.equal(f.anchor, 'decided')
    const ins = await B.tool('patch_section', { pageId: id, section: '_intro', mode: 'insert_after', markdown: '## Decided\n\nnew one' })
    assert.equal(ins.isError, false, ins.text)
    const r = await A.tool('patch_section', { pageId: f.page, section: 'decided', mode: 'append', markdown: 'from A' })
    assert.equal(r.isError, true, r.text)
    assert.match(r.text, /now names §decided, but §decided~2 answered to that name before/)
    // heading path and body unchanged: the version read is the old section's
    const ok = await A.tool('patch_section', { pageId: f.page, section: 'decided', mode: 'append', markdown: 'from A', baseVersion: f.v })
    assert.equal(ok.isError, false, ok.text)
    assert.match(ok.text, /§decided~2 is now v=/)
    assert.match(await section(id, 'decided~2'), /keep me[^]*from A/)
    assert.doesNotMatch(await section(id, 'decided'), /from A/)
    // claims and comments take no version: an exact anchor is used as it is
    assert.equal((await A.tool('claim_section', { pageId: f.page, section: 'decided' })).isError, false)
  })

  it('the usual flow is unchanged: printed page id and short anchor go to read_page, patch_section, add_comment, claim_section', async () => {
    const id = await create('Gamma notes', '# Gamma\n\n## Notes\n\nfoo glimmerax')
    const f = await found('glimmerax')
    assert.equal(f.anchor, 'notes')
    assert.equal(f.page.length, 8)
    assert.match(await section(f.page, f.anchor), /glimmerax/)
    const ap = await A.tool('patch_section', { pageId: f.page, section: f.anchor, mode: 'append', markdown: 'appended without a version' })
    assert.equal(ap.isError, false, ap.text)
    const v = versionOf(await section(f.page, f.anchor))
    const rp = await A.tool('patch_section', { pageId: f.page, section: f.anchor, mode: 'replace', markdown: 'foo glimmerax, replaced', baseVersion: v })
    assert.equal(rp.isError, false, rp.text)
    const cm = await A.tool('add_comment', { pageId: f.page, section: f.anchor, text: 'looks right' })
    assert.equal(cm.isError, false, cm.text)
    assert.equal((JSON.parse(cm.text) as { section: string }).section, 'gamma/notes')
    const cl = await A.tool('claim_section', { pageId: f.page, section: f.anchor })
    assert.equal(cl.isError, false, cl.text)
    assert.match(cl.text, /Claimed §gamma\/notes of page/)
    assert.equal((await A.tool('release_section', { pageId: f.page, section: f.anchor })).isError, false)
    const ps = await A.tool('patch_sections', { pageId: f.page, edits: [{ section: f.anchor, mode: 'append', markdown: 'batch line' }] })
    assert.equal(ps.isError, false, ps.text)
    assert.match(await section(id, 'gamma/notes'), /replaced[^]*batch line/)
  })

  it('8-character ids on a range-limited connection: an out-of-range page never makes a prefix ambiguous or shows in an error', async () => {
    const { randomBytes } = await import('node:crypto')
    const { blocksToStateBuffer } = await import('../md/convert')
    const P = randomBytes(4).toString('hex')
    const para = (t: string) => ({ type: 'paragraph', content: [{ type: 'text', text: t, styles: {} }] })
    const insert = async (id: string, title: string, parentId: string | null) => {
      await db.insert(schema.pages).values({ id, workspaceId: ws.id, title, createdBy: alice.id, kind: 'doc', scope: 'shared', parentId })
      await db.insert(schema.pageDocs).values({ pageId: id, state: blocksToStateBuffer([para(title)] as never) })
    }
    const root = `${P}-0000-4000-8000-0a0000000000`
    const inside = `${P}-0000-4000-8000-0b0000000000`
    const outside = `${P}-0000-4000-8000-0c0000000000`
    await insert(root, 'Range root', null)
    await insert(inside, 'Inside child', root)
    await insert(outside, 'Outside twin', null)
    // a subtree grant on the root, as tokenRange.db.test.ts sets it up
    const token = await h.mintToken(alice, 'notes', 'Ranged Agent')
    await db.update(schema.oauthGrants).set({ rangeKind: 'subtree', rangePageId: root }).where(eq(schema.oauthGrants.accessHash, sha256(token)))
    const { getBearerUser } = await import('../oauth')
    const user = (await getBearerUser(token))!
    assert.equal(user.range?.kind, 'subtree')
    const R = await h.connectMcp(app, user, token)
    try {
      // the 8 characters all three share: two candidates (both in range), never the out-of-range twin
      const both = await R.tool('read_page', { pageId: P })
      assert.equal(both.isError, true)
      assert.match(both.text, /matches 2 pages/)
      assert.ok(!both.text.includes(outside) && !both.text.includes('Outside twin'), both.text)
      const one = await R.tool('read_page', { pageId: inside.slice(0, 26) })
      assert.equal(one.isError, false, one.text)
      assert.match(one.text, /Inside child/)
      const out = await R.tool('read_page', { pageId: outside.slice(0, 26) })
      assert.equal(out.isError, true)
      assert.match(out.text, /no page you can see has an id starting with/)
      assert.ok(!out.text.includes('Outside twin'), out.text)
    } finally {
      await R.close()
    }
  })

  it('no false alarm: a section renamed into the name, or a deleted one replaced under it, writes as before', async () => {
    const id = await create('Renames', '# P\n\n## Draft\n\nfirst body vexlomir\n\n## Other\n\nsecond')
    // the heading "Draft" becomes "Decided" (renamed into the name; nothing else ever had it)
    const d = await section(id, 'p/draft')
    const rn = await A.tool('patch_section', { pageId: id, section: 'p/draft', mode: 'replace', markdown: '## Decided\n\nfirst body vexlomir', baseVersion: versionOf(d) })
    assert.equal(rn.isError, false, rn.text)
    await drainChangeLog()
    assert.equal((await A.tool('patch_section', { pageId: id, section: 'decided', mode: 'append', markdown: 'one' })).isError, false)
    // deleted, then a new "Decided" under P: the old one is gone, so it is not a rival (as ADR 1501 takes it over)
    const cur = await section(id, 'p/decided')
    assert.equal((await A.tool('patch_section', { pageId: id, section: 'p/decided', mode: 'delete', baseVersion: versionOf(cur) })).isError, false)
    assert.equal((await A.tool('patch_section', { pageId: id, section: 'p/other', mode: 'insert_after', markdown: '## Decided\n\nreborn' })).isError, false)
    await drainChangeLog()
    const w = await A.tool('patch_section', { pageId: id, section: 'decided', mode: 'append', markdown: 'two' })
    assert.equal(w.isError, false, w.text)
    assert.match(await section(id, 'p/decided'), /reborn[^]*two/)
  })
})
