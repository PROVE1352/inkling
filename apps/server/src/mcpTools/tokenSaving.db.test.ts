// MCP token saving (0.12 step 2, docs/adr/1540-* .. 1543-*): `known` versions on read_page /
// read_pages (unchanged pages come back as one line), changed-sections-only reads, patch_sections
// (several section edits, all or nothing), list_pages/search format 'compact' with short ids, and
// byte-stable tool lists / outputs for prompt caching.
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.DATA_DIR ||= `${process.env.TMPDIR || '/tmp'}/inkling-tokensaving-${process.pid}`

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

const HAS_DB = !!process.env.DATABASE_URL

describe('[db] MCP token saving: known versions, patch_sections, compact lists', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const h = await import('./testHarness')
  const { db, closeDb } = await import('../db/index')
  const schema = await import('../db/schema')
  const { estimateTokens } = await import('../context/tokens')
  const { eq: eqSql } = await import('drizzle-orm')
  const { blocksToStateBuffer } = await import('../md/convert')
  const collab = await import('../collab')
  const app = await h.buildTestApp()
  after(async () => {
    await collab.destroyCollab()
    await app.close()
    await closeDb()
  })

  type U = Awaited<ReturnType<typeof h.makeUser>>
  let owner: U
  let other: U
  let ws: { id: string }
  let mcp: Awaited<ReturnType<typeof h.connectMcp>>

  const RUNBOOK = '## Setup\n\nInstall the server.\n\n## Backups\n\nNightly at 02:00.\n\n## Restore\n\nMonthly drill.'
  const create = async (title: string, markdown: string, parentId?: string, m = mcp) => {
    const r = await m.tool('create_page', { workspaceId: ws.id, title, markdown, ...(parentId ? { parentId } : {}) })
    assert.equal(r.isError, false, r.text)
    return (JSON.parse(r.text) as { id: string }).id
  }
  const versionOf = (t: string) => /- version: ([0-9a-f]{12})/.exec(t)?.[1]
  const outlineVersions = async (pageId: string) => {
    const r = await mcp.tool('read_page', { pageId, outline: true })
    assert.equal(r.isError, false, r.text)
    return Object.fromEntries([...r.text.matchAll(/- §(\S+) .* v=([0-9a-f]+)/g)].map((m) => [m[1], m[2]]))
  }

  before(async () => {
    owner = await h.makeUser('owner')
    other = await h.makeUser('other')
    ws = await h.makeWorkspace(owner, [other])
    mcp = await h.connectMcp(app, owner, await h.mintToken(owner), { user: { ...owner, via: 'Test Agent' } })
  })

  // --- known / unchanged ------------------------------------------------------------------

  it('read_page known: one line for unchanged content; the full page after an edit; deletion is an error, not "unchanged"', async () => {
    const pageId = await create('Runbook A', RUNBOOK)
    const first = await mcp.tool('read_page', { pageId })
    const v = versionOf(first.text)
    assert.ok(v, first.text)
    const same = await mcp.tool('read_page', { pageId, known: v })
    assert.equal(same.isError, false, same.text)
    assert.match(same.text, new RegExp(`^unchanged \\(page ${pageId} v=${v}; can: [a-z, ]+\\)$`))
    assert.ok(estimateTokens(same.text) < estimateTokens(first.text) / 4)
    // a stale or foreign version reads in full
    const wrong = await mcp.tool('read_page', { pageId, known: '000000000000' })
    assert.equal(versionOf(wrong.text), v)
    assert.ok(wrong.text.includes('Nightly at 02:00.'))
    // an edit changes the version
    const p = await mcp.tool('patch_section', { pageId, section: 'backups', mode: 'append', markdown: 'Keep 30 days.' })
    assert.equal(p.isError, false, p.text)
    const edited = await mcp.tool('read_page', { pageId, known: v })
    assert.ok(edited.text.includes('Keep 30 days.'), edited.text)
    const v2 = versionOf(edited.text)
    assert.ok(v2 && v2 !== v)
    // trash: an error, never "unchanged"
    await mcp.tool('trash_page', { pageId })
    const gone = await mcp.tool('read_page', { pageId, known: v2 })
    assert.equal(gone.isError, true)
    assert.doesNotMatch(gone.text, /unchanged/)
  })

  it('read_page known: a title or property change is a change; another user\'s private page stays hidden', async () => {
    const pageId = await create('Runbook B', RUNBOOK)
    const v = versionOf((await mcp.tool('read_page', { pageId })).text)!
    await mcp.tool('rename_page', { pageId, title: 'Runbook B (renamed)' })
    const r = await mcp.tool('read_page', { pageId, known: v })
    assert.ok(r.text.startsWith('# Runbook B (renamed)'), r.text)
    // private page of another member
    const otherMcp = await h.connectMcp(app, other, await h.mintToken(other))
    const created = await otherMcp.tool('create_page', { workspaceId: ws.id, title: 'Diary', markdown: 'secret', private: true })
    const priv = (JSON.parse(created.text) as { id: string }).id
    const v3 = versionOf((await otherMcp.tool('read_page', { pageId: priv })).text)!
    const peek = await mcp.tool('read_page', { pageId: priv, known: v3 })
    assert.equal(peek.isError, true)
    assert.doesNotMatch(peek.text, /unchanged/)
    await otherMcp.close()
  })

  it('read_page section + known: the section version; a change returns the section', async () => {
    const pageId = await create('Runbook C', RUNBOOK)
    const vs = await outlineVersions(pageId)
    const same = await mcp.tool('read_page', { pageId, section: 'backups', known: vs.backups })
    assert.match(same.text, new RegExp(`^unchanged \\(page ${pageId} §backups v=${vs.backups}; can: [a-z, ]+\\)$`))
    await mcp.tool('patch_section', { pageId, section: 'backups', mode: 'replace', markdown: 'Hourly.', baseVersion: vs.backups })
    const changed = await mcp.tool('read_page', { pageId, section: 'backups', known: vs.backups })
    assert.ok(changed.text.includes('Hourly.'), changed.text)
  })

  it('read_pages known: unchanged pages are one line and cost no budget; changed ones come back in full', async () => {
    const a = await create('Pages A', 'Alpha body.')
    const b = await create('Pages B', 'Bravo body.')
    const big = await create('Pages Big', `${'Long paragraph about deployments and backups. '.repeat(120)}`)
    const all = await mcp.tool('read_pages', { pageIds: [a, b, big] })
    const ver = (id: string, t: string) => new RegExp(`\\(page ${id}, [^)]*v=([0-9a-f]{12})`).exec(t)?.[1]
    const [va, vb, vbig] = [ver(a, all.text), ver(b, all.text), ver(big, all.text)]
    assert.ok(va && vb && vbig, all.text)
    // the same version as read_page prints, for documents and folders alike
    assert.equal(versionOf((await mcp.tool('read_page', { pageId: a })).text), va)
    const folder = await create('Pages folder', 'Folder intro with a [[Pages A]] link.')
    await db.update(schema.pages).set({ kind: 'folder' }).where(eqSql(schema.pages.id, folder))
    const fv = ver(folder, (await mcp.tool('read_pages', { pageIds: [folder] })).text)
    assert.ok(fv)
    assert.equal(versionOf((await mcp.tool('read_page', { pageId: folder })).text), fv)
    const r = await mcp.tool('read_pages', { pageIds: [a, b, big], known: { [a]: va, [b]: vb } })
    assert.ok(r.text.includes(`(page ${a} unchanged v=${va}; can: `), r.text)
    assert.ok(r.text.includes(`(page ${b} unchanged v=${vb}; can: `), r.text)
    assert.ok(!r.text.includes('Alpha body.') && !r.text.includes('Bravo body.'))
    assert.ok(r.text.includes('Long paragraph'))
    // budget: the unchanged big page does not crowd out the next one
    const tight = await mcp.tool('read_pages', { pageIds: [big, a], known: { [big]: vbig }, budget: 300 })
    assert.ok(tight.text.includes(`(page ${big} unchanged`), tight.text)
    assert.ok(tight.text.includes('Alpha body.'), tight.text)
    // edited → full again
    await mcp.tool('update_page', { pageId: b, markdown: 'Bravo two.', mode: 'replace' })
    const again = await mcp.tool('read_pages', { pageIds: [a, b], known: { [a]: va, [b]: vb } })
    assert.ok(again.text.includes('Bravo two.'), again.text)
    // a trashed page is reported as missing, not unchanged
    await mcp.tool('trash_page', { pageId: a })
    const gone = await mcp.tool('read_pages', { pageIds: [a], known: { [a]: va } })
    assert.ok(gone.text.includes('Not found or not visible'), gone.text)
    assert.doesNotMatch(gone.text, /unchanged/)
  })

  it('read_page knownSections: only changed, new and removed sections come back', async () => {
    const pageId = await create('Runbook D', RUNBOOK)
    const known = await outlineVersions(pageId)
    assert.deepEqual(Object.keys(known).sort(), ['backups', 'restore', 'setup'])
    await mcp.tool('patch_section', { pageId, section: 'restore', mode: 'append', markdown: 'Quarterly full restore.' })
    await mcp.tool('patch_section', { pageId, section: 'setup', mode: 'delete', baseVersion: known.setup })
    await mcp.tool('patch_section', { pageId, section: 'restore', mode: 'insert_after', markdown: '## Contacts\n\nOn-call phone.' })
    const r = await mcp.tool('read_page', { pageId, knownSections: known })
    assert.equal(r.isError, false, r.text)
    assert.ok(r.text.includes('Quarterly full restore.'), r.text)
    assert.ok(r.text.includes('On-call phone.'), r.text)
    assert.ok(!r.text.includes('Nightly at 02:00.'), 'unchanged section left out')
    assert.match(r.text, /1 unchanged/)
    assert.match(r.text, /removed: §setup/)
    const full = await mcp.tool('read_page', { pageId })
    assert.ok(estimateTokens(r.text) < estimateTokens(full.text))
  })

  // --- patch_sections ------------------------------------------------------------------------

  it('patch_sections: several edits in one call, each with its new version', async () => {
    const pageId = await create('Runbook E', RUNBOOK)
    const vs = await outlineVersions(pageId)
    const r = await mcp.tool('patch_sections', {
      pageId,
      edits: [
        { section: 'setup', mode: 'replace', markdown: 'Install with pnpm.', baseVersion: vs.setup },
        { section: 'restore', mode: 'append', markdown: 'Quarterly too.' },
        { section: 'backups', mode: 'insert_after', markdown: '## Retention\n\nThirty days.' },
      ],
    })
    assert.equal(r.isError, false, r.text)
    assert.match(r.text, /^Done: 3 edits/)
    assert.match(r.text, /§setup v=[0-9a-f]+/)
    const body = (await mcp.tool('read_page', { pageId })).text
    for (const s of ['Install with pnpm.', 'Quarterly too.', 'Thirty days.', 'Nightly at 02:00.']) assert.ok(body.includes(s), s)
    assert.ok(!body.includes('Install the server.'))
    assert.ok(body.indexOf('Thirty days.') < body.indexOf('Monthly drill.'))
  })

  it('patch_sections: one stale baseVersion or unknown section → every conflict listed, nothing written', async () => {
    const pageId = await create('Runbook F', RUNBOOK)
    const vs = await outlineVersions(pageId)
    const before = (await mcp.tool('read_page', { pageId })).text
    const r = await mcp.tool('patch_sections', {
      pageId,
      edits: [
        { section: 'backups', mode: 'replace', markdown: 'Weekly.', baseVersion: vs.backups },
        { section: 'setup', mode: 'replace', markdown: 'Changed.', baseVersion: '0123456789ab' },
        { section: 'nope', mode: 'append', markdown: 'x' },
      ],
    })
    assert.equal(r.isError, true)
    assert.match(r.text, /nothing was written/)
    assert.match(r.text, /edit 2 §setup: changed since baseVersion 0123456789ab/)
    assert.ok(r.text.includes(`now v=${vs.setup}`), r.text)
    assert.ok(r.text.includes('Install the server.'), 'current text of the conflicting section')
    assert.match(r.text, /edit 3 "nope": not found/)
    assert.doesNotMatch(r.text, /edit 1/)
    assert.equal((await mcp.tool('read_page', { pageId })).text, before)
  })

  it('patch_sections: the same section twice, replace without baseVersion, read-only tokens and locks are refused', async () => {
    const pageId = await create('Runbook G', RUNBOOK)
    const vs = await outlineVersions(pageId)
    const dup = await mcp.tool('patch_sections', {
      pageId,
      edits: [
        { section: 'setup', mode: 'append', markdown: 'a' },
        { section: 'Setup', mode: 'append', markdown: 'b' },
      ],
    })
    assert.equal(dup.isError, true)
    assert.match(dup.text, /twice/)
    const noBase = await mcp.tool('patch_sections', { pageId, edits: [{ section: 'setup', mode: 'replace', markdown: 'x' }] })
    assert.equal(noBase.isError, true)
    assert.match(noBase.text, /baseVersion is required/)
    const ro = await h.connectMcp(app, owner, await h.mintToken(owner, 'notes:read'), { canWrite: false })
    const roRes = await ro.tool('patch_sections', { pageId, edits: [{ section: 'setup', mode: 'append', markdown: 'x' }] })
    assert.equal(roRes.isError, true)
    assert.match(roRes.text, /read-only/)
    await ro.close()
    // a locked page (agents may only read): same answer as patch_section, nothing written
    const lock = await app.inject({
      method: 'PUT',
      url: `/api/pages/${pageId}/lock`,
      headers: { cookie: owner.cookie },
      payload: { locked: true, people: 'everyone', agents: 'read' },
    })
    assert.equal(lock.statusCode, 200, lock.body)
    const single = await mcp.tool('patch_section', { pageId, section: 'setup', mode: 'append', markdown: 'x' })
    const batch = await mcp.tool('patch_sections', { pageId, edits: [{ section: 'setup', mode: 'append', markdown: 'x' }] })
    assert.equal(single.isError, true, single.text)
    assert.equal(batch.isError, true, batch.text)
    assert.match(batch.text, /PAGE_LOCKED/)
    const body = (await mcp.tool('read_page', { pageId, section: 'setup' })).text
    assert.ok(body.includes('Install the server.') && !/\n(x|a|b)\n/.test(body), body)
    void vs
  })

  it('patch_sections: a section claimed by another agent is refused (nothing written); a "suggestions only" page gets suggestions', async () => {
    const pageId = await create('Runbook H', RUNBOOK)
    const claimer = await h.connectMcp(app, owner, await h.mintToken(owner, 'notes', 'Claimer'), { user: { ...owner, via: 'Claimer' } })
    const cl = await claimer.tool('claim_section', { pageId, section: 'backups', minutes: 10 })
    assert.equal(cl.isError, false, cl.text)
    const before = (await mcp.tool('read_page', { pageId })).text
    const r = await mcp.tool('patch_sections', {
      pageId,
      edits: [
        { section: 'setup', mode: 'append', markdown: 'one' },
        { section: 'backups', mode: 'append', markdown: 'two' },
      ],
    })
    assert.equal(r.isError, true)
    assert.match(r.text, /edit 2 §backups: claimed by Claimer until /)
    assert.equal((await mcp.tool('read_page', { pageId })).text, before)
    await claimer.close()
    const lock = await app.inject({
      method: 'PUT',
      url: `/api/pages/${pageId}/lock`,
      headers: { cookie: owner.cookie },
      payload: { locked: true, people: 'everyone', agents: 'suggest' },
    })
    assert.equal(lock.statusCode, 200, lock.body)
    // under "agents: suggestions only" the batch becomes suggestions, made together (docs/adr/1538-*)
    const s = await mcp.tool('patch_sections', {
      pageId,
      edits: [
        { section: 'setup', mode: 'append', markdown: 'three' },
        { section: 'backups', mode: 'append', markdown: 'four' },
      ],
    })
    assert.equal(s.isError, false, s.text)
    assert.match(s.text, /^Not written: kept as 2 suggestions on page .* locked to "agents: suggestions only"/)
    // the body is unchanged (the header's can: line now says suggest)
    const body = (t: string) => t.slice(t.indexOf('<untrusted_content'))
    assert.equal(body((await mcp.tool('read_page', { pageId })).text), body(before))
  })

  // --- compact lists and short ids -------------------------------------------------------------

  it('list_pages compact: dated siblings fold, every id stays addressable, lines is unchanged', async () => {
    const folder = await create('Meetings', 'Weekly notes.')
    const ids: string[] = []
    for (let d = 1; d <= 5; d++) ids.push(await create(`Weekly sync 2026-11-0${d}`, `Notes ${d}.`, folder))
    const r = await mcp.tool('list_pages', { workspaceId: ws.id, parentId: folder, format: 'compact' })
    assert.equal(r.isError, false, r.text)
    assert.ok(r.text.includes(`- Weekly sync 2026-11-{01..05} ids: ${ids.map((i) => i.slice(0, 8)).join(',')}`), r.text)
    assert.ok(r.text.includes('8-character prefixes'))
    // same bytes twice; 'lines' still prints full ids
    assert.equal((await mcp.tool('list_pages', { workspaceId: ws.id, parentId: folder, format: 'compact' })).text, r.text)
    const lines = await mcp.tool('list_pages', { workspaceId: ws.id, parentId: folder, format: 'lines' })
    for (const id of ids) assert.ok(lines.text.includes(id))
    // short ids are accepted by read_page, read_pages and list_pages(parentId)
    const one = await mcp.tool('read_page', { pageId: ids[2].slice(0, 8) })
    assert.ok(one.text.includes(`- id: ${ids[2]}`), one.text)
    const many = await mcp.tool('read_pages', { pageIds: ids.slice(0, 2).map((i) => i.slice(0, 8)) })
    assert.ok(many.text.includes('Notes 1.') && many.text.includes('Notes 2.'), many.text)
    const sub = await mcp.tool('list_pages', { workspaceId: ws.id, parentId: folder.slice(0, 8), format: 'compact' })
    assert.equal(sub.text, r.text)
    const full = await mcp.tool('list_pages', { workspaceId: ws.id, format: 'compact' })
    assert.ok(estimateTokens(full.text) < estimateTokens((await mcp.tool('list_pages', { workspaceId: ws.id, format: 'lines' })).text))
  })

  it('short ids: an ambiguous prefix lists the candidates; pages the agent cannot see never match', async () => {
    const insert = async (id: string, title: string, by: string, scope: 'shared' | 'private' = 'shared') => {
      await db.insert(schema.pages).values({ id, workspaceId: ws.id, title, createdBy: by, kind: 'doc', scope })
      await db.insert(schema.pageDocs).values({ pageId: id, state: blocksToStateBuffer([{ type: 'paragraph', content: [{ type: 'text', text: title, styles: {} }] }] as never) })
    }
    // fresh prefixes per run (test databases are reused, rows are never cleaned up)
    const { randomBytes } = await import('node:crypto')
    const P = randomBytes(4).toString('hex')
    const Q = randomBytes(4).toString('hex')
    await insert(`${P}-0000-4000-8000-000000000001`, 'Twin one', owner.id)
    await insert(`${P}-0000-4000-8000-000000000002`, 'Twin two', owner.id)
    const amb = await mcp.tool('read_page', { pageId: P })
    assert.equal(amb.isError, true)
    assert.ok(amb.text.includes(`matches 2 pages: ${P}-0000-4000-8000-000000000001 "Twin one", ${P}-0000-4000-8000-000000000002 "Twin two"`), amb.text)
    const longer = await mcp.tool('read_page', { pageId: `${P}-0000-4000-8000-0000000000` })
    assert.equal(longer.isError, true)
    const exact = await mcp.tool('read_page', { pageId: `${P}00004000800000000000000` + '2' })
    assert.ok(exact.text.includes('Twin two'), exact.text)
    // another member's private page is not a candidate
    await insert(`${Q}-0000-4000-8000-000000000001`, 'Hidden diary', other.id, 'private')
    const hidden = await mcp.tool('read_page', { pageId: Q })
    assert.equal(hidden.isError, true)
    assert.match(hidden.text, /no page you can see/)
    assert.doesNotMatch(hidden.text, /Hidden diary/)
    const bad = await mcp.tool('read_page', { pageId: 'zzzzzzzz' })
    assert.equal(bad.isError, true)
  })

  it('search compact: short ids, one line per result', async () => {
    await create('Compact search target', 'zanzibar quokka')
    const r = await mcp.tool('search', { query: 'zanzibar', workspaceId: ws.id, format: 'compact' })
    assert.equal(r.isError, false, r.text)
    assert.match(r.text, /\n[0-9a-f]{8} \| Compact search target \| /)
  })

  // --- prompt-cache stability --------------------------------------------------------------------

  it('tool list, instructions and outputs are byte-identical across calls and connections', async () => {
    const tools = async (m: typeof mcp) => JSON.stringify((await m.client.listTools()).tools)
    const m2 = await h.connectMcp(app, owner, await h.mintToken(owner, 'notes', 'Other Client'))
    const m3 = await h.connectMcp(app, other, await h.mintToken(other))
    const t1 = await tools(mcp)
    assert.equal(await tools(mcp), t1)
    assert.equal(await tools(m2), t1)
    assert.equal(await tools(m3), t1)
    assert.equal(mcp.client.getInstructions(), m3.client.getInstructions())
    const pageId = await create('Stable page', RUNBOOK)
    const calls: [string, Record<string, unknown>][] = [
      ['get_instructions', { workspaceId: ws.id }],
      ['list_workspaces', {}],
      ['list_pages', { workspaceId: ws.id, format: 'compact' }],
      ['read_pages', { pageIds: [pageId], known: { [pageId]: '000000000000' } }],
      ['read_page', { pageId, knownSections: { setup: '0' } }],
      ['search', { query: 'Install', workspaceId: ws.id, format: 'compact' }],
    ]
    const run = async () => Promise.all(calls.map(([n, a]) => mcp.tool(n, a).then((r) => r.text)))
    const first = await run()
    const second = await run()
    for (let i = 0; i < calls.length; i++) assert.equal(second[i], first[i], `${calls[i][0]} differs between two calls`)
    await m2.close()
    await m3.close()
  })
})
