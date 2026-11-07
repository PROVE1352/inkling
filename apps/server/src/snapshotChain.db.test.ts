// Incremental version history and V2 storage end to end (docs/adr/1100-1103): snapshot rows chain
// as diffs with a whole state every SNAPSHOT_CHAIN_MAX rows, preview/compare/restore rebuild them,
// the 50-row cap rebases the oldest kept row, broken chains answer 409 and the next snapshot is
// whole, legacy V1 rows keep working and are converted on the next store without side effects, and
// the "large page" notice/list use the same thresholds as the agent hint.
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.DATA_DIR ||= `${process.env.TMPDIR || '/tmp'}/inkling-snapchain-${process.pid}`

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, describe, it } from 'node:test'
import * as Y from 'yjs'

const HAS_DB = !!process.env.DATABASE_URL

/** Appends one paragraph block to a BlockNote Y.Doc (blockGroup › blockContainer › paragraph). */
function appendParagraph(doc: Y.Doc, text: string): void {
  const group = doc.getXmlFragment('document').get(0) as Y.XmlElement
  const c = new Y.XmlElement('blockContainer')
  c.setAttribute('id', randomUUID())
  const p = new Y.XmlElement('paragraph')
  const t = new Y.XmlText()
  t.insert(0, text)
  p.insert(0, [t])
  c.insert(0, [p])
  group.push([c])
}

/** Deletes the top-level block whose text contains `needle`. */
function deleteParagraph(doc: Y.Doc, needle: string): void {
  const group = doc.getXmlFragment('document').get(0) as Y.XmlElement
  const arr = group.toArray()
  const i = arr.findIndex((c) => (c as Y.XmlElement).toString().includes(needle))
  assert.ok(i >= 0, `no block with ${needle}`)
  group.delete(i, 1)
}

