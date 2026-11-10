// Form views (docs/adr/1820-1822): the public link (owners/admins publish, editors turn off), what a
// visitor can read (the questions, nothing else), what a visitor can write (only the asked
// properties, through createRow: change feed, catch_up), honeypot, size and rate limits, and every
// way a link closes. MCP create_view with form settings.
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.APP_URL ||= 'https://notes.example.com'
process.env.APP_SECRET_KEY ||= 'test-app-secret-key-0123456789-abcdefghij'

import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'
import type { CollectionViewDTO, FormLinkDTO, PublicFormDTO, RowDTO } from '@inkling/shared'

const HAS_DB = !!process.env.DATABASE_URL

describe('[db] form views and public forms', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const h = await import('./mcpTools/testHarness')
  const { closeDb, db } = await import('./db/index')
  const schema = await import('./db/schema')
  const { and, eq, isNull } = await import('drizzle-orm')
  const { drainChangeLog } = await import('./context/changeLog')
  const forms = await import('./routes/forms')
  const app = await h.buildTestApp()

  const alice = await h.makeUser('alice') // owner
  const bob = await h.makeUser('bob') // member
  const carol = await h.makeUser('carol') // member
  const ws = await h.makeWorkspace(alice, [bob, carol])
  const tokenA = await h.mintToken(alice, 'notes', 'Form Agent')
  const A = await h.connectMcp(app, alice, tokenA, { user: { ...alice, via: 'Form Agent' } })
  const tokenB = await h.mintToken(bob, 'notes', 'Bob Agent')
  const B = await h.connectMcp(app, bob, tokenB, { user: { ...bob, via: 'Bob Agent' } })
  after(async () => {
    await A.close()
    await B.close()
    await app.close()
    await closeDb()
  })

  type U = { cookie: string }
  const as = (u: U, method: string, url: string, payload?: unknown) =>
    app.inject({
      method: method as 'GET',
      url: `/api${url}`,
      headers: { cookie: u.cookie, ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) },
      payload: payload === undefined ? undefined : JSON.stringify(payload),
    })
  let ipSeq = 1
  /** each anonymous call from its own address unless one is given (the per-IP limit is tested on its own) */
  const visitor = (method: 'GET' | 'POST', token: string, payload?: unknown, ip = `10.0.${Math.floor(ipSeq / 250)}.${(ipSeq++ % 250) + 1}`) =>
    app.inject({
      method,
      url: `/api/public/forms/${token}`,
      remoteAddress: ip,
      headers: payload !== undefined ? { 'content-type': 'application/json' } : {},
      payload: payload === undefined ? undefined : typeof payload === 'string' ? payload : JSON.stringify(payload),
    })

  // A collection with a property the form does not ask for (Secret) and existing rows a visitor must never see.
  const mk = await as(alice, 'POST', '/pages', { workspaceId: ws.id, kind: 'collection', title: 'Signups' })
  assert.equal(mk.statusCode, 200, mk.body)
  const coll = mk.json().page.id as string
  const fields = [
    { id: 'em', name: 'Email', type: 'text' },
    { id: 'pl', name: 'Plan', type: 'select', options: [{ id: 'free', name: 'Free', color: 'gray' }, { id: 'pro', name: 'Pro', color: 'blue' }] },
    { id: 'ag', name: 'Age', type: 'number' },
    { id: 'ok', name: 'Agree', type: 'checkbox' },
    { id: 'ow', name: 'Owner', type: 'person' },
    { id: 'se', name: 'Secret', type: 'text' },
    { id: 'tw', name: 'Twice', type: 'formula', formula: { expression: 'prop("Age") * 2' } },
  ]
  const put = await as(alice, 'PUT', `/pages/${coll}/collection/fields`, { fields })
  assert.equal(put.statusCode, 200, put.body)
  await db.insert(schema.pages).values([
    { workspaceId: ws.id, parentId: coll, title: 'Existing VIP customer', createdBy: alice.id, kind: 'doc', props: { se: 'launch code 4242', em: 'vip@corp.test' }, sortOrder: 1 },
  ])

  const formConfig = {
    form: {
      title: 'Beta signup',
      description: 'Tell us about you',
      fields: [
        { fieldId: 'title', required: true, description: 'Your name' },
        { fieldId: 'em', required: true },
        { fieldId: 'pl' },
        { fieldId: 'ag' },
        { fieldId: 'ok', required: true },
        { fieldId: 'ow' }, // person: members only, never in the public form
      ],
      successMessage: 'See you soon',
    },
  }
  const v = await as(alice, 'POST', `/pages/${coll}/collection/views`, { name: 'Signup form', type: 'form', config: formConfig })
  assert.equal(v.statusCode, 200, v.body)
  const view = v.json().view as CollectionViewDTO
  const tableView = (await as(alice, 'GET', `/pages/${coll}/collection?rows=0`)).json().collection.views.find((x: CollectionViewDTO) => x.type === 'table') as CollectionViewDTO

  const liveRows = async () =>
    db
      .select({ id: schema.pages.id, title: schema.pages.title, props: schema.pages.props, createdBy: schema.pages.createdBy, createdVia: schema.pages.createdVia })
      .from(schema.pages)
      .where(and(eq(schema.pages.parentId, coll), isNull(schema.pages.deletedAt)))

  const cursorOf = (t: string) => {
    const m = /(?:next |fresh )?cursor: (\S+)$/m.exec(t)
    assert.ok(m, `no cursor in:\n${t}`)
    return m[1]
  }
  const c0 = cursorOf((await B.tool('changes_since', { workspaceId: ws.id })).text)

  let token = ''
  const good = { values: { title: 'Dana', em: 'dana@example.test', pl: 'Pro', ag: '31', ok: true } }

  it('only owners and admins turn the link on; members see its status', async () => {
    const byBob = await as(bob, 'POST', `/collection-views/${view.id}/form-link`, {})
    assert.equal(byBob.statusCode, 403, byBob.body)
    const notForm = await as(alice, 'POST', `/collection-views/${tableView.id}/form-link`, {})
    assert.equal(notForm.statusCode, 400, notForm.body)
    const on = await as(alice, 'POST', `/collection-views/${view.id}/form-link`, {})
    assert.equal(on.statusCode, 200, on.body)
    const link = on.json() as FormLinkDTO
    assert.equal(link.shared, true)
    token = link.token!
    assert.match(token, /^[A-Za-z0-9_-]{22}$/)
    // idempotent: the same link again
    assert.equal((await as(alice, 'POST', `/collection-views/${view.id}/form-link`, {})).json().token, token)
    const seen = (await as(bob, 'GET', `/collection-views/${view.id}/form-link`)).json() as FormLinkDTO
    assert.deepEqual(seen, { shared: true, token, canPublish: false })
    // stored as a hash, never the token itself
    const [row] = await db.select().from(schema.collectionFormLinks).where(eq(schema.collectionFormLinks.viewId, view.id))
    assert.notEqual(row.tokenHash, token)
    assert.ok(!row.tokenEnc?.includes(token))
    const audit = await db.select({ action: schema.workspaceAuditEvents.action }).from(schema.workspaceAuditEvents).where(eq(schema.workspaceAuditEvents.workspaceId, ws.id))
    assert.ok(audit.some((a) => a.action === 'form.published'))
  })

  it('a visitor reads the questions only: no rows, no other properties, no person, no ids', async () => {
    const res = await visitor('GET', token)
    assert.equal(res.statusCode, 200, res.body)
    assert.equal(res.headers['cache-control'], 'no-store')
    const dto = res.json() as PublicFormDTO
    assert.equal(dto.title, 'Beta signup')
    assert.deepEqual(dto.fields.map((f) => f.key), ['title', 'em', 'pl', 'ag', 'ok'])
    assert.deepEqual(dto.fields.find((f) => f.key === 'pl')?.options?.map((o) => o.name), ['Free', 'Pro'])
    const body = res.body
    for (const leak of ['Existing VIP customer', 'launch code', 'vip@corp.test', 'Secret', 'Owner', 'Twice', ws.id, coll, view.id, alice.id, alice.name, 'Signups'])
      assert.ok(!body.includes(leak), `public form leaks ${leak}`)
    assert.deepEqual(Object.keys(dto).sort(), ['description', 'fields', 'honeypot', 'submitLabel', 'successMessage', 'title'])
  })

  it('a valid answer becomes one row through createRow; the answer is { ok: true } and nothing else', async () => {
    const before = (await liveRows()).length
    const res = await visitor('POST', token, {
      values: { ...good.values, se: 'overwrite attempt', ow: bob.id, tw: 999, unknown: 'x', nested: { a: 1 } },
    })
    assert.equal(res.statusCode, 200, res.body)
    assert.deepEqual(res.json(), { ok: true })
    const rows = await liveRows()
    assert.equal(rows.length, before + 1)
    const made = rows.find((r) => r.title === 'Dana')!
    assert.deepEqual(made.props, { em: 'dana@example.test', pl: 'pro', ag: 31, ok: true })
    // made as the publisher, labelled as a public form answer
    assert.equal(made.createdBy, alice.id)
    assert.equal(made.createdVia, forms.PUBLIC_FORM_VIA)
    // members see the formula computed on it
    const full = (await as(bob, 'GET', `/pages/${coll}/collection`)).json() as { rows: RowDTO[] }
    assert.equal(full.rows.find((r) => r.id === made.id)?.props.tw, 62)
  })

  it('the row is in the change feed and catch_up, attributed "via public form"', async () => {
    await drainChangeLog()
    const [c] = await db
      .select({ via: schema.pageChanges.viaClient, actor: schema.pageChanges.actorId, kind: schema.pageChanges.kind })
      .from(schema.pageChanges)
      .innerJoin(schema.pages, eq(schema.pages.id, schema.pageChanges.pageId))
      .where(and(eq(schema.pages.parentId, coll), eq(schema.pages.title, 'Dana')))
    assert.ok(c, 'no change logged for the form row')
    assert.equal(c.via, forms.PUBLIC_FORM_VIA)
    assert.equal(c.actor, alice.id)
    const feed = await B.tool('changes_since', { workspaceId: ws.id, cursor: c0 })
    assert.equal(feed.isError, false, feed.text)
    assert.match(feed.text, /row added: "Dana"/, feed.text)
    const cu = await B.tool('catch_up', { workspaceId: ws.id, since: c0, peek: true })
    assert.equal(cu.isError, false, cu.text)
    assert.match(cu.text, /row added "Dana"/, cu.text)
    assert.match(cu.text, /via public form/, cu.text)
  })

  it('missing required and invalid answers are refused with the problem per question, and nothing is written', async () => {
    const before = (await liveRows()).length
    const r1 = await visitor('POST', token, { values: { title: 'No email', ok: true } })
    assert.equal(r1.statusCode, 400, r1.body)
    assert.equal(r1.json().error.code, 'FORM_INVALID')
    assert.deepEqual(r1.json().error.fields, { em: 'required' })
    const r2 = await visitor('POST', token, { values: { ...good.values, pl: 'Enterprise', ag: 'old', ok: 'maybe' } })
    assert.equal(r2.statusCode, 400, r2.body)
    assert.deepEqual(r2.json().error.fields, { pl: 'invalid', ag: 'invalid', ok: 'invalid' })
    const r3 = await visitor('POST', token, { values: good.values, extra: 1 })
    assert.equal(r3.statusCode, 400, r3.body)
    const r4 = await visitor('POST', token, 'not json')
    assert.equal(r4.statusCode, 400, r4.body)
    assert.equal((await liveRows()).length, before)
  })

  it('a filled honeypot gets the success answer and writes nothing', async () => {
    const before = (await liveRows()).length
    const res = await visitor('POST', token, { ...good, website: 'http://spam.example' })
    assert.equal(res.statusCode, 200, res.body)
    assert.deepEqual(res.json(), { ok: true })
    assert.equal((await liveRows()).length, before)
  })

  it('a body over 32 KiB is refused before anything is read', async () => {
    const before = (await liveRows()).length
    const res = await visitor('POST', token, { values: { ...good.values, em: 'x'.repeat(40 * 1024) } })
    assert.equal(res.statusCode, 413, res.body)
    // under the body cap but over the text cap of one answer
    const long = await visitor('POST', token, { values: { ...good.values, em: 'y'.repeat(6000) } })
    assert.equal(long.statusCode, 400, long.body)
    assert.equal((await liveRows()).length, before)
  })

  it('members fill the same form in the app (POST rows) and person answers are members only', async () => {
    const r = await as(carol, 'POST', `/pages/${coll}/collection/rows`, { template: null, title: 'Carol answer', props: { em: 'c@t.t', ow: bob.id } })
    assert.equal(r.statusCode, 200, r.body)
    const bad = await as(carol, 'POST', `/pages/${coll}/collection/rows`, { template: null, title: 'x', props: { ow: '00000000-0000-4000-8000-000000000009' } })
    assert.equal(bad.statusCode, 400, bad.body)
  })

  it('MCP create_view makes a form from property names and refuses properties a form cannot ask', async () => {
    const r = await A.tool('create_view', {
      collectionId: coll,
      type: 'form',
      name: 'Short form',
      form: { fields: [{ property: 'title', required: true }, { property: 'email', description: 'work address' }, { property: 'Plan' }] },
    })
    assert.equal(r.isError, false, r.text)
    assert.match(r.text, /asks: Title\*, Email, Plan/)
    const id = /id ([0-9a-f-]{36})/.exec(r.text)![1]
    const [row] = await db.select({ config: schema.collectionViews.config, type: schema.collectionViews.type }).from(schema.collectionViews).where(eq(schema.collectionViews.id, id))
    assert.equal(row.type, 'form')
    assert.deepEqual((row.config as { form: { fields: unknown[] } }).form.fields, [
      { fieldId: 'title', required: true },
      { fieldId: 'em', description: 'work address' },
      { fieldId: 'pl' },
    ])
    const bad = await A.tool('create_view', { collectionId: coll, type: 'form', name: 'Bad', form: { fields: [{ property: 'Twice' }] } })
    assert.equal(bad.isError, true)
    assert.match(bad.text, /formula property/)
    const def = await A.tool('create_view', { collectionId: coll, type: 'form', name: 'Default form' })
    assert.equal(def.isError, false, def.text)
    assert.match(def.text, /asks: Title\*, Email, Plan, Age, Agree, Secret/)
  })

  it('turning the link off closes it at once; a new link is a new token', async () => {
    const off = await as(bob, 'DELETE', `/collection-views/${view.id}/form-link`)
    assert.equal(off.statusCode, 200, off.body)
    assert.equal((await visitor('GET', token)).statusCode, 404)
    assert.equal((await visitor('POST', token, good)).statusCode, 404)
    const on = await as(alice, 'POST', `/collection-views/${view.id}/form-link`, {})
    const fresh = (on.json() as FormLinkDTO).token!
    assert.notEqual(fresh, token)
    assert.equal((await visitor('GET', token)).statusCode, 404)
    assert.equal((await visitor('GET', fresh)).statusCode, 200)
    token = fresh
  })

  it('closes with the same 404 when sharing is off in the workspace, the publisher leaves, the collection goes private or to the trash, or the view is deleted', async () => {
    const open = async () => (await visitor('GET', token)).statusCode
    assert.equal(await open(), 200)
    await db.update(schema.workspaces).set({ publicSharingDisabled: true }).where(eq(schema.workspaces.id, ws.id))
    assert.equal(await open(), 404)
    assert.equal((await visitor('POST', token, good)).statusCode, 404)
    await db.update(schema.workspaces).set({ publicSharingDisabled: false }).where(eq(schema.workspaces.id, ws.id))
    assert.equal(await open(), 200)
    // the collection is locked and the publisher can no longer edit it: answers are refused, nothing written
    const lock = await as(alice, 'PUT', `/pages/${coll}/lock`, { locked: true })
    assert.equal(lock.statusCode, 200, lock.body)
    const { bumpAcl } = await import('./aclVersion')
    await db.update(schema.workspaceMembers).set({ role: 'owner' }).where(and(eq(schema.workspaceMembers.workspaceId, ws.id), eq(schema.workspaceMembers.userId, carol.id)))
    await db.transaction(async (tx) => {
      await bumpAcl(tx, ws.id)
      await tx.update(schema.pages).set({ ownerId: carol.id }).where(eq(schema.pages.id, coll))
      await tx.update(schema.workspaceMembers).set({ role: 'member' }).where(and(eq(schema.workspaceMembers.workspaceId, ws.id), eq(schema.workspaceMembers.userId, alice.id)))
    })
    const before = (await liveRows()).length
    const locked = await visitor('POST', token, good)
    assert.equal(locked.statusCode, 404, locked.body)
    assert.equal((await liveRows()).length, before)
    const unlock = await as(carol, 'PUT', `/pages/${coll}/lock`, { locked: false })
    assert.equal(unlock.statusCode, 200, unlock.body)
    assert.equal((await visitor('POST', token, { values: { ...good.values, title: 'After unlock' } })).statusCode, 200)
    // the publisher leaves the workspace
    await db.delete(schema.workspaceMembers).where(and(eq(schema.workspaceMembers.workspaceId, ws.id), eq(schema.workspaceMembers.userId, alice.id)))
    assert.equal(await open(), 404)
    await db.insert(schema.workspaceMembers).values({ workspaceId: ws.id, userId: alice.id, role: 'owner' })
    assert.equal(await open(), 200)
    // private collection
    await db.update(schema.pages).set({ scope: 'private' }).where(eq(schema.pages.id, coll))
    assert.equal(await open(), 404)
    await db.update(schema.pages).set({ scope: 'shared' }).where(eq(schema.pages.id, coll))
    // trash
    await db.update(schema.pages).set({ deletedAt: new Date() }).where(eq(schema.pages.id, coll))
    assert.equal(await open(), 404)
    await db.update(schema.pages).set({ deletedAt: null }).where(eq(schema.pages.id, coll))
    assert.equal(await open(), 200)
    // a guessed token is the same 404
    assert.equal((await visitor('GET', 'AAAAAAAAAAAAAAAAAAAAAA')).statusCode, 404)
  })

  it('the per-form hourly cap counts answers from any address', () => {
    forms.resetFormSlots()
    const t0 = Date.now()
    for (let i = 0; i < forms.FORM_SUBMIT_PER_FORM_HOUR; i++) assert.equal(forms.takeFormSlot('v1', t0 + i), true)
    assert.equal(forms.takeFormSlot('v1', t0 + 10_000), false)
    assert.equal(forms.takeFormSlot('v2', t0 + 10_000), true, 'other forms are not affected')
    assert.equal(forms.takeFormSlot('v1', t0 + 3_600_001), true, 'the window moves on')
    forms.resetFormSlots()
  })

  it('one address gets 429 after the per-minute limit of answers (rate-limit plugin as in index.ts)', async () => {
    // the shared test app has no rate limiter: build one with the production plugin options
    const Fastify = (await import('fastify')).default
    const { AppError } = await import('./errors')
    const { rateLimitKey } = await import('./rateLimitKey')
    const rl = Fastify()
    await rl.register(import('@fastify/cookie'))
    await rl.register(import('@fastify/rate-limit'), {
      global: true,
      max: 300,
      timeWindow: '1 minute',
      errorResponseBuilder: () => new AppError(429, 'RATE_LIMITED', 'Too many requests'),
      keyGenerator: rateLimitKey,
    })
    rl.setErrorHandler((err, _req, reply) => {
      if (err instanceof AppError) return reply.code(err.status).send({ error: { code: err.code, message: err.message } })
      const status = (err as { statusCode?: number }).statusCode ?? 500
      return reply.code(status).send({ error: { code: 'X', message: String(err) } })
    })
    await rl.register(async (api) => forms.registerFormRoutes(api), { prefix: '/api' })
    after(() => rl.close())
    const post = (ip: string) =>
      rl.inject({ method: 'POST', url: `/api/public/forms/${token}`, remoteAddress: ip, headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ ...good, website: 'bot' }) })
    const codes: number[] = []
    for (let i = 0; i <= forms.FORM_SUBMIT_PER_MINUTE; i++) codes.push((await post('10.200.0.7')).statusCode)
    assert.deepEqual(codes.slice(0, forms.FORM_SUBMIT_PER_MINUTE), Array(forms.FORM_SUBMIT_PER_MINUTE).fill(200))
    assert.equal(codes[forms.FORM_SUBMIT_PER_MINUTE], 429)
    // another address is not limited
    assert.equal((await post('10.200.0.8')).statusCode, 200)
  })

  it('deleting the form view removes its link', async () => {
    const del = await as(alice, 'DELETE', `/collection-views/${view.id}`)
    assert.equal(del.statusCode, 204, del.body)
    assert.equal((await visitor('GET', token)).statusCode, 404)
    assert.equal((await db.select().from(schema.collectionFormLinks).where(eq(schema.collectionFormLinks.viewId, view.id))).length, 0)
  })
})
