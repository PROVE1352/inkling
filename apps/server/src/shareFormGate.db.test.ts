// Public form links (docs/adr/1821-*) and scheduled public links (docs/adr/1844-*) side by side under
// one /api/public prefix, one guard and one workspace switch (docs/adr/1870-*): a page link that has
// not started answers 404 while a form in the same workspace takes answers; neither token opens the
// other's route; opening the page link changes nothing for the form; turning public links off in the
// workspace closes the form and refuses new page links, and turning it back on reopens the form while a
// new start on the page link holds.
// Not-started visits are not counted as token guesses even next to form traffic.
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.APP_SECRET_KEY ||= 'test-app-secret-key-0123456789-abcdefghij'
// low ban threshold: if not-started visits counted as guesses, the shared address would be banned
process.env.AUTH_GUARD_MAX_FAILURES = '4'

import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'

const HAS_DB = !!process.env.DATABASE_URL

describe('[db] public forms next to scheduled public links', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const h = await import('./mcpTools/testHarness')
  const { db, closeDb } = await import('./db/index')
  const schema = await import('./db/schema')
  const { and, eq } = await import('drizzle-orm')
  const { AppError } = await import('./errors')
  const { guardHook } = await import('./guard')
  const { ZodError } = await import('zod')
  const Fastify = (await import('fastify')).default

  const app = Fastify()
  await app.register(import('@fastify/cookie'))
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.code(err.status).send({ error: { ...(err.details ?? {}), code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.code(400).send({ error: { code: 'VALIDATION', message: err.message } })
    const sc = (err as { statusCode?: number }).statusCode
    return reply.code(sc && sc < 500 ? sc : 500).send({ error: { code: 'X', message: String(err) } })
  })
  app.addHook('onRequest', guardHook)
  await app.register(
    async (api) => {
      await (await import('./routes/workspaces')).registerWorkspaceRoutes(api)
      await (await import('./routes/pages')).registerPageRoutes(api)
      await (await import('./routes/public')).registerPublicRoutes(api)
      await (await import('./routes/collections')).registerCollectionRoutes(api)
    },
    { prefix: '/api' },
  )
  await app.ready()
  after(async () => {
    await app.close()
    await closeDb()
  })

  const as = (u: { cookie: string }, method: string, url: string, payload?: unknown) =>
    app.inject({
      method: method as 'GET',
      url: `/api${url}`,
      headers: { cookie: u.cookie, ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) },
      payload: payload === undefined ? undefined : JSON.stringify(payload),
    })
  const IP = '10.77.0.1'
  const get = (url: string) => app.inject({ method: 'GET', url, remoteAddress: IP })
  const answer = (token: string, title: string) =>
    app.inject({
      method: 'POST',
      url: `/api/public/forms/${token}`,
      remoteAddress: IP,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ values: { title } }),
    })

  const owner = await h.makeUser('owner')
  const ws = await h.makeWorkspace(owner)
  const doc = await h.makeDocPage(ws.id, owner.id, 'Embargoed launch', [{ type: 'paragraph', content: [{ type: 'text', text: 'soon', styles: {} }] }] as never)
  const inHours = (n: number) => new Date(Date.now() + n * 3_600_000).toISOString()

  const mk = await as(owner, 'POST', '/pages', { workspaceId: ws.id, kind: 'collection', title: 'RSVP' })
  assert.equal(mk.statusCode, 200, mk.body)
  const coll = mk.json().page.id as string
  const v = await as(owner, 'POST', `/pages/${coll}/collection/views`, { name: 'Form', type: 'form', config: { form: { title: 'RSVP', fields: [{ fieldId: 'title', required: true }] } } })
  assert.equal(v.statusCode, 200, v.body)
  const viewId = v.json().view.id as string

  let pageToken = ''
  let formToken = ''

  it('a not-started page link is 404 while the form in the same workspace answers; tokens do not cross', async () => {
    const shared = await as(owner, 'POST', `/pages/${doc.id}/share`, { startsAt: inHours(48) })
    assert.equal(shared.statusCode, 200, shared.body)
    pageToken = shared.json().token as string
    assert.equal(shared.json().notStarted, true)
    const on = await as(owner, 'POST', `/collection-views/${viewId}/form-link`, {})
    assert.equal(on.statusCode, 200, on.body)
    formToken = on.json().token as string

    for (let i = 0; i < 6; i++) assert.equal((await get(`/api/public/${pageToken}`)).statusCode, 404)
    assert.equal((await get(`/api/public/forms/${formToken}`)).statusCode, 200)
    assert.equal((await answer(formToken, 'Guest one')).statusCode, 200)
    // the form token is not a page link and the page token is not a form
    assert.equal((await get(`/api/public/${formToken}`)).statusCode, 404)
    assert.equal((await get(`/api/public/forms/${pageToken}`)).statusCode, 404)
    // the six not-started visits did not ban the address (the form still answers from it)
    assert.equal((await get(`/api/public/forms/${formToken}`)).statusCode, 200)
  })

  it('opening the page link now leaves the form as it was', async () => {
    const open = await as(owner, 'PATCH', `/pages/${doc.id}/share`, { startsAt: null })
    assert.equal(open.statusCode, 200, open.body)
    assert.equal((await get(`/api/public/${pageToken}`)).statusCode, 200)
    assert.equal((await get(`/api/public/forms/${formToken}`)).statusCode, 200)
    assert.equal((await answer(formToken, 'Guest two')).statusCode, 200)
    const rows = await db.select({ title: schema.pages.title }).from(schema.pages).where(and(eq(schema.pages.parentId, coll)))
    assert.deepEqual(rows.map((r) => r.title).sort(), ['Guest one', 'Guest two'])
  })

  it('public links off in the workspace: forms close at once, no new page link; back on, a new schedule holds and the form reopens', async () => {
    await db.update(schema.workspaces).set({ publicSharingDisabled: true }).where(eq(schema.workspaces.id, ws.id))
    // page links: the switch refuses new links and (as in 0.14) leaves existing ones to "unpublish existing"
    const other = await h.makeDocPage(ws.id, owner.id, 'Other', [])
    assert.equal((await as(owner, 'POST', `/pages/${other.id}/share`, { startsAt: inHours(2) })).statusCode, 403)
    assert.equal((await get(`/api/public/${pageToken}`)).statusCode, 200)
    // forms are checked at every visit
    assert.equal((await get(`/api/public/forms/${formToken}`)).statusCode, 404)
    assert.equal((await answer(formToken, 'Blocked')).statusCode, 404)
    await db.update(schema.workspaces).set({ publicSharingDisabled: false }).where(eq(schema.workspaces.id, ws.id))
    // a new start on the page link: the page closes again, the form stays open
    const later = await as(owner, 'PATCH', `/pages/${doc.id}/share`, { startsAt: inHours(24) })
    assert.equal(later.statusCode, 200, later.body)
    assert.equal((await get(`/api/public/${pageToken}`)).statusCode, 404)
    assert.equal((await get(`/api/public/forms/${formToken}`)).statusCode, 200)
    // the page's schedule does not touch the form link row
    const [link] = await db.select().from(schema.collectionFormLinks).where(eq(schema.collectionFormLinks.viewId, viewId))
    assert.ok(link)
  })
})
