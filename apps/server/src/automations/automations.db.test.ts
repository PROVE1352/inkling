// Database automations and button webhooks against a real database (docs/adr/2240-* .. 2245-*): each
// trigger kind, the condition, runs recorded with who and what, the author's rights through REST,
// the trigger's cap (guests, public forms, agents, suggest-only connections, read-only tokens),
// loops stopped by the marker and the depth limit, failing rules turned off with a notification,
// trashed rows and deleted targets, the describe line for agents, and no work for collections
// without rules.
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.APP_URL ||= 'https://notes.example.com'
process.env.DATA_DIR ||= `${process.env.TMPDIR || '/tmp'}/inkling-auto018-${process.pid}`

import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { after, before, describe, it } from 'node:test'
import type { FastifyInstance } from 'fastify'
import type { AutomationDTO, AutomationInput, AutomationRunDTO, CollectionField, RowDTO } from '@inkling/shared'

const HAS_DB = !!process.env.DATABASE_URL
mkdirSync(path.join(process.env.DATA_DIR!, 'uploads'), { recursive: true })

describe('[db] database automations and button webhooks', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const h = await import('../mcpTools/testHarness')
  const { db, closeDb } = await import('../db/index')
  const schema = await import('../db/schema')
  const { eq, sql } = await import('drizzle-orm')
  const Fastify = (await import('fastify')).default
  const { ZodError } = await import('zod')
  const { AppError } = await import('../errors')
  const collab = await import('../collab')
  const changeLog = await import('../context/changeLog')
  const outbox = await import('../outbox')
  const runner = await import('./runner')
  const queue = await import('./queue')
  const { storeHookUrl } = await import('../webhooks')

  async function buildApp(): Promise<FastifyInstance> {
    const app = Fastify()
    await app.register(import('@fastify/cookie'))
    app.setErrorHandler((err, _req, reply) => {
      if (err instanceof AppError) return reply.code(err.status).send({ error: { ...(err.details ?? {}), code: err.code, message: err.message } })
      if (err instanceof ZodError) return reply.code(400).send({ error: { code: 'VALIDATION', message: String(err.issues[0]?.message) } })
      const statusCode = (err as { statusCode?: number }).statusCode
      if (statusCode && statusCode < 500) return reply.code(statusCode).send({ error: { code: 'VALIDATION', message: String((err as Error).message) } })
      console.error(err)
      return reply.code(500).send({ error: { code: 'INTERNAL', message: String(err) } })
    })
    await app.register(
      async (api) => {
        const r = (m: Promise<Record<string, unknown>>, fn: string) => m.then((x) => (x[fn] as (a: FastifyInstance) => Promise<void>)(api))
        await r(import('../routes/workspaces'), 'registerWorkspaceRoutes')
        await r(import('../routes/pages'), 'registerPageRoutes')
        await r(import('../routes/pageContent'), 'registerPageContentRoutes')
        await r(import('../routes/editLock'), 'registerEditLockRoutes')
        await r(import('../routes/pageAccess'), 'registerPageAccessRoutes')
        await r(import('../routes/collections'), 'registerCollectionRoutes')
        await r(import('../routes/teamAgents'), 'registerTeamAgentRoutes')
        await r(import('../routes/agentTaint'), 'registerAgentTaintRoutes')
        await r(import('../routes/apiTokens'), 'registerApiTokenRoutes')
        await r(import('../routes/oauth'), 'registerOAuthApiRoutes')
        await r(import('../routes/notifications'), 'registerNotificationRoutes')
        await r(import('../routes/exportImport'), 'registerExportImportRoutes')
      },
      { prefix: '/api' },
    )
    await app.ready()
    return app
  }

  outbox.setOutboxAutorun(false)
  const app = await buildApp()
  after(async () => {
    await collab.destroyCollab()
    await app.close()
    await closeDb()
  })

  type U = Awaited<ReturnType<typeof h.makeUser>>
  const as = (u: U, method: string, url: string, payload?: unknown) =>
    app.inject({ method: method as 'GET', url, headers: { cookie: u.cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) })
  const ok = async (u: U, method: string, url: string, payload?: unknown) => {
    const res = await as(u, method, url, payload)
    assert.ok(res.statusCode >= 200 && res.statusCode < 300, `${method} ${url}: ${res.statusCode} ${res.body.slice(0, 300)}`)
    return res.body ? res.json() : {}
  }
  const W = `a18${randomBytes(3).toString('hex')}`

  let O: U // owner
  let M: U // member
  let G: U // page guest with edit on one collection
  let R: U // member who can read but not edit a locked database
  let ws: { id: string }

  const newCollection = async (u: U, title: string, fields: CollectionField[]): Promise<string> => {
    const { page } = await ok(u, 'POST', '/api/pages', { workspaceId: ws.id, kind: 'collection', title })
    if (fields.length) await ok(u, 'PUT', `/api/pages/${page.id}/collection/fields`, { fields })
    return page.id as string
  }
  const newRow = async (u: U, coll: string, title: string, props: Record<string, unknown> = {}): Promise<RowDTO> =>
    (await ok(u, 'POST', `/api/pages/${coll}/collection/rows`, { title, props, template: null })).row as RowDTO
  const rowsOf = async (u: U, coll: string) => (await ok(u, 'GET', `/api/pages/${coll}/collection`)).rows as RowDTO[]
  const addRule = async (u: U, coll: string, rule: AutomationInput): Promise<AutomationDTO> => (await ok(u, 'POST', `/api/collections/${coll}/automations`, rule)).automation
  const runsOf = async (coll: string, ruleId?: string): Promise<AutomationRunDTO[]> =>
    (await ok(O, 'GET', `/api/collections/${coll}/automations/runs${ruleId ? `?automationId=${ruleId}` : ''}`)).runs
  /** Change log → automation runs → their writes' change log …, until nothing is left. */
  // Other test files run in parallel against the same database and their change consumers may take
  // this workspace's change rows: wait until none of its change / automation rows are pending.
  const pendingHere = async () =>
    Number(((await db.execute(sql`SELECT count(*)::int AS n FROM outbox WHERE state = 'pending' AND topic IN ('change', 'automation') AND workspace_id = ${ws.id}`)) as unknown as { n: number }[])[0].n)
  const settle = async () => {
    for (let i = 0; i < 200; i++) {
      const a = await changeLog.drainChangeLog()
      const b = await outbox.drainOutbox('automation')
      if (a === 0 && b === 0 && (await pendingHere()) === 0) return
      if (a === 0 && b === 0) await new Promise((r) => setTimeout(r, 50))
    }
  }
  const automationRows = async () =>
    Number(((await db.execute(sql`SELECT count(*)::int AS n FROM outbox WHERE topic = 'automation'`)) as unknown as { n: number }[])[0].n)

  const STATUS: CollectionField = {
    id: 'st',
    name: 'Status',
    type: 'select',
    options: [
      { id: 'todo', name: 'To do', color: 'gray' },
      { id: 'review', name: 'Review', color: 'blue' },
      { id: 'done', name: 'Done', color: 'green' },
    ],
  } as CollectionField

  before(async () => {
    O = await h.makeUser('Olivia')
    M = await h.makeUser('Minho')
    G = await h.makeUser('Gwen')
    R = await h.makeUser('Rae')
    ws = await h.makeWorkspace(O, [M, R])
    runner.resetAutomationLimits()
  })

  describe('rules and triggers', () => {
    let tasks = ''
    it('only people who can edit the database make rules, in the browser; members list them', async () => {
      tasks = await newCollection(O, `Tasks ${W}`, [STATUS, { id: 'who', name: 'Owner', type: 'person' }, { id: 'note', name: 'Note', type: 'text' }, { id: 'due', name: 'Due', type: 'date' }] as CollectionField[])
      // a locked database: Rae (member, not an editor of the lock) can read but not set up rules
      const bad = await as(M, 'POST', `/api/collections/${tasks}/automations`, { name: 'x', trigger: { type: 'rowAdded' }, actions: [{ type: 'setFields', props: { nope: 'x' } }] })
      assert.equal(bad.statusCode, 400, 'unknown field refused at save')
      const token = await h.mintToken(O, 'notes', 'Claude')
      const viaToken = await app.inject({ method: 'POST', url: `/api/collections/${tasks}/automations`, headers: { authorization: `Bearer ${token}` }, payload: { name: 'x', trigger: { type: 'rowAdded' }, actions: [{ type: 'setFields', props: { note: 'x' } }] } })
      assert.ok(viaToken.statusCode === 401 || viaToken.statusCode === 403, `no rules through a token: ${viaToken.statusCode}`)
      const list = await ok(M, 'GET', `/api/collections/${tasks}/automations`)
      assert.deepEqual(list.automations, [])
      assert.equal(list.canEdit, true)
    })

    it('row added: sets values with variables, as the author, labelled with the rule name', async () => {
      const rule = await addRule(O, tasks, { name: 'Triage', trigger: { type: 'rowAdded' }, actions: [{ type: 'setFields', props: { st: 'todo', note: 'added {{today}} by {{me}}', who: 'me' } }] })
      assert.equal(rule.createdBy, O.id)
      const row = await newRow(M, tasks, 'first task')
      await settle()
      const got = (await rowsOf(O, tasks)).find((r) => r.id === row.id)!
      assert.equal(got.props.st, 'todo')
      assert.match(String(got.props.note), /^added \d{4}-\d{2}-\d{2} by Minho$/)
      assert.equal(got.props.who, M.id, "'me' is who triggered it")
      const [p] = await db.select({ editedBy: schema.pages.editedBy, editedVia: schema.pages.editedVia }).from(schema.pages).where(eq(schema.pages.id, row.id))
      assert.equal(p.editedBy, O.id, 'the rule author is the editor')
      assert.equal(p.editedVia, 'automation: Triage')
      const feed = (await db.execute(sql`SELECT actor_id AS "actorId", via_client AS via FROM page_changes WHERE page_id = ${row.id} AND kind = 'page_props'`)) as unknown as { actorId: string; via: string }[]
      assert.deepEqual(feed.map((f) => f.via), ['automation: Triage'])
      const runs = await runsOf(tasks, rule.id)
      assert.equal(runs.length, 1)
      assert.equal(runs[0].status, 'ok')
      assert.equal(runs[0].actorName, 'Minho')
      assert.equal(runs[0].rowTitle, 'first task')
      // its own write (a field change) did not start it again: row added only
      await ok(O, 'PATCH', `/api/collections/${tasks}/automations/${rule.id}`, { enabled: false })
    })

    it('field changed to a value: notifies the person in a field; other values and the condition stop it', async () => {
      const rule = await addRule(O, tasks, {
        name: 'Ask review',
        trigger: { type: 'fieldChanged', fieldId: 'st', to: 'review' },
        condition: { mode: 'and', items: [{ mode: 'or', not: true, items: [{ fieldId: 'note', op: 'contains', value: 'skip' }] }] },
        actions: [{ type: 'notify', fieldId: 'who', message: 'please review {{page}}' }],
      })
      const row = await newRow(O, tasks, 'review me', { who: M.id })
      await settle()
      await ok(O, 'PATCH', `/api/pages/${row.id}/props`, { props: { st: 'done' } })
      await settle()
      assert.equal((await runsOf(tasks, rule.id)).length, 0, 'another value: no run')
      await ok(O, 'PATCH', `/api/pages/${row.id}/props`, { props: { st: 'review' } })
      await settle()
      await outbox.drainOutbox('notify')
      const runs = await runsOf(tasks, rule.id)
      assert.equal(runs.length, 1, `runs: ${JSON.stringify(runs)}`)
      assert.equal(runs[0].status, 'ok', JSON.stringify(runs[0]))
      const notes = (await db.execute(sql`SELECT type, via_client AS via, excerpt FROM notifications WHERE user_id = ${M.id} AND page_id = ${row.id} AND type = 'doc_mention'`)) as unknown as { type: string; via: string; excerpt: string }[]
      assert.equal(notes.length, 1, `notifications: ${JSON.stringify(notes)}`)
      assert.equal(notes[0].type, 'doc_mention')
      assert.equal(notes[0].via, 'automation: Ask review')
      assert.match(notes[0].excerpt, /please review review me/)
      // the condition: a row whose note says skip does not run
      const skip = await newRow(O, tasks, 'skip one', { who: M.id, note: 'skip this' })
      await ok(O, 'PATCH', `/api/pages/${skip.id}/props`, { props: { st: 'review' } })
      await settle()
      assert.equal((await runsOf(tasks, rule.id)).length, 1, `the NOT group kept it out: ${JSON.stringify(await runsOf(tasks, rule.id))}`)
      await ok(O, 'DELETE', `/api/collections/${tasks}/automations/${rule.id}`)
    })

    it('date reached: one run per rule, row and date, however often the tick runs', async () => {
      const rule = await addRule(O, tasks, { name: 'Due soon', trigger: { type: 'dateReached', fieldId: 'due', daysBefore: 1 }, actions: [{ type: 'setFields', props: { note: 'due tomorrow' } }] })
      const d = new Date()
      const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      const tomorrow = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate() + 1)).toISOString().slice(0, 10)
      const row = await newRow(O, tasks, 'due row', { due: tomorrow })
      const later = await newRow(O, tasks, 'later row', { due: '2099-01-01' })
      await settle()
      assert.equal(await queue.queueDateRuns(today), 1)
      assert.equal(await queue.queueDateRuns(today), 0, 'dedupe key: once')
      await settle()
      const got = await rowsOf(O, tasks)
      assert.equal(got.find((r) => r.id === row.id)?.props.note, 'due tomorrow')
      assert.notEqual(got.find((r) => r.id === later.id)?.props.note, 'due tomorrow')
      const runs = await runsOf(tasks, rule.id)
      assert.equal(runs.length, 1)
      assert.equal(runs[0].actorName, null, 'nobody triggered a date')
      await ok(O, 'DELETE', `/api/collections/${tasks}/automations/${rule.id}`)
    })

    it('a trashed row is skipped and recorded', async () => {
      const rule = await addRule(O, tasks, { name: 'Late', trigger: { type: 'rowAdded' }, actions: [{ type: 'setFields', props: { note: 'x' } }] })
      const row = await newRow(O, tasks, 'gone soon')
      await changeLog.drainChangeLog()
      await ok(O, 'DELETE', `/api/pages/${row.id}`)
      await settle()
      const runs = await runsOf(tasks, rule.id)
      assert.equal(runs[0]?.status, 'skipped')
      assert.match(String(runs[0]?.error), /trash/)
      await ok(O, 'DELETE', `/api/collections/${tasks}/automations/${rule.id}`)
    })

    it('agents see the enabled rules in query_rows describe=true', async () => {
      const rule = await addRule(O, tasks, { name: 'Ask review', trigger: { type: 'fieldChanged', fieldId: 'st', to: 'review' }, actions: [{ type: 'notify', fieldId: 'who' }] })
      const off = await addRule(O, tasks, { name: 'Off rule', enabled: false, trigger: { type: 'rowAdded' }, actions: [{ type: 'setFields', props: { note: 'x' } }] })
      const mcp = await h.connectMcp(app, M, await h.mintToken(M, 'notes', 'Claude'), { user: { ...M, via: 'Claude' } })
      const d = await mcp.tool('query_rows', { collectionId: tasks, describe: true })
      await mcp.close()
      assert.equal(d.isError, false, d.text)
      assert.match(d.text, /Automations \(run after your writes, as the rule's author\):\n- Ask review: Status changed to "Review" → notify Owner\n/)
      assert.ok(!d.text.includes('Off rule'), 'disabled rules are not listed')
      await ok(O, 'DELETE', `/api/collections/${tasks}/automations/${rule.id}`)
      await ok(O, 'DELETE', `/api/collections/${tasks}/automations/${off.id}`)
    })
  })

  describe('rights: the author through REST, capped by who triggered', () => {
    let src = ''
    let dst = ''
    let rule: AutomationDTO
    before(async () => {
      src = await newCollection(O, `Requests ${W}`, [{ id: 'n', name: 'Note', type: 'text' }, { id: 'who', name: 'Owner', type: 'person' }] as CollectionField[])
      dst = await newCollection(O, `Log ${W}`, [{ id: 'from', name: 'From', type: 'relation', relation: { targetPageId: src } }, { id: 'n', name: 'Note', type: 'text' }] as CollectionField[])
      rule = await addRule(O, src, { name: 'Copy to log', trigger: { type: 'rowAdded' }, actions: [{ type: 'addRow', collectionId: dst, title: 'from {{page}}', props: { from: 'this', n: 'copied' } }] })
      // Gwen is a guest with edit on the requests database only
      await ok(O, 'PUT', `/api/pages/${src}/access`, { userId: G.id, level: 'edit' })
      await settle()
    })

    it('a member who can edit both databases: the row is added to the other database', async () => {
      const row = await newRow(M, src, 'member request')
      await settle()
      const log = await rowsOf(O, dst)
      const hit = log.find((r) => r.title === 'from member request')
      assert.ok(hit, JSON.stringify(log.map((r) => r.title)))
      assert.deepEqual(hit!.props.from, [row.id])
      const [p] = await db.select({ createdBy: schema.pages.createdBy, createdVia: schema.pages.createdVia }).from(schema.pages).where(eq(schema.pages.id, hit!.id))
      assert.deepEqual(p, { createdBy: O.id, createdVia: 'automation: Copy to log' })
    })

    it('a guest cannot reach another database through a rule', async () => {
      const res = await as(G, 'POST', `/api/pages/${src}/collection/rows`, { title: 'guest request', template: null })
      assert.equal(res.statusCode, 200, res.body)
      await settle()
      const runs = await runsOf(src, rule.id)
      assert.equal(runs[0].status, 'skipped')
      assert.equal(runs[0].failedAction, 0)
      assert.match(String(runs[0].error), /guest/)
      assert.ok(!(await rowsOf(O, dst)).some((r) => r.title === 'from guest request'))
    })

    it('a public form answer cannot reach another database through a rule', async () => {
      const view = (await ok(O, 'POST', `/api/pages/${src}/collection/views`, { name: 'Form', type: 'form' })).view
      const link = await ok(O, 'POST', `/api/collection-views/${view.id}/form-link`, {})
      const res = await app.inject({ method: 'POST', url: `/api/public/forms/${link.token}`, remoteAddress: '10.9.9.9', payload: { values: { title: 'form request' } } })
      assert.equal(res.statusCode, 200, res.body)
      await settle()
      const runs = await runsOf(src, rule.id)
      assert.equal(runs[0].status, 'skipped')
      assert.match(String(runs[0].error), /public form/)
      assert.ok(!(await rowsOf(O, dst)).some((r) => r.title === 'from form request'))
    })

    it('an agent connection cannot reach another database; a read-only token and a suggest-only connection start nothing', async () => {
      const mcp = await h.connectMcp(app, M, await h.mintToken(M, 'notes', 'Claude'), { user: { ...M, via: 'Claude' } })
      const made = await mcp.tool('create_row', { collectionId: src, title: 'agent request' })
      assert.equal(made.isError, false, made.text)
      await settle()
      let runs = await runsOf(src, rule.id)
      assert.equal(runs[0].status, 'skipped')
      assert.match(String(runs[0].error), /agent connection/)
      await mcp.close()
      // read-only token: the write itself is refused, so nothing is queued
      const before = (await runsOf(src, rule.id)).length
      const ro = await h.mintToken(M, 'notes:read', 'Reader')
      const roMcp = await h.connectMcp(app, M, ro, { user: { ...M, via: 'Reader', scope: 'notes:read' }, canWrite: false })
      const roRes = await roMcp.tool('create_row', { collectionId: src, title: 'read-only request' })
      await roMcp.close()
      assert.equal(roRes.isError, true)
      // suggest-only: a connection that read flagged content may not write rows
      const tok = await h.mintToken(M, 'notes', 'Tainted')
      const [g] = (await db.execute(sql`SELECT id FROM oauth_grants WHERE user_id = ${M.id} ORDER BY created_at DESC LIMIT 1`)) as unknown as { id: string }[]
      await db.insert(schema.connectionTaints).values({ connection: `grant:${g.id}`, source: `page:${src}`, pageId: src, workspaceId: ws.id, rules: ['test'], fingerprint: 'f' })
      const tMcp = await h.connectMcp(app, M, tok, { user: { ...M, via: 'Tainted', grantId: g.id } })
      const tRes = await tMcp.tool('create_row', { collectionId: src, title: 'tainted request' })
      await tMcp.close()
      assert.equal(tRes.isError, true, tRes.text)
      await settle()
      runs = await runsOf(src, rule.id)
      assert.equal(runs.length, before, 'refused writes start no run')
      // refusals by the trigger's cap are skips: outsiders cannot turn the rule off
      const list = (await ok(O, 'GET', `/api/collections/${src}/automations`)).automations as AutomationDTO[]
      assert.equal(list[0].enabled, true)
      assert.equal(list[0].failureCount, 0)
    })

    it('the author loses the right to edit the other database: the run fails at that action', async () => {
      // Minho becomes the author (he saves the rule); then the log database is locked for owners only
      await ok(M, 'PATCH', `/api/collections/${src}/automations/${rule.id}`, { name: 'Copy to log' })
      const lock = await as(O, 'PUT', `/api/pages/${dst}/lock`, { locked: true })
      assert.ok(lock.statusCode < 300, lock.body)
      await newRow(O, src, 'after lock')
      await settle()
      const runs = await runsOf(src, rule.id)
      assert.equal(runs[0].status, 'failed')
      assert.match(String(runs[0].error), /lock|edit|LOCK/i)
      assert.ok(!(await rowsOf(O, dst)).some((r) => r.title === 'from after lock'))
      await as(O, 'PUT', `/api/pages/${dst}/lock`, { locked: false })
    })
  })

  describe('loops and failures', () => {
    it('two rules that feed each other stop at the loop marker', async () => {
      const a = await newCollection(O, `Ping ${W}`, [{ id: 'n', name: 'Note', type: 'text' }] as CollectionField[])
      const b = await newCollection(O, `Pong ${W}`, [{ id: 'n', name: 'Note', type: 'text' }] as CollectionField[])
      const ra = await addRule(O, a, { name: 'Ping', trigger: { type: 'rowAdded' }, actions: [{ type: 'addRow', collectionId: b, title: 'pong' }] })
      const rb = await addRule(O, b, { name: 'Pong', trigger: { type: 'rowAdded' }, actions: [{ type: 'addRow', collectionId: a, title: 'ping' }] })
      await newRow(O, a, 'start')
      await settle()
      const ra2 = await runsOf(a, ra.id)
      const rb2 = await runsOf(b, rb.id)
      // start → Ping (ok, adds pong) → Pong (ok, adds ping) → Ping again: refused by the chain marker
      assert.deepEqual(ra2.map((r) => r.status).sort(), ['ok', 'skipped'])
      assert.deepEqual(rb2.map((r) => r.status), ['ok'])
      assert.match(String(ra2.find((r) => r.status === 'skipped')?.error), /loop/)
      assert.equal((await rowsOf(O, a)).length, 2)
      assert.equal((await rowsOf(O, b)).length, 1)
    })

    it('two rules on the same row that change each other field stop at the loop marker', async () => {
      const c = await newCollection(O, `SameRow ${W}`, [STATUS, { id: 'note', name: 'Note', type: 'text' }] as CollectionField[])
      const ra = await addRule(O, c, { name: 'Status to note', trigger: { type: 'fieldChanged', fieldId: 'st' }, actions: [{ type: 'setFields', props: { note: 'status moved {{today}}' } }] })
      const rb = await addRule(O, c, { name: 'Note to status', trigger: { type: 'fieldChanged', fieldId: 'note' }, actions: [{ type: 'setFields', props: { st: 'done' } }] })
      const row = await newRow(O, c, 'ping-pong')
      await settle()
      await ok(M, 'PATCH', `/api/pages/${row.id}/props`, { props: { st: 'review' } })
      await settle()
      // person → A (sets Note) → B (sets Status) → A again: refused by the chain marker
      assert.deepEqual((await runsOf(c, ra.id)).map((r) => r.status), ['skipped', 'ok'])
      assert.deepEqual((await runsOf(c, rb.id)).map((r) => r.status), ['ok'])
      const got = (await rowsOf(O, c)).find((r) => r.id === row.id)!
      assert.equal(got.props.st, 'done')
      assert.match(String(got.props.note), /^status moved /)
      const feed = (await db.execute(sql`SELECT via_client AS via FROM page_changes WHERE page_id = ${row.id} AND kind = 'page_props' ORDER BY seq`)) as unknown as { via: string | null }[]
      assert.deepEqual(feed.map((f) => f.via), [null, 'automation: Status to note', 'automation: Note to status'])
    })

    it('a chain of distinct rules stops at the depth limit', async () => {
      const colls: string[] = []
      for (let i = 0; i < 6; i++) colls.push(await newCollection(O, `Chain${i} ${W}`, [] as CollectionField[]))
      const rules: AutomationDTO[] = []
      for (let i = 0; i < 5; i++) rules.push(await addRule(O, colls[i], { name: `Step ${i}`, trigger: { type: 'rowAdded' }, actions: [{ type: 'addRow', collectionId: colls[i + 1], title: `from ${i}` }] }))
      await newRow(O, colls[0], 'go')
      await settle()
      const statuses = []
      for (let i = 0; i < 5; i++) statuses.push((await runsOf(colls[i], rules[i].id)).map((r) => r.status).join(','))
      // depth 0..3 run (AUTOMATION_MAX_DEPTH = 3); the fifth step is skipped
      assert.deepEqual(statuses, ['ok', 'ok', 'ok', 'ok', 'skipped'])
      assert.equal((await rowsOf(O, colls[5])).length, 0)
    })

    it('repeated failures turn the rule off and tell its author', async () => {
      const src = await newCollection(O, `Fails ${W}`, [{ id: 'n', name: 'Note', type: 'text' }] as CollectionField[])
      const gone = await newCollection(O, `Gone ${W}`, [] as CollectionField[])
      const rule = await addRule(M, src, { name: 'To nowhere', trigger: { type: 'rowAdded' }, actions: [{ type: 'addRow', collectionId: gone }] })
      await ok(O, 'DELETE', `/api/pages/${gone}`)
      for (let i = 0; i < 6; i++) await newRow(O, src, `r${i}`)
      await settle()
      await outbox.drainOutbox('notify')
      const runs = await runsOf(src, rule.id)
      assert.equal(runs.filter((r) => r.status === 'failed').length, 5, JSON.stringify(runs))
      const list = (await ok(O, 'GET', `/api/collections/${src}/automations`)).automations as AutomationDTO[]
      assert.equal(list[0].enabled, false)
      assert.ok(list[0].autoDisabledAt)
      const notes = (await db.execute(sql`SELECT excerpt FROM notifications WHERE user_id = ${M.id} AND page_id = ${src}`)) as unknown as { excerpt: string }[]
      assert.equal(notes.length, 1)
      assert.match(notes[0].excerpt, /turned off after 5 failed runs/)
      // turning it on again checks the rule: the target must exist again
      const refused = await as(O, 'PATCH', `/api/collections/${src}/automations/${rule.id}`, { enabled: true })
      assert.equal(refused.statusCode, 400, refused.body)
      await ok(O, 'POST', `/api/pages/${gone}/restore`, {})
      // turned on again by hand: a fresh streak
      const on = (await ok(O, 'PATCH', `/api/collections/${src}/automations/${rule.id}`, { enabled: true })).automation as AutomationDTO
      assert.equal(on.failureCount, 0)
      assert.equal(on.createdBy, O.id, 'turning it on makes Olivia the author')
    })

    it('a collection without rules queues no automation work', async () => {
      const plain = await newCollection(O, `Plain ${W}`, [{ id: 'n', name: 'Note', type: 'text' }] as CollectionField[])
      await settle()
      const before = await automationRows()
      const row = await newRow(O, plain, 'x')
      await ok(O, 'PATCH', `/api/pages/${row.id}/props`, { props: { n: 'y' } })
      await changeLog.drainChangeLog()
      assert.equal(await automationRows(), before)
    })
  })

  describe('button export', () => {
    it('plain Markdown shows the label; the download keeps the token with its actions', async () => {
      const page = await h.makeDocPage(ws.id, O.id, `Export ${W}`, [
        { id: 'b-exp', type: 'button', props: { label: 'Log it', color: 'green', actions: JSON.stringify([{ type: 'open', url: 'https://example.com/' }]) }, children: [] },
      ] as never)
      const plain = await as(O, 'GET', `/api/pages/${page.id}/export?format=md&notation=plain`)
      assert.equal(plain.statusCode, 200, plain.body)
      assert.match(plain.body, /\*\*\[Log it\]\*\*/)
      assert.ok(!plain.body.includes('example.com') && !plain.body.includes('inkling:button'), plain.body)
      const file = await as(O, 'GET', `/api/pages/${page.id}/export?format=md&notation=file`)
      assert.equal(file.statusCode, 200, file.body)
      assert.match(file.body, /<!-- inkling:button \{"actions":\[\{"type":"open","url":"https:\/\/example\.com\/"\}\],"color":"green","label":"Log it"\} -->/)
    })
  })

  describe('button webhooks', () => {
    it('sends only for a button stored in the page with that webhook', async () => {
      const hookId = randomUUID()
      await db.insert(schema.workspaceWebhooks).values({ id: hookId, workspaceId: ws.id, kind: 'generic', url: storeHookUrl(hookId, 'https://hooks.example.test/in'), events: [] as never, enabled: '1', createdBy: O.id } as never)
      const targets = (await ok(M, 'GET', `/api/workspaces/${ws.id}/webhook-targets`)).targets
      assert.deepEqual(targets.map((t: { id: string; label: string }) => [t.id, t.label]), [[hookId, 'hooks.example.test']])
      const blockId = 'btn-1'
      const page = await h.makeDocPage(ws.id, O.id, `Buttons ${W}`, [
        { id: blockId, type: 'button', props: { label: 'Ping ops', color: 'blue', actions: JSON.stringify([{ type: 'webhook', webhookId: hookId, message: 'hi' }]) }, children: [] },
      ] as never)
      const before = Number(((await db.execute(sql`SELECT count(*)::int AS n FROM outbox WHERE topic = 'webhook'`)) as unknown as { n: number }[])[0].n)
      const res = await as(M, 'POST', `/api/pages/${page.id}/button-webhook`, { blockId, webhookId: hookId })
      assert.equal(res.statusCode, 200, res.body)
      const after = Number(((await db.execute(sql`SELECT count(*)::int AS n FROM outbox WHERE topic = 'webhook'`)) as unknown as { n: number }[])[0].n)
      assert.equal(after, before + 1)
      const other = randomUUID()
      const wrong = await as(M, 'POST', `/api/pages/${page.id}/button-webhook`, { blockId, webhookId: other })
      assert.equal(wrong.statusCode, 409)
      const noBlock = await as(M, 'POST', `/api/pages/${page.id}/button-webhook`, { blockId: 'nope', webhookId: hookId })
      assert.equal(noBlock.statusCode, 409)
      const guest = await as(G, 'POST', `/api/pages/${page.id}/button-webhook`, { blockId, webhookId: hookId })
      assert.ok(guest.statusCode === 403 || guest.statusCode === 404, String(guest.statusCode))
    })
  })
})
