// AI step versions (docs/adr/2180-*) across the other 0.17 writers (integration, wave 16): which agent
// writes leave a step and which intentionally do not. Read back through list_versions after each
// real call: upload_file's link (0.16, ADR 2044), a database-view token written by update_page
// (ADR 2123), a row's body (ADR 2140-2147), row properties, and import_zip (ADR 2162) addressed by
// the workspace's name (ADR 2186).
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
import { mkdirSync } from 'node:fs'
import path from 'node:path'

process.env.DATA_DIR ||= `${process.env.TMPDIR || '/tmp'}/inkling-aisteps017-${process.pid}`
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.APP_URL ||= 'https://notes.example.com'

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, describe, it } from 'node:test'

const HAS_DB = !!process.env.DATABASE_URL

describe('[db] AI steps across the 0.17 writers', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  mkdirSync(path.join(process.env.DATA_DIR!, 'uploads'), { recursive: true })
  const h = await import('./testHarness')
  const { db, closeDb } = await import('../db/index')
  const schema = await import('../db/schema')
  const { and, eq, sql } = await import('drizzle-orm')
  const collab = await import('../collab')
  const JSZip = (await import('jszip')).default
  const app = await h.buildTestApp()

  const W = randomBytes(3).toString('hex')
  const owner = await h.makeUser('Olivia')
  const member = await h.makeUser('Mia')
  const ws = await h.makeWorkspace(owner, [member], `Steps lab ${W}`)
  await h.makeWorkspace(member, [], `Other place ${W}`) // two workspaces: names must pick one
  await db.update(schema.workspaces).set({ agentUploads: 'on' }).where(eq(schema.workspaces.id, ws.id))
  const m = await h.connectMcp(app, { ...member, via: 'Stepper' }, await h.mintToken(member, 'notes', 'Stepper'))
  after(async () => {
    await m.close()
    await collab.destroyCollab()
    await app.close()
    await closeDb()
  })

  const ok = async (name: string, args: Record<string, unknown>) => {
    const r = await m.tool(name, args)
    assert.equal(r.isError, false, `${name}: ${r.text}`)
    return r.text
  }
  /** step rows of a page, oldest first: the tool each one names */
  const steps = async (pageId: string) =>
    ((await db.execute(sql`SELECT step FROM page_snapshots WHERE page_id = ${pageId} AND step IS NOT NULL ORDER BY created_at, id`)) as unknown as {
      step: { tool: string }
    }[]).map((r) => r.step.tool)
  const listed = async (pageId: string) => (await ok('list_versions', { pageId })).match(/AI step \d+ \| [^\n]*/g) ?? []

  const created = JSON.parse(await ok('create_page', { workspaceId: `Steps lab ${W}`, title: 'Plan', markdown: '## Goals\nship v1\n\n## Files\nnone yet' })) as { id: string }
  const page = created.id

  it('upload_file: the link it writes into the page is one AI step (section and page end)', async () => {
    await ok('upload_file', { pageId: page, name: 'notes.txt', text: 'hello', section: 'files' })
    await ok('upload_file', { pageId: page, name: 'more.txt', text: 'again' })
    assert.deepEqual(await steps(page), ['patch_section', 'update_page'])
    const lines = await listed(page)
    assert.equal(lines.length, 2, lines.join('\n'))
    assert.match(lines[1], /AI step 1 \| by Mia via Stepper \| patch_section append §files \+1/)
    assert.match(lines[0], /AI step 2 \| by Mia via Stepper \| update_page append whole page \+1/)
  })

  it('a database view written as its token line by update_page is a step; read_page gives the same token back', async () => {
    const col = /Created collection ([0-9a-f-]{36})/.exec(await ok('create_collection', { workspaceId: `steps lab ${W}`.toUpperCase(), title: 'Board', fields: [{ name: 'Status', type: 'text' }] }))![1]
    const before = (await steps(page)).length
    await ok('update_page', { pageId: page, mode: 'append', markdown: `<!-- inkling:pageEmbed {"pageId":"${col}","viewId":""} -->` })
    assert.deepEqual((await steps(page)).slice(before), ['update_page'])
    const read = await ok('read_page', { pageId: page })
    // the default view id is left out when read back (the first view), with X2's name line under it
    assert.match(read, new RegExp(`<!-- inkling:pageEmbed \\{"pageId":"${col}"\\} -->\\n<!-- inkling:view-info database "Board", view "Table" \\(table\\)`))
    // restoring the step before it takes the view out again, as a step of its own
    const [prev] = (await ok('list_versions', { pageId: page })).match(/^([0-9a-f-]{36}) \| [^\n]*AI step 2/m) ?? []
    assert.ok(prev, 'the previous step is listed')
    await ok('restore_version', { pageId: page, version: prev.slice(0, 36) })
    assert.doesNotMatch(await ok('read_page', { pageId: page }), /inkling:pageEmbed/)
    assert.equal((await steps(page)).at(-1), 'restore_version')
  })

  it("a row's body written by an agent is a step of the row page; its properties are not (they are not in the document)", async () => {
    const col = /Created collection ([0-9a-f-]{36})/.exec(await ok('create_collection', { workspaceId: ws.id, title: 'Tasks', fields: [{ name: 'Status', type: 'text' }, { name: 'ID', type: 'uniqueId', prefix: 'TASK' }] }))![1]
    const rowOut = await ok('create_row', { collectionId: col, title: 'Write the API', properties: { Status: 'To do' } })
    const rowId = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.exec(rowOut)![0]
    await ok('update_page', { pageId: rowId, mode: 'append', markdown: 'Evidence: PR #1, tests green' })
    assert.deepEqual(await steps(rowId), ['update_page'])
    const line = (await ok('query_rows', { collectionId: col, format: 'lines' })).split('\n').find((l) => l.startsWith(rowId))
    assert.ok(line, 'the row is listed')
    await ok('update_row', { rowId, baseVersion: line!.split(' | ')[1], properties: { Status: 'Done' } })
    assert.deepEqual(await steps(rowId), ['update_page'], 'a property change leaves no step')
  })

  it("replace without baseVersion: the creator's page_added row read before its relabel is the agent's; others' rows stay a person's", async () => {
    // the change log may hold an agent-created page's page_added row without its client name for a
    // pass (the queued relabel, docs/adr/1005-*); written here directly, so the order is fixed
    const mk = async (title: string) => (JSON.parse(await ok('create_page', { workspaceId: ws.id, title, markdown: 'body' })) as { id: string }).id
    const row = async (pageId: string, actor: string, kind: string) => {
      await db.delete(schema.pageChanges).where(eq(schema.pageChanges.pageId, pageId))
      await db.insert(schema.pageChanges).values({ workspaceId: ws.id, pageId, kind, scope: 'shared', actorId: actor, viaClient: null, ...(kind === 'page_added' ? {} : { anchor: '_intro' }) })
    }
    const replace = (pageId: string) => m.tool('update_page', { pageId, markdown: 'new body', mode: 'replace' })
    const a = await mk('Race A')
    await row(a, member.id, 'page_added')
    assert.equal((await replace(a)).isError, false, 'the creator (via its created_via) is the agent')
    const b = await mk('Race B')
    await row(b, owner.id, 'page_added')
    const rb = await replace(b)
    assert.equal(rb.isError, true)
    assert.match(rb.text, /baseVersion is required to replace a page a person edited last \(Olivia\)/)
    const c = await mk('Race C')
    await row(c, member.id, 'modified')
    assert.equal((await replace(c)).isError, true, "a person's body edit (no via) still needs baseVersion")
  })

  it('import_zip by workspace name: new pages, no AI steps (nothing existed to undo; trash the top page)', async () => {
    const z = new JSZip()
    z.file('Kit/Readme.md', '# Readme\n\nsee [[Day]]\n')
    z.file('Kit/Day.md', 'a day')
    const zip = await z.generateAsync({ type: 'nodebuffer' })
    await ok('import_zip', { base64: zip.toString('base64'), workspaceId: `Steps lab ${W}` })
    const [readme] = await db.select({ id: schema.pages.id }).from(schema.pages).where(and(eq(schema.pages.workspaceId, ws.id), eq(schema.pages.title, 'Readme')))
    assert.ok(readme, 'imported into the named workspace')
    assert.deepEqual(await steps(readme.id), [])
    // an ambiguous or unknown name is refused with the candidates (ADR 2186)
    const bad = await m.tool('import_zip', { base64: zip.toString('base64'), workspaceId: 'Nowhere' })
    assert.equal(bad.isError, true)
    assert.match(bad.text, /no workspace of yours is named "Nowhere"/)
  })
})
