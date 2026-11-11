// MCP tool annotations against a read-only connection (docs/adr/2460-*): every tool is called with
// valid arguments through a connection with scope 'read'. readOnlyHint=true tools are never refused,
// every refused tool has readOnlyHint=false, and the only tools that are callable but not read-only
// are the ones listed below with the reason.
// Run alone: cd apps/server && DATABASE_URL=postgres://… node --import tsx --test --test-reporter=spec src/mcpTools/toolAnnotations.db.test.ts
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.APP_URL ||= 'https://notes.example.com'

import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'

const HAS_DB = !!process.env.DATABASE_URL

/** Callable on a read-only connection although readOnlyHint is false (ADR 2460). */
const CALLABLE_NOT_READ_ONLY: Record<string, string> = {
  catch_up: 'moves its own "last catch_up" marker (a GET route, so read-only tokens keep it)',
  more_tools: 'lists and runs hidden tools; the tool it runs decides (a write is refused there)',
}

/** The refusal of a read-only connection: wrapWrite (MCP) or the REST backstop (auth.ts). */
const REFUSED = /read-only \(scope 'read'\)/i

describe('[db] tool annotations and the read-only connection', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const h = await import('./testHarness')
  const { db, closeDb } = await import('../db/index')
  const schema = await import('../db/schema')
  const { eq } = await import('drizzle-orm')
  const { TOOL_ANNOTATIONS } = await import('./annotations')

  const app = await h.buildTestApp()
  const owner = await h.makeUser('Ann')
  const ws = await h.makeWorkspace(owner)
  const W = await h.connectMcp(app, owner, await h.mintToken(owner, 'notes', 'Writer'))
  const roToken = await h.mintToken(owner, 'read', 'Reader')
  const RO = await h.connectMcp(app, owner, roToken, { canWrite: false })
  const ROcore = await h.connectMcp(app, owner, roToken, { canWrite: false, profile: 'core' })
  after(async () => {
    for (const c of [W, RO, ROcore]) await c.close()
    await app.close()
    await closeDb()
  })

  const ok = (r: { text: string; isError: boolean }) => {
    assert.equal(r.isError, false, r.text)
    return r.text
  }
  const pageId = JSON.parse(ok(await W.tool('create_page', { workspaceId: ws.id, title: 'Plan', markdown: '## Alpha\n\none\n\n## Beta\n\ntwo\n' })).split('\n')[0]).id as string
  const trashedId = JSON.parse(ok(await W.tool('create_page', { workspaceId: ws.id, title: 'Old', markdown: 'x' })).split('\n')[0]).id as string
  ok(await W.tool('trash_page', { pageId: trashedId }))
  const collectionId = /Created collection ([0-9a-f-]{36})/.exec(
    ok(await W.tool('create_collection', { workspaceId: ws.id, title: 'Tasks', fields: [{ name: 'Status', type: 'select', options: ['Todo', 'Done'] }] })),
  )![1]
  const rowId = /^Created row ([0-9a-f-]{36})/.exec(ok(await W.tool('create_row', { collectionId, title: 'first', properties: { Status: 'Todo' } })))![1]
  ok(await W.tool('add_comment', { pageId, text: 'a question' }))
  const [thread] = await db.select({ id: schema.comments.threadId }).from(schema.comments).where(eq(schema.comments.pageId, pageId)).limit(1)
  const suggestionId = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/.exec(
    ok(await W.tool('patch_section', { pageId, section: 'beta', markdown: 'three', mode: 'append', suggest: true })),
  )![1]
  const anyFullId = '00000000-0000-4000-8000-000000000001'
  // an empty zip (end of central directory only)
  const emptyZip = Buffer.from([0x50, 0x4b, 0x05, 0x06, ...new Array(18).fill(0)]).toString('base64')

  /** Arguments that pass each tool's schema and id resolution. A new tool needs a line here. */
  const ARGS: Record<string, Record<string, unknown>> = {
    list_workspaces: {},
    list_pages: { workspaceId: ws.id },
    search: { query: 'one', workspaceId: ws.id },
    read_page: { pageId },
    create_page: { workspaceId: ws.id, title: 'New' },
    import_folder: { workspaceId: ws.id, folderName: 'Folder', files: [{ path: 'a.md', markdown: 'a' }] },
    update_page: { pageId, markdown: 'more', mode: 'append' },
    rename_page: { pageId, title: 'Renamed' },
    move_page: { pageId, parentId: null },
    trash_page: { pageId },
    list_templates: { workspaceId: ws.id },
    create_from_template: { workspaceId: ws.id, template: 'meeting' },
    list_comments: { pageId },
    add_comment: { pageId, text: 'x' },
    reply_comment: { threadId: thread.id, text: 'x' },
    resolve_comment: { threadId: thread.id },
    inbox: { workspaceId: ws.id },
    ack: { ids: ['1'] },
    later: { workspaceId: ws.id },
    find_context: { query: 'one', workspaceId: ws.id },
    read_pages: { pageIds: [pageId] },
    patch_section: { pageId, section: 'alpha', markdown: 'x', mode: 'append' },
    patch_sections: { pageId, edits: [{ section: 'alpha', markdown: 'x', mode: 'append' }] },
    get_instructions: { workspaceId: ws.id },
    changes_since: { workspaceId: ws.id },
    query_rows: { collectionId },
    update_row: { rowId, properties: { Status: 'Done' }, baseVersion: 'x' },
    create_row: { collectionId, title: 'second' },
    create_chart: { pageId, collectionId, kind: 'bar', groupBy: 'Status' },
    create_view: { collectionId, type: 'table', name: 'All' },
    split_page: { pageId, dry_run: true },
    read_ink: { pageId },
    list_versions: { pageId },
    diff_versions: { pageId, from: 'current' },
    restore_version: { pageId, version: anyFullId },
    list_trash: { workspaceId: ws.id },
    restore_page: { pageId: trashedId },
    read_file: { file: anyFullId },
    upload_file: { pageId, name: 'a.txt', text: 'a' },
    import_zip: { base64: emptyZip, workspaceId: ws.id },
    catch_up: { workspaceId: ws.id },
    list_suggestions: { pageId },
    withdraw_suggestion: { suggestionId },
    claim_section: { pageId, section: 'alpha' },
    release_section: { pageId, section: 'alpha' },
    create_collection: { workspaceId: ws.id, title: 'More', fields: [] },
    update_fields: { collectionId, order: ['Status'] },
    check_notes: { workspaceId: ws.id },
    more_tools: {},
  }

  it('every annotated tool has arguments here', () => {
    assert.deepEqual(Object.keys(ARGS).sort(), Object.keys(TOOL_ANNOTATIONS).sort())
  })

  it('readOnlyHint agrees with what a read-only connection may call', async () => {
    const refused: string[] = []
    const callable: string[] = []
    for (const [name, args] of Object.entries(ARGS)) {
      const r = await (name === 'more_tools' ? ROcore : RO).tool(name, args)
      // the arguments must reach the handler: a schema or id error would hide a refusal
      assert.doesNotMatch(r.text, /Input validation error|expected a \w+ id|no workspace of yours|workspaceId is required/, `${name}: ${r.text}`)
      ;(REFUSED.test(r.text) ? refused : callable).push(name)
    }
    for (const name of refused) assert.equal(TOOL_ANNOTATIONS[name].readOnlyHint, false, `${name} is refused on a read-only connection but marked read-only`)
    for (const [name, a] of Object.entries(TOOL_ANNOTATIONS)) {
      if (a.readOnlyHint) assert.ok(callable.includes(name), `${name} is marked read-only but a read-only connection is refused`)
    }
    const callableWrites = callable.filter((n) => !TOOL_ANNOTATIONS[n].readOnlyHint).sort()
    assert.deepEqual(callableWrites, Object.keys(CALLABLE_NOT_READ_ONLY).sort())
    assert.equal(refused.length + callable.length, Object.keys(TOOL_ANNOTATIONS).length)
  })

  it('catch_up on a read-only connection stores its marker (why it is not read-only); peek does not', async () => {
    const markers = async () => (await db.select().from(schema.catchUpMarkers).where(eq(schema.catchUpMarkers.userId, owner.id))).length
    const ro = await h.connectMcp(app, owner, await h.mintToken(owner, 'read', 'Peek'), { canWrite: false })
    try {
      const before = await markers()
      ok(await ro.tool('catch_up', { peek: true }))
      assert.equal(await markers(), before)
      ok(await ro.tool('catch_up', {}))
      assert.ok((await markers()) > before)
    } finally {
      await ro.close()
    }
  })

  it('more_tools runs a hidden write tool only as that tool allows (refused on a read-only connection)', async () => {
    const r = await ROcore.tool('more_tools', { tool: 'restore_version', arguments: { pageId, version: anyFullId } })
    assert.match(r.text, REFUSED)
  })
})