describe('[db] incremental snapshots and V2 storage', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const h = await import('./mcpTools/testHarness')
  const { db, closeDb } = await import('./db/index')
  const { sql } = await import('drizzle-orm')
  const collab = await import('./collab')
  const store = await import('./snapshotStore')
  const { liveDoc } = await import('./liveConnections')
  const { stateToBlocks, blocksToStateBuffer } = await import('./md/convert')
  const yState = await import('./yState')
  const app = await h.buildTestApp()

  after(async () => {
    await collab.destroyCollab()
    await app.close()
    await closeDb()
  })

  let owner: Awaited<ReturnType<typeof h.makeUser>>
  let member: Awaited<ReturnType<typeof h.makeUser>>
  let ws: { id: string }

  const get = async (url: string, who = owner) => app.inject({ method: 'GET', url, headers: { cookie: who.cookie } })
  const post = async (url: string, body: unknown = {}) =>
    app.inject({ method: 'POST', url, headers: { cookie: owner.cookie, 'content-type': 'application/json' }, payload: JSON.stringify(body) })
  const preview = async (pageId: string, sid: string) => {
    const r = await get(`/api/pages/${pageId}/snapshots/${sid}/preview`)
    return { status: r.statusCode, markdown: r.statusCode === 200 ? (r.json() as { markdown: string }).markdown : '', body: r.body }
  }
  type Row = { id: string; base_id: string | null; depth: number; state_format: number; bytes: number; sv: Buffer | null }
  const rows = async (pageId: string): Promise<Row[]> =>
    (await db.execute(sql`
      SELECT id, base_id, depth, state_format, octet_length(state)::int AS bytes, state_vector AS sv
        FROM page_snapshots WHERE page_id = ${pageId} ORDER BY created_at, id
    `)) as unknown as Row[]
  const docRow = async (pageId: string) =>
    ((await db.execute(sql`
      SELECT state, state_format, state_vector, updated_at::text AS stamp FROM page_docs WHERE page_id = ${pageId}
    `)) as unknown as { state: Buffer; state_format: number; state_vector: Buffer | null; stamp: string }[])[0]
  const pageStamp = async (pageId: string) =>
    ((await db.execute(sql`SELECT updated_at::text AS u FROM pages WHERE id = ${pageId}`)) as unknown as { u: string }[])[0].u
  // A body of a few KB, so a one-paragraph diff stays under SNAPSHOT_DIFF_MAX_RATIO of the whole state.
  const newPage = async (title: string, text = 'first line') =>
    h.makeDocPage(ws.id, owner.id, title, [
      { type: 'paragraph', content: [{ type: 'text', text, styles: {} }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'padding '.repeat(600), styles: {} }] },
    ] as never)
  /**
   * The first store of a page takes the auto snapshot of the state before it (throttle empty). Take
   * it explicitly so it is row 0 and the 10-minute throttle is closed for the rest of the test.
   */
  const prime = async (pageId: string) => {
    await store.maybeAutoSnapshotStored(pageId)
    const r = await rows(pageId)
    assert.equal(r.length, 1)
    return r[0]
  }

  before(async () => {
    owner = await h.makeUser('owner')
    member = await h.makeUser('member')
    ws = await h.makeWorkspace(owner, [member])
  })

  it('snapshots chain as diffs, every version previews, compares and restores exactly', async () => {
    const page = await newPage('Chain')
    const auto = await prime(page.id)
    // the auto row keeps the stored (V1) bytes as they are, with their state vector
    assert.deepEqual([auto.state_format, auto.base_id, auto.depth, !!auto.sv], [1, null, 0, true])
    const conn = await collab.hocuspocus.openDirectConnection(page.id)
    const expected: string[] = []
    try {
      for (let i = 0; i < 12; i++) {
        await conn.transact((doc) => {
          appendParagraph(doc, `entry ${i} ${'x'.repeat(40)}`)
          if (i === 5) deleteParagraph(doc, 'entry 2 ')
        })
        await store.createSnapshot(page.id, liveDoc(page.id)!, `v${i}`, owner.id)
        expected.push((await preview(page.id, (await rows(page.id)).at(-1)!.id)).markdown)
      }
    } finally {
      await conn.disconnect()
    }
    const all = await rows(page.id)
    assert.equal(all.length, 13)
    // auto (whole V1), 9 diffs on it, whole (chain max 10), 2 diffs
    assert.deepEqual(all.map((x) => x.depth), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0, 1, 2])
    for (let i = 1; i < all.length; i++) if (all[i].base_id) assert.equal(all[i].base_id, all[i - 1].id)
    const r = all.slice(1)
    assert.ok(r.every((x) => x.state_format === 2 && x.sv))
    assert.equal(r[9].base_id, null)
    assert.ok(r[5].bytes * 5 < r[9].bytes, `a diff (${r[5].bytes} B) is much smaller than the whole state (${r[9].bytes} B)`)
    // each version reads back with the content it had: entry i present, entry 2 gone from v5 on
    for (let i = 0; i < 12; i++) {
      assert.match(expected[i], new RegExp(`entry ${i} `))
      assert.equal(expected[i].includes('entry 2 '), i >= 2 && i < 5, `v${i}`)
      assert.equal((await preview(page.id, r[i].id)).markdown, expected[i], `re-read v${i}`)
    }
    // compare: v3 (diff) against v8 (diff), and against the current document
    const cmp = await get(`/api/pages/${page.id}/snapshots/${r[3].id}/diff?against=${r[8].id}`)
    assert.equal(cmp.statusCode, 200, cmp.body)
    const ops = (cmp.json() as { ops: { op: string; text?: string }[] }).ops
    assert.ok(JSON.stringify(ops).includes('entry 7'), 'v8 adds entry 7')
    const cur = await get(`/api/pages/${page.id}/snapshots/${r[3].id}/diff`)
    assert.equal(cur.statusCode, 200, cur.body)
    // restore a diff row: the page becomes that version, and a whole-or-diff "Before restore" row is added
    const res = await post(`/api/pages/${page.id}/snapshots/${r[6].id}/restore`)
    assert.equal(res.statusCode, 200, res.body)
    const blocks = stateToBlocks((await docRow(page.id)).state)
    const body = JSON.stringify(blocks)
    assert.ok(body.includes('entry 6 ') && !body.includes('entry 7 ') && !body.includes('entry 2 '))
    const after = await rows(page.id)
    assert.equal(after.length, 14)
    assert.match((await preview(page.id, after.at(-1)!.id)).markdown, /entry 11 /)
  })

  it('the 50-row cap rebases the oldest kept row; every kept version stays readable', async () => {
    const page = await newPage('Cap')
    await prime(page.id)
    const conn = await collab.hocuspocus.openDirectConnection(page.id)
    const rebased0 = store.snapshotStats.rebased
    try {
      for (let i = 0; i < store.MAX_SNAPSHOTS_PER_PAGE + 7; i++) {
        await conn.transact((doc) => appendParagraph(doc, `cap ${i}`))
        await store.createSnapshot(page.id, liveDoc(page.id)!, `c${i}`, owner.id)
      }
    } finally {
      await conn.disconnect()
    }
    const r = await rows(page.id)
    assert.equal(r.length, store.MAX_SNAPSHOTS_PER_PAGE)
    assert.equal(r[0].base_id, null, 'the oldest kept row is whole')
    assert.equal(r[0].depth, 0)
    assert.ok(store.snapshotStats.rebased - rebased0 >= 1)
    // depths follow the chain after rebasing
    const byId = new Map(r.map((x) => [x.id, x]))
    for (const x of r) assert.equal(x.depth, x.base_id ? byId.get(x.base_id)!.depth + 1 : 0)
    // 1 auto row + 57 = 58 written, the newest 50 kept: rows hold cap 7 … cap 56
    for (const [i, x] of r.entries()) {
      const p = await preview(page.id, x.id)
      assert.equal(p.status, 200, p.body)
      assert.match(p.markdown, new RegExp(`cap ${i + 7}\\b`))
      assert.doesNotMatch(p.markdown, new RegExp(`cap ${i + 8}\\b`))
    }
    // the list still shows 50
    const list = (await get(`/api/pages/${page.id}/snapshots`)).json() as { snapshots: unknown[] }
    assert.equal(list.snapshots.length, store.MAX_SNAPSHOTS_PER_PAGE)
  })

  it('a broken chain answers 409 SNAPSHOT_UNAVAILABLE and the next snapshot is whole', async () => {
    const page = await newPage('Broken')
    await prime(page.id)
    const conn = await collab.hocuspocus.openDirectConnection(page.id)
    try {
      for (let i = 0; i < 4; i++) {
        await conn.transact((doc) => appendParagraph(doc, `b ${i}`))
        await store.createSnapshot(page.id, liveDoc(page.id)!, null, owner.id)
      }
      let r = (await rows(page.id)).slice(1)
      assert.ok(r.every((x) => x.base_id))
      // a missing base (row deleted behind our back)
      await db.execute(sql`DELETE FROM page_snapshots WHERE id = ${r[1].id}`)
      const p = await preview(page.id, r[2].id)
      assert.equal(p.status, 409)
      assert.match(p.body, /SNAPSHOT_UNAVAILABLE/)
      const rs = await post(`/api/pages/${page.id}/snapshots/${r[3].id}/restore`)
      assert.equal(rs.statusCode, 409, 'restore refuses before touching anything')
      assert.equal((await rows(page.id)).length, 4, 'no "Before restore" row was added')
      // the next snapshot does not build on the broken chain
      await conn.transact((doc) => appendParagraph(doc, 'b 4'))
      await store.createSnapshot(page.id, liveDoc(page.id)!, null, owner.id)
      r = await rows(page.id)
      assert.equal(r.at(-1)!.base_id, null)
      assert.match((await preview(page.id, r.at(-1)!.id)).markdown, /b 4/)
      // corrupted diff bytes: decode fails or the rebuilt state vector does not match
      await conn.transact((doc) => appendParagraph(doc, 'b 5'))
      await store.createSnapshot(page.id, liveDoc(page.id)!, null, owner.id)
      r = await rows(page.id)
      const last = r.at(-1)!
      assert.ok(last.base_id)
      await db.execute(sql`UPDATE page_snapshots SET state = ${Buffer.from(Y.encodeStateAsUpdateV2(new Y.Doc()))} WHERE id = ${last.id}`)
      assert.equal((await preview(page.id, last.id)).status, 409)
      // the base row is unaffected
      assert.equal((await preview(page.id, last.base_id!)).status, 200)
    } finally {
      await conn.disconnect()
    }
  })

  it('a document holding pending structs snapshots whole and its versions still preview and restore', async () => {
    const page = await newPage('Pending')
    await prime(page.id)
    const conn = await collab.hocuspocus.openDirectConnection(page.id)
    try {
      await conn.transact((doc) => appendParagraph(doc, 'before pending'))
      // A peer edit whose dependency never reaches the server: text typed into a block the server never got.
      await conn.transact((doc) => {
        const peer = new Y.Doc()
        Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc))
        appendParagraph(peer, 'lost block')
        const sv = Y.encodeStateVector(peer)
        const group = peer.getXmlFragment('document').get(0) as Y.XmlElement
        const text = ((group.get(group.length - 1) as Y.XmlElement).get(0) as Y.XmlElement).get(0) as Y.XmlText
        text.insert(text.length, ' typed later')
        Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer, sv))
        assert.ok(doc.store.pendingStructs, 'the live document holds pending structs')
      })
      const f0 = store.snapshotStats.fallback
      for (let i = 0; i < 2; i++) {
        await conn.transact((doc) => appendParagraph(doc, `after pending ${i}`))
        await store.createSnapshot(page.id, liveDoc(page.id)!, null, owner.id)
      }
      assert.equal(store.snapshotStats.fallback, f0, 'no failed-check fallback')
    } finally {
      await conn.disconnect()
    }
    const r = await rows(page.id)
    for (const x of r) {
      const p = await preview(page.id, x.id)
      assert.equal(p.status, 200, p.body)
    }
    assert.match((await preview(page.id, r.at(-1)!.id)).markdown, /after pending 1/)
    const res = await post(`/api/pages/${page.id}/snapshots/${r[1].id}/restore`)
    assert.equal(res.statusCode, 200, res.body)
  })

  it('legacy V1 rows: whole V1 snapshots read, the next snapshot starts a chain, page_docs converts on the next store', async () => {
    const page = await newPage('Legacy', 'legacy body')
    const before = await docRow(page.id)
    assert.equal(before.state_format, 1)
    assert.equal(yState.wholeStateFormat(before.state), yState.STATE_V1)
    // a snapshot row as v0.4.0 wrote it (whole V1 state, no chain columns)
    // (created now: it also closes the auto-snapshot throttle)
    await db.execute(sql`INSERT INTO page_snapshots (page_id, state) VALUES (${page.id}, ${before.state})`)
    const legacy = (await rows(page.id))[0]
    assert.equal(legacy.sv, null)
    assert.match((await preview(page.id, legacy.id)).markdown, /legacy body/)
    const pageStamp0 = await pageStamp(page.id)
    const st0 = { ...collab.storeStats }

    // Open and close without an edit: the row is rewritten as V2, nothing else happens.
    const conn = await collab.hocuspocus.openDirectConnection(page.id)
    await conn.transact(() => {})
    await conn.disconnect()
    const conv = await docRow(page.id)
    assert.equal(conv.state_format, 2)
    assert.equal(yState.wholeStateFormat(conv.state), yState.STATE_V2)
    assert.equal(conv.stamp, before.stamp, 'page_docs.updated_at kept')
    assert.equal(await pageStamp(page.id), pageStamp0, 'pages.updated_at kept')
    assert.equal(collab.storeStats.written - st0.written, 0)
    assert.equal(collab.storeStats.converted - st0.converted, 1)
    assert.equal((await rows(page.id)).length, 1, 'no snapshot taken')
    assert.deepEqual(stateToBlocks(conv.state), stateToBlocks(before.state))
    assert.ok(conv.state.length < before.state.length || before.state.length < 400, 'V2 is not larger')
    assert.ok(yState.stateVectorsEqual(conv.state_vector!, Y.encodeStateVector(yState.docFromStoredState(before.state))))

    // the next snapshot cannot diff against the legacy row (no state vector): whole, then diffs
    const c2 = await collab.hocuspocus.openDirectConnection(page.id)
    try {
      await c2.transact((doc) => appendParagraph(doc, 'after upgrade'))
      await store.createSnapshot(page.id, liveDoc(page.id)!, null, owner.id)
      await c2.transact((doc) => appendParagraph(doc, 'second'))
      await store.createSnapshot(page.id, liveDoc(page.id)!, null, owner.id)
    } finally {
      await c2.disconnect()
    }
    const r = await rows(page.id)
    assert.deepEqual(r.map((x) => [x.state_format, x.base_id === null, x.depth]), [[1, true, 0], [2, true, 0], [2, false, 1]])
    for (const x of r) assert.equal((await preview(page.id, x.id)).status, 200)
  })

  it('auto snapshots diff the stored V2 state against the previous snapshot', async () => {
    const page = await newPage('Auto')
    const conn = await collab.hocuspocus.openDirectConnection(page.id)
    try {
      await conn.transact((doc) => appendParagraph(doc, 'auto 1'))
      // the store above wrote V2 + its state vector; the throttle starts with no snapshot
      store.forgetSnapshotThrottle(page.id)
      await store.maybeAutoSnapshotStored(page.id)
      await conn.transact((doc) => appendParagraph(doc, 'auto 2'))
      // open the throttle window by ageing the first snapshot
      await db.execute(sql`UPDATE page_snapshots SET created_at = created_at - interval '1 hour' WHERE page_id = ${page.id}`)
      store.forgetSnapshotThrottle(page.id)
      await store.maybeAutoSnapshotStored(page.id)
      // inside the window: no third row
      await store.maybeAutoSnapshotStored(page.id)
    } finally {
      await conn.disconnect()
    }
    const r = await rows(page.id)
    assert.equal(r.length, 2)
    assert.equal(r[0].base_id, null)
    assert.equal(r[1].base_id, r[0].id)
    assert.match((await preview(page.id, r[1].id)).markdown, /auto 2/)
  })

  it('every reader accepts V1 and V2 rows alike (read_page, export, sync revision, duplicate)', async () => {
    const blocks = [
      { type: 'heading', props: { level: 2 }, content: [{ type: 'text', text: 'Mixed', styles: {} }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'same body [[Chain]]', styles: {} }] },
    ]
    const v1Page = await h.makeDocPage(ws.id, owner.id, 'Mixed V1', blocks as never)
    const v2Page = await h.makeDocPage(ws.id, owner.id, 'Mixed V2', blocks as never)
    const v2 = Y.convertUpdateFormatV1ToV2(blocksToStateBuffer(blocks as never))
    await db.execute(sql`UPDATE page_docs SET state = ${Buffer.from(v2)}, state_format = 2 WHERE page_id = ${v2Page.id}`)
    const mcp = await h.connectMcp(app, owner, await h.mintToken(owner))
    // the body part of read_page (the header carries ids and timestamps)
    const read = async (id: string) => (await mcp.tool('read_page', { pageId: id })).text.split('\n---\n')[1].replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, 'X').replace(/ last_edit="[^"]*"/, '')
    assert.equal(await read(v2Page.id), await read(v1Page.id))
    const md = async (id: string) => {
      const r = await get(`/api/pages/${id}/export?format=md`)
      assert.equal(r.statusCode, 200, r.body)
      return r.body.replace(/Mixed V[12]/g, 'Mixed').replace(/^(inkling-id|updated): .*$/gm, '')
    }
    const m1 = await md(v1Page.id)
    assert.match(m1, /same body/)
    assert.equal(await md(v2Page.id), m1)
    const { revisionFromState } = await import('./md/syncMd')
    const v1 = (await docRow(v1Page.id)).state
    assert.equal(revisionFromState(Y.convertUpdateFormatV1ToV2(v1), 'm'), revisionFromState(v1, 'm'), 'vault-sync revision does not depend on the format')
    const dup = await post(`/api/pages/${v2Page.id}/duplicate`)
    assert.equal(dup.statusCode, 200, dup.body)
    const copyId = (dup.json() as { pages: { id: string }[] }).pages[0].id
    assert.equal((await docRow(copyId)).state_format, 2)
    assert.equal(await read(copyId), await read(v2Page.id))
  })

  it('large page facts: notice threshold on V1-equivalent bytes or tokens; list for owners and admins', async () => {
    const small = await newPage('Small one')
    const s = (await get(`/api/pages/${small.id}/size`)).json() as { large: boolean; stateBytes: number }
    assert.equal(s.large, false)
    assert.ok(s.stateBytes > 0)
    // a V2 row of 0.8 MiB counts as ≈ 1.17 MiB of V1: large
    const big = await newPage('Big by bytes')
    const filler = Buffer.alloc(Math.floor(0.8 * 1024 * 1024), 1)
    await db.execute(sql`UPDATE page_docs SET state = ${Buffer.concat([Buffer.from([0]), filler])}, state_format = 2 WHERE page_id = ${big.id}`)
    const b = (await get(`/api/pages/${big.id}/size`)).json() as { large: boolean; stateBytes: number }
    assert.equal(b.large, true)
    assert.ok(b.stateBytes >= 1024 * 1024)
    // the same bytes as V1 are below the threshold
    await db.execute(sql`UPDATE page_docs SET state_format = 1 WHERE page_id = ${big.id}`)
    assert.equal(((await get(`/api/pages/${big.id}/size`)).json() as { large: boolean }).large, false)
    await db.execute(sql`UPDATE page_docs SET state_format = 2 WHERE page_id = ${big.id}`)
    // by tokens
    const tok = await newPage('Big by tokens')
    await db.execute(sql`
      INSERT INTO page_chunks (page_id, ord, workspace_id, anchor, text, hash, section_hash, token_estimate)
      VALUES (${tok.id}, 0, ${ws.id}, '_intro', 'x', 'h', 'h', 60000)
    `)
    assert.equal(((await get(`/api/pages/${tok.id}/size`)).json() as { large: boolean }).large, true)
    // a private page of the owner is hidden from other admins; members get 403
    await db.execute(sql`UPDATE pages SET scope = 'private' WHERE id = ${tok.id}`)
    const list = await get(`/api/workspaces/${ws.id}/large-pages`)
    assert.equal(list.statusCode, 200, list.body)
    const ids = (list.json() as { pages: { id: string; snapshotCount: number }[] }).pages.map((p) => p.id)
    assert.ok(ids.includes(big.id) && ids.includes(tok.id) && !ids.includes(small.id))
    assert.equal((await get(`/api/workspaces/${ws.id}/large-pages`, member)).statusCode, 403)
    await db.execute(sql`UPDATE workspace_members SET role = 'admin' WHERE workspace_id = ${ws.id} AND user_id = ${member.id}`)
    const asAdmin = (await get(`/api/workspaces/${ws.id}/large-pages`, member)).json() as { pages: { id: string }[] }
    assert.ok(asAdmin.pages.some((p) => p.id === big.id))
    assert.ok(!asAdmin.pages.some((p) => p.id === tok.id), "another member's private page is not listed")
  })
})
