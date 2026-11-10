// Agent retrieval tools end to end through the MCP server (docs/adr/0926-0930):
// section index, find_context (+ evaluation numbers), read_page outline/section, read_pages,
// compact list/search output, patch_section with versions and concurrent edits.
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.DATA_DIR ||= `${process.env.TMPDIR || '/tmp'}/inkling-context-${process.pid}`

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import * as Y from 'yjs'

const HAS_DB = !!process.env.DATABASE_URL

describe('[db] agent context tools', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const h = await import('../mcpTools/testHarness')
  const { db, closeDb } = await import('../db/index')
  const schema = await import('../db/schema')
  const { eq, and } = await import('drizzle-orm')
  const { ALL_EVAL_PAGES: RAW_PAGES, EVAL_QUESTIONS, padPages } = await import('./evalSet')
  // Padded to typical wiki-page length (1–2k tokens); scripts/context-bench.ts also reports the unpadded set.
  const EVAL_PAGES = padPages(RAW_PAGES)
  const { runEval } = await import('./evalRun')
  const { reindexPageChunks, chunkIndexStats } = await import('./chunkIndex')
  const { stateToBlocks } = await import('../md/convert')
  const { estimateTokens } = await import('./tokens')
  const collab = await import('../collab')
  const app = await h.buildTestApp()

  after(async () => {
    await collab.destroyCollab()
    await app.close()
    await closeDb()
  })

  let owner: Awaited<ReturnType<typeof h.makeUser>>
  let other: Awaited<ReturnType<typeof h.makeUser>>
  let ws: { id: string }
  let mcp: Awaited<ReturnType<typeof h.connectMcp>>
  const idByTitle = new Map<string, string>()

  before(async () => {
    owner = await h.makeUser('owner')
    other = await h.makeUser('other')
    ws = await h.makeWorkspace(owner, [other])
    mcp = await h.connectMcp(app, owner, await h.mintToken(owner))
    for (const p of EVAL_PAGES) {
      const r = await mcp.tool('create_page', { workspaceId: ws.id, title: p.title, markdown: p.markdown })
      assert.equal(r.isError, false, r.text)
      idByTitle.set(p.title, (JSON.parse(r.text) as { id: string }).id)
      // create_page has no aliases argument (docs/adr/1701-*)
      if (p.aliases?.length) await db.update(schema.pages).set({ aliases: p.aliases }).where(eq(schema.pages.id, idByTitle.get(p.title)!))
    }
  })

  it('import builds the section index with readable anchors', async () => {
    const rows = await db
      .select({ anchor: schema.pageChunks.anchor })
      .from(schema.pageChunks)
      .where(eq(schema.pageChunks.pageId, idByTitle.get('Deploy runbook')!))
    assert.deepEqual(
      rows.map((r) => r.anchor).filter((a) => !a.startsWith('appendix')).sort(),
      ['_intro', 'database-migrations', 'prerequisites', 'rollback', 'rolling-deploy'],
    )
  })

  it('evaluation: find_context vs the old search → read_page flow', async () => {
    const s = await runEval(mcp.tool, EVAL_QUESTIONS, idByTitle)
    console.log('[eval] questions', s.n)
    console.log('[eval] before', JSON.stringify(s.before))
    console.log('[eval] after ', JSON.stringify(s.after))
    for (const r of s.rows.filter((x) => !x.after.found || x.after.sectionRank !== 1)) {
      console.log('[eval] miss/rank', r.after.sectionRank, r.q)
    }
    assert.ok(s.after.success >= 0.9, `success ${s.after.success}`)
    assert.ok(s.after.sectionAt3 >= 0.85, `section@3 ${s.after.sectionAt3}`)
    assert.ok(s.after.meanTokens < s.before.meanTokens, 'fewer tokens than the old flow')
    assert.ok(s.after.meanCalls < s.before.meanCalls, 'fewer calls than the old flow')
  })

  it('rank metrics (dev/test) and the field case: common words + a rare key phrase (docs/adr/1210-1213)', async () => {
    const { runRankEval, rankedSections, samePage, sameSection } = await import('./evalRun')
    const r = await runRankEval(mcp.tool, EVAL_QUESTIONS, idByTitle)
    console.log('[rank] dev ', JSON.stringify(r.dev))
    console.log('[rank] test', JSON.stringify(r.test))
    console.log('[rank] tags', JSON.stringify(r.tags))
    assert.ok(r.dev.mrr >= 0.8 && r.test.mrr >= 0.75, 'MRR')
    assert.ok(r.dev.recallAt5 >= 0.85 && r.test.recallAt5 >= 0.8, 'recall@5')

    const out = (await mcp.tool('find_context', { query: '서울 AI 해커톤 팀 구성', budget: 1500 })).text
    const shown = rankedSections(out)
    const req = idByTitle.get('00 대회요강')!
    const at = shown.findIndex((x) => samePage(req, x.pageId) && sameSection('요강-요약/준비-사항/우리-팀-체크리스트', x.anchor)) + 1
    assert.ok(at >= 1 && at <= 3, `checklist at ${at}:\n${out}`)
    const memo = idByTitle.get('03 방향 메모')!
    // page ids are printed as their 8-character prefix (docs/adr/1906-*)
    assert.ok(out.includes(memo.slice(0, 8)), 'the decisions section is shown or listed under Also relevant')
    // no page fills the results: at most two sections of one page
    const perPage = new Map<string, number>()
    for (const x of shown) perPage.set(x.pageId, (perPage.get(x.pageId) ?? 0) + 1)
    assert.ok(Math.max(...perPage.values()) <= 2, out)
    // the location is the last heading and a short anchor, not the whole path
    assert.match(out, /\[\d\] 00 대회요강 › 우리 팀 체크리스트\n\(page [0-9a-f]{8}; §우리-팀-체크리스트 v=/)
  })

  it('Korean partial match: a compound query finds the spaced form, an alias finds its page (docs/adr/1700-1701)', async () => {
    const { rankedSections, samePage, sameSection } = await import('./evalRun')
    const rankOf = async (query: string, title: string, anchor: string) => {
      const shown = rankedSections((await mcp.tool('find_context', { query })).text)
      return shown.findIndex((x) => samePage(idByTitle.get(title)!, x.pageId) && sameSection(anchor, x.anchor)) + 1
    }
    // "회의주기" is written "회의 주기" on the page; before 0.14 the three TF sections tied on "TF"
    assert.equal(await rankOf('TF 회의주기', '사내 TF 킥오프', '결제-개편-tf/회의-주기'), 1)
    // "팀구성" vs "팀 구성은 다섯 명으로 확정했다": before 0.14 not shown at all
    const at = await rankOf('해커톤 팀구성', '03 방향 메모', '방향-메모/결정된-것')
    assert.ok(at >= 1 && at <= 3, `decided at ${at}`)
    // "PayFix" is only an alias of the page: before 0.14 find_context returned nothing
    const alias = (await mcp.tool('find_context', { query: 'PayFix' })).text
    assert.ok(alias.includes(idByTitle.get('사내 TF 킥오프')!.slice(0, 8)), alias)
  })

  it('short anchors from find_context round-trip through read_page and patch_section; full paths still work', async () => {
    const req = idByTitle.get('00 대회요강')!
    const refs: [string, string][] = []
    for (const q of ['해커톤 예선 서류 마감', '본선 장소와 시간', '참가 자격 연령', '서울 AI 해커톤 팀 구성']) {
      const out = (await mcp.tool('find_context', { query: q })).text
      for (const m of out.matchAll(new RegExp(`\\(page ${req.slice(0, 8)}; ([^)]*)\\)`, 'g'))) {
        for (const x of m[1].matchAll(/§(\S+) v=([0-9a-f]+)/g)) refs.push([x[1], x[2]])
      }
    }
    assert.ok(refs.length >= 3, JSON.stringify(refs))
    assert.ok(refs.every(([a]) => !a.includes('/')), 'unique leaf headings print one segment')
    // the page id as find_context prints it (8 characters, docs/adr/1906-*) is what the agent passes on
    const printed = req.slice(0, 8)
    for (const [short, v] of refs) {
      const sec = await mcp.tool('read_page', { pageId: printed, section: short })
      assert.equal(sec.isError, false, sec.text)
      assert.match(sec.text, new RegExp(`v=${v}`), `${short}: ${sec.text}`)
    }
    for (const ref of ['요강-요약/일정과-제출/예선-서류', '요강 요약 › 일정과 제출 › 예선 서류', '예선-서류', '예선 서류']) {
      const sec = await mcp.tool('read_page', { pageId: req, section: ref })
      assert.equal(sec.isError, false, `${ref}: ${sec.text}`)
      assert.match(sec.text, /기획서 PDF/)
    }
    // a repeated leaf heading prints as much of the path as it takes to be unique, and resolves
    const dup = await mcp.tool('create_page', {
      workspaceId: ws.id,
      title: 'Twin headings',
      markdown: '# Alpha\n\n## Decided\nnothing yet\n\n# Beta\n\n## Decided\nzorblat wins',
    })
    const dupId = (JSON.parse(dup.text) as { id: string }).id
    const out = (await mcp.tool('find_context', { query: 'zorblat' })).text
    const m = new RegExp(`\\[1\\] Twin headings › Beta › Decided\\n\\(page ${dupId.slice(0, 8)}; §beta/decided v=([0-9a-f]+)`).exec(out)
    assert.ok(m, out)
    const sec = await mcp.tool('read_page', { pageId: dupId.slice(0, 8), section: 'beta/decided' })
    assert.match(sec.text, /zorblat/)
    // patch_section with a short anchor and its version
    const [short, v] = refs[0]
    const p = await mcp.tool('patch_section', { pageId: printed, section: short, mode: 'append', markdown: '확인 완료.', baseVersion: v })
    assert.equal(p.isError, false, p.text)
    // the longer, dashed form printed when two ids in one answer share 8 characters (printedIds)
    const p2 = await mcp.tool('patch_section', { pageId: dupId.slice(0, 13), section: 'beta/decided', mode: 'replace', markdown: 'zorblat lost', baseVersion: m[1] })
    assert.equal(p2.isError, false, p2.text)
    assert.match((await mcp.tool('read_page', { pageId: dupId, section: 'alpha/decided' })).text, /nothing yet/)
  })

  it('deterministic output: same call → same bytes, also after an unrelated edit', async () => {
    const calls: [string, Record<string, unknown>][] = [
      ['find_context', { query: 'backup retention schedule' }],
      ['find_context', { query: '결정 사항 배포' }],
      ['find_context', { query: '서울 AI 해커톤 팀 구성', budget: 1500 }],
      ['read_page', { pageId: idByTitle.get('Backup policy')!, outline: true }],
      ['read_page', { pageId: idByTitle.get('Backup policy')!, section: 'retention' }],
      ['read_pages', { pageIds: [idByTitle.get('Backup policy')!, idByTitle.get('Glossary')!] }],
      ['list_pages', { workspaceId: ws.id, format: 'lines' }],
      ['search', { query: 'backup', format: 'lines' }],
    ]
    const run = async () => Promise.all(calls.map(([n, a]) => mcp.tool(n, a).then((r) => r.text)))
    const first = await run()
    assert.deepEqual(await run(), first)
    // edit a page none of these responses include
    const unrelated = idByTitle.get('Hiring process')!
    const r = await mcp.tool('patch_section', { pageId: unrelated, section: 'stages', mode: 'append', markdown: 'Reference checks for senior roles.' })
    assert.equal(r.isError, false, r.text)
    const again = await run()
    for (let i = 0; i < calls.length; i++) {
      assert.equal(again[i], first[i], `${calls[i][0]} changed after an unrelated edit`)
    }
  })

  it('unchanged documents skip the rewrite; one edited section rewrites one row', async () => {
    const pageId = idByTitle.get('Backup policy')!
    const [d] = await db.select().from(schema.pageDocs).where(eq(schema.pageDocs.pageId, pageId))
    const blocks = stateToBlocks(d.state)
    const s0 = { ...chunkIndexStats }
    await reindexPageChunks(pageId, blocks, { log: false })
    assert.equal(chunkIndexStats.skipped, s0.skipped + 1)
    const edited = structuredClone(blocks)
    const i = edited.findIndex((b) => JSON.stringify(b.content ?? '').includes('Once a month'))
    ;(edited[i].content as { text: string }[])[0].text = 'Twice a month the on-call engineer restores the backup.'
    await reindexPageChunks(pageId, edited, { log: false })
    assert.equal(chunkIndexStats.rowsWritten, s0.rowsWritten + 1)
    await reindexPageChunks(pageId, blocks, { log: false }) // restore
  })

  it('permissions: private pages of others, trash and deleted workspaces never leak', async () => {
    const secret = 'zebracornflux'
    // other's private page in the shared workspace, a trashed page, a page in a deleted workspace
    const priv = await h.makeDocPage(ws.id, other.id, 'Private', [], { scope: 'private' })
    await reindexPageChunks(priv.id, [{ type: 'paragraph', content: [{ type: 'text', text: `${secret} private`, styles: {} }] }] as never, { log: false })
    const trashed = await h.makeDocPage(ws.id, owner.id, 'Trashed', [])
    await reindexPageChunks(trashed.id, [{ type: 'paragraph', content: [{ type: 'text', text: `${secret} trashed`, styles: {} }] }] as never, { log: false })
    await db.update(schema.pages).set({ deletedAt: new Date() }).where(eq(schema.pages.id, trashed.id))
    const ws2 = await h.makeWorkspace(owner)
    const gone = await h.makeDocPage(ws2.id, owner.id, 'Gone', [])
    await reindexPageChunks(gone.id, [{ type: 'paragraph', content: [{ type: 'text', text: `${secret} gone`, styles: {} }] }] as never, { log: false })
    await db.update(schema.workspaces).set({ deletedAt: new Date() }).where(eq(schema.workspaces.id, ws2.id))
    const visible = await h.makeDocPage(ws.id, owner.id, 'Visible', [])
    await reindexPageChunks(visible.id, [{ type: 'paragraph', content: [{ type: 'text', text: `${secret} visible`, styles: {} }] }] as never, { log: false })

    const r = await mcp.tool('find_context', { query: secret })
    // find_context prints 8-character page ids (docs/adr/1906-*)
    assert.match(r.text, new RegExp(visible.id.slice(0, 8)))
    for (const bad of [priv.id, trashed.id, gone.id]) assert.doesNotMatch(r.text, new RegExp(bad.slice(0, 8)))
    assert.doesNotMatch(r.text, /private|trashed|gone/)
    // the private page's own author does see it
    const asOther = await h.connectMcp(app, other, await h.mintToken(other))
    assert.match((await asOther.tool('find_context', { query: secret })).text, new RegExp(priv.id.slice(0, 8)))
    // a workspace the caller is not a member of / that was deleted
    const err = await mcp.tool('find_context', { query: secret, workspaceId: ws2.id })
    assert.equal(err.isError, true)
    assert.match(err.text, /find_context|list_workspaces|list_pages/)
    // read_pages: invisible ids are reported missing, never rendered
    const rp = await asOther.tool('read_pages', { pageIds: [visible.id, priv.id, trashed.id] })
    assert.match(rp.text, /visible/)
    assert.match(rp.text, new RegExp(`Not found or not visible: ${trashed.id}`))
    const rpOwner = await mcp.tool('read_pages', { pageIds: [priv.id] })
    assert.doesNotMatch(rpOwner.text, /private$/m)
    assert.match(rpOwner.text, /Not found or not visible/)
    // outline/section of someone else's private page
    const o = await mcp.tool('read_page', { pageId: priv.id, outline: true })
    assert.equal(o.isError, true)
    await asOther.close()
  })

  it('read_page: outline, section, maxChars, legacy full read', async () => {
    const id = idByTitle.get('Deploy runbook')!
    const o = await mcp.tool('read_page', { pageId: id, outline: true })
    assert.match(o.text, /- §rollback {2}Rollback {2}~\d+ tok {2}v=[0-9a-f]{12}/)
    const s = await mcp.tool('read_page', { pageId: id, section: 'rollback' })
    assert.match(s.text, /^# Deploy runbook › Rollback/)
    assert.match(s.text, /--rollback/)
    assert.doesNotMatch(s.text, /Rolling deploy|Database migrations/)
    const byHeading = await mcp.tool('read_page', { pageId: id, section: 'Database migrations' })
    assert.match(byHeading.text, /backward compatible/)
    const miss = await mcp.tool('read_page', { pageId: id, section: 'nope' })
    assert.equal(miss.isError, true)
    assert.match(miss.text, /Available anchors: .*rollback/)
    const full = await mcp.tool('read_page', { pageId: id })
    assert.match(full.text, /^# Deploy runbook\n\n- id: /)
    assert.match(full.text, /## Rollback/)
    const capped = await mcp.tool('read_page', { pageId: id, maxChars: 200 })
    assert.match(capped.text, /\[truncated: 200 of \d+ chars/)
  })

  it('list_pages / search: legacy JSON stays the default, lines are compact', async () => {
    const legacy = await mcp.tool('list_pages', { workspaceId: ws.id })
    const parsed = JSON.parse(legacy.text) as { pages: { id: string; path: string; children: number }[] }
    assert.ok(parsed.pages.length >= EVAL_PAGES.length)
    const lines = await mcp.tool('list_pages', { workspaceId: ws.id, format: 'lines' })
    assert.match(lines.text, /^- Deploy runbook [0-9a-f-]{36}$/m)
    console.log('[eval] list_pages tokens json', estimateTokens(legacy.text), 'lines', estimateTokens(lines.text))
    assert.ok(estimateTokens(lines.text) < estimateTokens(legacy.text) / 2)
    const sj = await mcp.tool('search', { query: 'rollback' })
    assert.ok(Array.isArray((JSON.parse(sj.text) as { results: unknown[] }).results))
    const sl = await mcp.tool('search', { query: 'rollback', format: 'lines' })
    assert.match(sl.text, /^[0-9a-f-]{36} \| Deploy runbook/m)
    console.log('[eval] search tokens json', estimateTokens(sj.text), 'lines', estimateTokens(sl.text))
  })

  it('list_pages depth limit with hidden-children counts', async () => {
    const parent = await h.makeDocPage(ws.id, owner.id, 'Parent', [])
    const child = await h.makeDocPage(ws.id, owner.id, 'Child', [], { parentId: parent.id })
    await h.makeDocPage(ws.id, owner.id, 'Grandchild', [], { parentId: child.id })
    const r = await mcp.tool('list_pages', { workspaceId: ws.id, parentId: parent.id, depth: 1, format: 'lines' })
    // titles are member-written: the lines come wrapped as data (docs/adr/1525-*)
    assert.equal(r.text, `<untrusted_content source="pages">\n- Child ${child.id} (+1)\n</untrusted_content>`)
    const j = JSON.parse((await mcp.tool('list_pages', { workspaceId: ws.id, parentId: parent.id, depth: 2 })).text)
    assert.deepEqual(j.pages.map((p: { title: string }) => p.title), ['Child', 'Grandchild'])
  })

  it('patch_section: versioned replace, conflict with current text, other sections untouched', async () => {
    const id = idByTitle.get('Incident response')!
    const outline = (await mcp.tool('read_page', { pageId: id, outline: true })).text
    const v = /§paging .* v=([0-9a-f]{12})/.exec(outline)![1]
    const vPost = /§postmortem .* v=([0-9a-f]{12})/.exec(outline)![1]
    const md = 'SEV1 and SEV2 page the primary on-call. After 10 minutes without an acknowledgement the secondary is paged.'
    const ok = await mcp.tool('patch_section', { pageId: id, section: 'paging', mode: 'replace', markdown: md, baseVersion: v })
    assert.equal(ok.isError, false, ok.text)
    assert.match(ok.text, /§paging is now v=[0-9a-f]{12}/)
    const after1 = await mcp.tool('read_page', { pageId: id, section: 'paging' })
    assert.match(after1.text, /After 10 minutes/)
    assert.doesNotMatch(after1.text, /engineering manager/)
    // stale version → conflict carrying the current text; nothing written
    const stale = await mcp.tool('patch_section', { pageId: id, section: 'paging', mode: 'replace', markdown: 'LOST', baseVersion: v })
    assert.equal(stale.isError, true)
    assert.match(stale.text, /^Conflict: .*retry with baseVersion [0-9a-f]{12}/m)
    assert.match(stale.text, /After 10 minutes/)
    assert.doesNotMatch((await mcp.tool('read_page', { pageId: id })).text, /LOST/)
    // the other sections kept their versions (only the patched blocks changed)
    const outline2 = (await mcp.tool('read_page', { pageId: id, outline: true })).text
    assert.match(outline2, new RegExp(`§postmortem .* v=${vPost}`))
    // index follows the edit right away (server edits index immediately)
    const fc = await mcp.tool('find_context', { query: 'acknowledgement secondary paged 10 minutes' })
    assert.match(fc.text, /After 10 minutes/)
    // a "Before AI edit" snapshot exists
    const snaps = await db.select().from(schema.pageSnapshots).where(eq(schema.pageSnapshots.pageId, id))
    assert.ok(snaps.some((s) => s.label === 'Before AI edit'))
    // replace/delete need a base version
    const noBase = await mcp.tool('patch_section', { pageId: id, section: 'paging', mode: 'delete' })
    assert.match(noBase.text, /baseVersion is required/)
    // append / insert_after / delete
    const ins = await mcp.tool('patch_section', { pageId: id, section: 'postmortem', mode: 'insert_after', markdown: '## Status page\n\nUpdate the status page every 30 minutes.' })
    assert.equal(ins.isError, false, ins.text)
    // provenance: snapshots taken for the agent's patches carry the OAuth client name
    const viaSnaps = await db.select().from(schema.pageSnapshots).where(eq(schema.pageSnapshots.pageId, id))
    assert.ok(viaSnaps.some((s) => s.label === 'Before AI edit' && s.viaClient === 'Test Agent'), JSON.stringify(viaSnaps.map((s) => [s.label, s.viaClient])))
    const o3 = (await mcp.tool('read_page', { pageId: id, outline: true })).text
    const vs = /§status-page .* v=([0-9a-f]{12})/.exec(o3)![1]
    const del = await mcp.tool('patch_section', { pageId: id, section: 'status-page', mode: 'delete', baseVersion: vs })
    assert.equal(del.isError, false, del.text)
    assert.doesNotMatch((await mcp.tool('read_page', { pageId: id, outline: true })).text, /status-page/)
  })

  it('patch_section merges with a concurrent edit of another section (no data loss)', async () => {
    const id = idByTitle.get('Vacation policy')!
    const { getServerEditor } = await import('../md/editor')
    const editor = getServerEditor()
    // A "client" holding the current document edits the On-call swaps section …
    const conn = await collab.hocuspocus.openDirectConnection(id)
    const base = Y.encodeStateAsUpdate(conn.document!)
    await conn.disconnect()
    const client = new Y.Doc()
    Y.applyUpdate(client, base)
    const sv = Y.encodeStateVector(client)
    const group = client.getXmlFragment('document').get(0) as Y.XmlElement
    const blocks = editor.yDocToBlocks(client, 'document') as unknown as { type: string; content?: { text?: string }[] }[]
    const idx = blocks.findIndex((b) => (b.content ?? []).some((c) => c.text?.includes('swap the shift')))
    // client-side edit: replace that paragraph through BlockNote's own Yjs conversion
    const tmp = editor.blocksToYDoc([{ type: 'paragraph', content: [{ type: 'text', text: 'CLIENT EDIT: hand over the pager.', styles: {} }] }] as never, 'document')
    const clone = ((tmp.getXmlFragment('document').get(0) as Y.XmlElement).get(0) as Y.XmlElement).clone()
    client.transact(() => {
      group.delete(idx, 1)
      group.insert(idx, [clone])
    })
    const clientUpdate = Y.encodeStateAsUpdate(client, sv)

    // … while the agent patches the Allowance section from the same base.
    const outline = (await mcp.tool('read_page', { pageId: id, outline: true })).text
    const v = /§allowance .* v=([0-9a-f]{12})/.exec(outline)![1]
    const r = await mcp.tool('patch_section', { pageId: id, section: 'allowance', mode: 'replace', markdown: 'AGENT EDIT: 27 days per year.', baseVersion: v })
    assert.equal(r.isError, false, r.text)
    // the client's update arrives afterwards
    const c2 = await collab.hocuspocus.openDirectConnection(id)
    await c2.transact((doc) => Y.applyUpdate(doc, clientUpdate))
    await c2.disconnect()
    const full = (await mcp.tool('read_page', { pageId: id })).text
    assert.match(full, /AGENT EDIT: 27 days per year\./)
    assert.match(full, /CLIENT EDIT: hand over the pager\./)
    assert.match(full, /## Requesting time off/)
    assert.doesNotMatch(full, /25 days of paid vacation/)
  })

  it('patch_section through the route: typing in the patched section merges, callouts elsewhere survive (ADR 0940)', async () => {
    const id = idByTitle.get('Vacation policy')!
    // a callout (web-only block) in another section, written into the live doc like the editor does
    const conn = await collab.hocuspocus.openDirectConnection(id)
    await conn.transact((doc) => {
      const group = doc.getXmlFragment('document').get(0) as Y.XmlElement
      const bc = new Y.XmlElement('blockContainer')
      bc.setAttribute('id', 'callout-route-test')
      const co = new Y.XmlElement('callout')
      co.setAttribute('type', 'note')
      bc.insert(0, [co])
      group.insert(group.length, [bc])
      const t = new Y.XmlText()
      co.insert(0, [t])
      t.insert(0, 'Keep me')
    })
    const base = Y.encodeStateAsUpdate(conn.document!)
    await conn.disconnect()
    // a client types into the paragraph of the section the agent is about to patch
    const { readBlocks } = await import('./sectionPatch')
    const client = new Y.Doc()
    Y.applyUpdate(client, base)
    const sv = Y.encodeStateVector(client)
    // read a copy: yDocToBlocks deletes nodes it does not know (the callout) from the doc it reads
    const blocks = readBlocks(client) as { id?: string; content?: unknown }[]
    const target = blocks.find((b) => JSON.stringify(b.content ?? '').includes('Request vacation'))
    assert.ok(target)
    const clientGroup = client.getXmlFragment('document').get(0) as Y.XmlElement
    const el = clientGroup.toArray().find((c) => c instanceof Y.XmlElement && c.getAttribute('id') === target.id) as Y.XmlElement
    ;((el.get(0) as Y.XmlElement).get(0) as Y.XmlText).insert(0, 'TYPED ')
    const clientUpdate = Y.encodeStateAsUpdate(client, sv)

    const outline = (await mcp.tool('read_page', { pageId: id, outline: true })).text
    const v = /§requesting-time-off .* v=([0-9a-f]{12})/.exec(outline)![1]
    const body = 'Request vacation in the HR tool at least two weeks ahead for absences longer than three days.'
    const r = await mcp.tool('patch_section', { pageId: id, section: 'requesting-time-off', mode: 'replace', markdown: `${body}\n\nAGENT LINE.`, baseVersion: v })
    assert.equal(r.isError, false, r.text)
    const c2 = await collab.hocuspocus.openDirectConnection(id)
    await c2.transact((doc) => Y.applyUpdate(doc, clientUpdate))
    const live = c2.document!
    const ids: string[] = []
    ;(live.getXmlFragment('document').get(0) as Y.XmlElement).toArray().forEach((c) => ids.push(String((c as Y.XmlElement).getAttribute('id'))))
    await c2.disconnect()
    assert.ok(ids.includes('callout-route-test'), 'callout in another section survives')
    const full = (await mcp.tool('read_page', { pageId: id })).text
    assert.match(full, /TYPED Request vacation in the HR tool/)
    assert.match(full, /AGENT LINE\./)
  })

  it('update_page append keeps web-only blocks (callout) and existing block ids', async () => {
    const id = idByTitle.get('Vacation policy')!
    const conn = await collab.hocuspocus.openDirectConnection(id)
    await conn.transact((doc) => {
      const group = doc.getXmlFragment('document').get(0) as Y.XmlElement
      const bc = new Y.XmlElement('blockContainer')
      bc.setAttribute('id', 'callout-append-test')
      const co = new Y.XmlElement('callout')
      co.setAttribute('type', 'note')
      bc.insert(0, [co])
      group.insert(0, [bc])
      const t = new Y.XmlText()
      co.insert(0, [t])
      t.insert(0, 'Keep me on append')
    })
    const topIds = (doc: Y.Doc) =>
      (doc.getXmlFragment('document').get(0) as Y.XmlElement).toArray().map((c) => String((c as Y.XmlElement).getAttribute('id')))
    const before = topIds(conn.document!)
    await conn.disconnect()

    const r = await mcp.tool('update_page', { pageId: id, mode: 'append', markdown: 'APPENDED LINE.' })
    assert.equal(r.isError, false, r.text)

    const c2 = await collab.hocuspocus.openDirectConnection(id)
    const after = topIds(c2.document!)
    await c2.disconnect()
    assert.ok(after.includes('callout-append-test'), 'callout survives append')
    assert.deepEqual(after.slice(0, before.length), before, 'existing blocks keep their ids and order')
    assert.equal(after.length, before.length + 1)
    assert.match((await mcp.tool('read_page', { pageId: id })).text, /APPENDED LINE\./)
  })

  it('token cost: patch_section vs update_page replace for a one-section change', async () => {
    const id = idByTitle.get('Logging and monitoring')!
    const full = (await mcp.tool('read_page', { pageId: id })).text
    const outline = (await mcp.tool('read_page', { pageId: id, outline: true })).text
    const v = /§alerts .* v=([0-9a-f]{12})/.exec(outline)![1]
    const md = 'Alerts fire when the error rate is above 1% for 5 minutes or p95 latency doubles; they page the on-call engineer.'
    const args = { pageId: id, section: 'alerts', mode: 'replace', markdown: md, baseVersion: v }
    const out = await mcp.tool('patch_section', args)
    const patchTokens = estimateTokens(outline) + estimateTokens(JSON.stringify(args)) + estimateTokens(out.text)
    // update_page replace needs the full body read and resent
    const body = full.slice(full.indexOf('---\n') + 4).replace('above 2%', 'above 1%')
    const replaceArgs = { pageId: id, mode: 'replace', markdown: body }
    const outR = await mcp.tool('update_page', replaceArgs)
    const replaceTokens = estimateTokens(full) + estimateTokens(JSON.stringify(replaceArgs)) + estimateTokens(outR.text)
    console.log('[eval] edit tokens patch_section', patchTokens, 'update_page replace', replaceTokens)
    assert.ok(patchTokens < replaceTokens)
  })

  it('a doc with comments keeps comment anchors outside the patched section', async () => {
    const id = idByTitle.get('Glossary')!
    const [d] = await db.select().from(schema.pageDocs).where(eq(schema.pageDocs.pageId, id))
    const before = stateToBlocks(d.state)
    const outline = (await mcp.tool('read_page', { pageId: id, outline: true })).text
    const v = /§sla .* v=([0-9a-f]{12})/.exec(outline)![1]
    await mcp.tool('patch_section', { pageId: id, section: 'sla', mode: 'replace', markdown: 'Uptime promise.', baseVersion: v })
    const [d2] = await db.select().from(schema.pageDocs).where(and(eq(schema.pageDocs.pageId, id)))
    const after2 = stateToBlocks(d2.state)
    // blocks of the first two sections keep their ids
    assert.deepEqual(after2.slice(0, 4).map((b) => b.id), before.slice(0, 4).map((b) => b.id))
  })
})
