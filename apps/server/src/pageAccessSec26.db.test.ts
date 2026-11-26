// Security fixes 0.25.4 (sec26 piece a): own-row removal, shares by email to unverified accounts, guest
// emails in the access list, lock management by an owner with a view row, privatizing ownerless pages.
// Run: cd apps/server && DATABASE_URL=postgres://… node node_modules/tsx/dist/cli.mjs --test src/pageAccessSec26.db.test.ts
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.APP_SECRET_KEY ||= 'test-app-secret-key-0123456789-abcdefghij'

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import type { FastifyInstance } from 'fastify'

process.env.DATA_DIR ||= mkdtempSync(path.join(tmpdir(), 'ink-sec26a-'))
mkdirSync(path.join(process.env.DATA_DIR, 'uploads'), { recursive: true })

const HAS_DB = !!process.env.DATABASE_URL

describe('[db] page access hardening (sec26 a)', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const h = await import('./mcpTools/testHarness')
  const { db, closeDb } = await import('./db/index')
  const schema = await import('./db/schema')
  const { and, eq } = await import('drizzle-orm')
  const Fastify = (await import('fastify')).default
  const { ZodError } = await import('zod')
  const { AppError } = await import('./errors')

  async function buildApp(): Promise<FastifyInstance> {
    const app = Fastify()
    await app.register(import('@fastify/cookie'))
    app.setErrorHandler((err, _req, reply) => {
      if (err instanceof AppError) {
        return reply.code(err.status).send({ error: { ...(err.details ?? {}), code: err.code, message: err.message } })
      }
      if (err instanceof ZodError) return reply.code(400).send({ error: { code: 'VALIDATION', message: String(err.issues[0]?.message) } })
      const statusCode = (err as { statusCode?: number }).statusCode
      if (statusCode && statusCode < 500) return reply.code(statusCode).send({ error: { code: 'VALIDATION', message: String((err as Error).message) } })
      console.error(err)
      return reply.code(500).send({ error: { code: 'INTERNAL', message: String(err) } })
    })
    await app.register(
      async (api) => {
        await (await import('./routes/workspaces')).registerWorkspaceRoutes(api)
        await (await import('./routes/workspaceAdmin')).registerWorkspaceAdminRoutes(api)
        await (await import('./routes/pages')).registerPageRoutes(api)
        await (await import('./routes/editLock')).registerEditLockRoutes(api)
        await (await import('./routes/agentPolicy')).registerAgentPolicyRoutes(api)
        await (await import('./routes/pageAccess')).registerPageAccessRoutes(api)
      },
      { prefix: '/api' },
    )
    await app.ready()
    return app
  }

  const app = await buildApp()
  after(async () => {
    await app.close()
    await closeDb()
  })

  type U = Awaited<ReturnType<typeof h.makeUser>>
  const as = (u: U, method: string, url: string, payload?: unknown) =>
    app.inject({ method: method as 'GET', url, headers: { cookie: u.cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) })
  const grant = async (by: U, pageId: string, who: { userId?: string; email?: string }, level: string) => {
    const res = await as(by, 'PUT', `/api/pages/${pageId}/access`, { ...who, level })
    assert.equal(res.statusCode, 200, res.body)
    return res.json()
  }
  const rowOf = async (pageId: string, userId: string) => {
    const [r] = await db
      .select({ level: schema.pageGrants.level })
      .from(schema.pageGrants)
      .where(and(eq(schema.pageGrants.pageId, pageId), eq(schema.pageGrants.userId, userId)))
    return r?.level ?? null
  }
  /** A user with a valid address (the harness's `…@t.t` fails the email schema). */
  const mkUser = async (name: string) => {
    const u = await h.makeUser(name)
    u.email = `${name.replace(/\W/g, '')}-${u.id.slice(0, 8)}@example.com`
    await db.update(schema.users).set({ email: u.email }).where(eq(schema.users.id, u.id))
    return u
  }
  const verify = async (u: U) => {
    await db.update(schema.users).set({ emailVerifiedAt: new Date() }).where(eq(schema.users.id, u.id))
  }
  const page = async (ws: { id: string }, by: U | null, title: string, parentId?: string) =>
    (await h.makeDocPage(ws.id, by?.id ?? O.id, title, [], { createdBy: by ? by.id : null, ...(parentId ? { parentId } : {}) })).id

  let O: U
  let M: U
  let ws: { id: string }
  before(async () => {
    O = await mkUser('owner')
    M = await mkUser('member')
    ws = await h.makeWorkspace(O, [M])
  })

  describe('B-1: a member removing their own row', () => {
    const canEdit = async (pageId: string) => (await as(M, 'PATCH', `/api/pages/${pageId}`, { title: 'x' })).statusCode

    it('own view row on the page: refused, the restriction stays', async () => {
      const P = await page(ws, O, 'own view')
      await grant(O, P, { userId: M.id }, 'view')
      assert.equal(await canEdit(P), 403)
      const del = await as(M, 'DELETE', `/api/pages/${P}/access/${M.id}`)
      assert.equal(del.statusCode, 403, del.body)
      assert.equal(await rowOf(P, M.id), 'view')
      assert.equal(await canEdit(P), 403)
    })

    it('own comment row: refused', async () => {
      const P = await page(ws, O, 'own comment')
      await grant(O, P, { userId: M.id }, 'comment')
      assert.equal((await as(M, 'DELETE', `/api/pages/${P}/access/${M.id}`)).statusCode, 403)
      assert.equal(await rowOf(P, M.id), 'comment')
    })

    it('own edit row without rows above: allowed (edit is the member default)', async () => {
      const P = await page(ws, O, 'own edit')
      await grant(O, P, { userId: M.id }, 'edit')
      assert.equal((await as(M, 'DELETE', `/api/pages/${P}/access/${M.id}`)).statusCode, 200)
      assert.equal(await rowOf(P, M.id), null)
    })

    it('own full row: allowed (leaving lowers them to the default)', async () => {
      const P = await page(ws, O, 'own full')
      await grant(O, P, { userId: M.id }, 'full')
      assert.equal((await as(M, 'DELETE', `/api/pages/${P}/access/${M.id}`)).statusCode, 200)
    })

    it('inherited: a view row above makes removing an edit row below a step down: allowed', async () => {
      const A = await page(ws, O, 'anc view')
      const C = await page(ws, O, 'child edit', A)
      await grant(O, A, { userId: M.id }, 'view')
      await grant(O, C, { userId: M.id }, 'edit')
      assert.equal(await canEdit(C), 200)
      assert.equal((await as(M, 'DELETE', `/api/pages/${C}/access/${M.id}`)).statusCode, 200)
      assert.equal(await canEdit(C), 403)
    })

    it('inherited: a view row above, a comment row below: removing it steps down to view, allowed', async () => {
      const A = await page(ws, O, 'anc view 2')
      const C = await page(ws, O, 'child comment', A)
      await grant(O, A, { userId: M.id }, 'view')
      await grant(O, C, { userId: M.id }, 'comment')
      assert.equal((await as(M, 'DELETE', `/api/pages/${C}/access/${M.id}`)).statusCode, 200)
    })

    it('inherited: a full row above and a view row below: removing would raise them to full, refused', async () => {
      const A = await page(ws, O, 'anc full')
      const C = await page(ws, O, 'child view', A)
      await grant(O, A, { userId: M.id }, 'full')
      await grant(O, C, { userId: M.id }, 'view')
      assert.equal(await canEdit(C), 403)
      assert.equal((await as(M, 'DELETE', `/api/pages/${C}/access/${M.id}`)).statusCode, 403)
      assert.equal(await rowOf(C, M.id), 'view')
    })

    it('inherited: a full row above and an edit row below: removing would give managing people, refused', async () => {
      const A = await page(ws, O, 'anc full 2')
      const C = await page(ws, O, 'child edit 2', A)
      await grant(O, A, { userId: M.id }, 'full')
      await grant(O, C, { userId: M.id }, 'edit')
      assert.equal((await as(M, 'GET', `/api/pages/${C}/access`)).json().access.canManage, false)
      assert.equal((await as(M, 'DELETE', `/api/pages/${C}/access/${M.id}`)).statusCode, 403)
      assert.equal(await rowOf(C, M.id), 'edit')
    })

    it('their row on an ancestor, removed from there: refused the same way', async () => {
      const A = await page(ws, O, 'anc own view')
      const C = await page(ws, O, 'child plain', A)
      await grant(O, A, { userId: M.id }, 'view')
      const acc = (await as(M, 'GET', `/api/pages/${C}/access`)).json().access
      assert.equal(acc.people.find((p: { userId: string }) => p.userId === M.id)?.inheritedFrom?.pageId, A)
      assert.equal((await as(M, 'DELETE', `/api/pages/${A}/access/${M.id}`)).statusCode, 403)
      assert.equal(await canEdit(C), 403)
    })

    it('the owner still removes the row', async () => {
      const P = await page(ws, O, 'owner removes')
      await grant(O, P, { userId: M.id }, 'view')
      assert.equal((await as(O, 'DELETE', `/api/pages/${P}/access/${M.id}`)).statusCode, 200)
      assert.equal(await canEdit(P), 200)
    })
  })

  describe('A-F2: sharing by email with an account whose address is not verified', () => {
    it('an unverified account outside the workspace gets an invitation, not a row; the candidate list leaves it out', async () => {
      const P = await page(ws, O, 'by mail')
      const V = await mkUser('squatter')
      const cand = await as(O, 'GET', `/api/pages/${P}/access/candidates?q=${encodeURIComponent(V.email)}`)
      assert.equal(cand.statusCode, 200)
      assert.ok(!cand.body.includes(V.id), 'unverified outsider is not offered as an account')
      const res = await grant(O, P, { email: V.email.toUpperCase() }, 'view')
      assert.ok(res.invite, 'an invitation instead of a row')
      assert.equal(res.invite.email, V.email.toLowerCase())
      assert.equal(await rowOf(P, V.id), null)
      // no mail on this instance: the link goes back to the sharer, and the account with that address accepts it
      assert.equal(res.mailed, false)
      const token = (res.invite.link as string).split('/invite/page/')[1]
      const ok = await as(V, 'POST', `/api/page-invites/${token}/accept`)
      assert.equal(ok.statusCode, 200, ok.body)
      assert.equal(await rowOf(P, V.id), 'view')
    })

    it('a verified account gets the row at once and is offered as a candidate', async () => {
      const P = await page(ws, O, 'by mail verified')
      const V = await mkUser('verified')
      await verify(V)
      const cand = await as(O, 'GET', `/api/pages/${P}/access/candidates?q=${encodeURIComponent(V.email)}`)
      assert.ok(cand.body.includes(V.id))
      const res = await grant(O, P, { email: V.email }, 'comment')
      assert.equal(res.invite, undefined)
      assert.equal(await rowOf(P, V.id), 'comment')
    })

    it('an unverified account that is already a guest of this workspace gets the row at once', async () => {
      const P1 = await page(ws, O, 'guest first')
      const P2 = await page(ws, O, 'guest second')
      const V = await mkUser('known guest')
      await grant(O, P1, { userId: V.id }, 'view')
      const cand = await as(O, 'GET', `/api/pages/${P2}/access/candidates?q=${encodeURIComponent(V.email)}`)
      assert.ok(cand.body.includes(V.id))
      const res = await grant(O, P2, { email: V.email }, 'view')
      assert.equal(res.invite, undefined)
      assert.equal(await rowOf(P2, V.id), 'view')
    })

    it('a member found by email keeps getting a row (members are not invited)', async () => {
      const P = await page(ws, O, 'member by mail')
      const res = await grant(O, P, { email: M.email }, 'comment')
      assert.equal(res.invite, undefined)
      assert.equal(await rowOf(P, M.id), 'comment')
      await as(O, 'DELETE', `/api/pages/${P}/access/${M.id}`)
    })
  })

  describe('B-2: guest emails in the access list', () => {
    it('only people who manage the list or may add guests see a guest’s email', async () => {
      const P = await page(ws, O, 'guest email')
      const G = await mkUser('guestmail')
      await grant(O, P, { userId: G.id }, 'view')
      const asOwner = (await as(O, 'GET', `/api/pages/${P}/access`)).json().access
      assert.equal(asOwner.people.find((p: { userId: string }) => p.userId === G.id).email, G.email)
      // a plain member (edit by default, guest policy 'admins'): no managing, no inviting
      const res = await as(M, 'GET', `/api/pages/${P}/access`)
      assert.equal(res.statusCode, 200)
      const acc = res.json().access
      assert.equal(acc.canManage, false)
      assert.equal(acc.canInviteGuests, false)
      const g = acc.people.find((p: { userId: string }) => p.userId === G.id)
      assert.ok(g, 'the guest is still listed')
      assert.equal(g.guest, true)
      assert.ok(!res.body.includes(G.email), 'no guest email for a plain member')
      // with policy 'members' an edit-level member may add guests: they see it
      assert.equal((await as(O, 'PATCH', `/api/workspaces/${ws.id}/settings`, { guestInvitePolicy: 'members' })).statusCode, 200)
      try {
        const res2 = await as(M, 'GET', `/api/pages/${P}/access`)
        assert.ok(res2.body.includes(G.email))
      } finally {
        await as(O, 'PATCH', `/api/workspaces/${ws.id}/settings`, { guestInvitePolicy: 'admins' })
      }
    })
  })

  describe('B-3: lock management by a page owner with a row below edit', () => {
    it('owner with a view row: cannot change the lock or the auto-accept rules', async () => {
      const L = await page(ws, O, 'owned lock')
      await db.update(schema.pages).set({ ownerId: M.id }).where(eq(schema.pages.id, L))
      // owner without a row may manage (control)
      const lock1 = await as(M, 'PUT', `/api/pages/${L}/lock`, { locked: true })
      assert.equal(lock1.statusCode, 200, lock1.body)
      assert.equal(lock1.json().canManage, true)
      await grant(O, L, { userId: M.id }, 'view')
      const status = (await as(M, 'GET', `/api/pages/${L}/lock`)).json()
      assert.equal(status.canManage, false)
      const unlock = await as(M, 'PUT', `/api/pages/${L}/lock`, { locked: false })
      assert.equal(unlock.statusCode, 403, unlock.body)
      const rulesGet = (await as(M, 'GET', `/api/pages/${L}/agent-rules`)).json()
      assert.equal(rulesGet.policy.canManage, false)
      const rules = await as(M, 'PUT', `/api/pages/${L}/agent-rules`, {
        rules: { modes: [], connections: [], maxLines: null, maxChars: null, graceMinutes: 0 },
      })
      assert.equal(rules.statusCode, 403, rules.body)
      // an edit row keeps the owner's right
      await grant(O, L, { userId: M.id }, 'edit')
      assert.equal((await as(M, 'PUT', `/api/pages/${L}/lock`, { locked: false })).statusCode, 200)
    })
  })

  describe('B-4: privatizing a shared page whose author is gone', () => {
    it('a member cannot take an ownerless shared page into their private section; an admin can', async () => {
      const P = await page(ws, null, 'ownerless')
      const C = await page(ws, null, 'ownerless child', P)
      const res = await as(M, 'PATCH', `/api/pages/${P}`, { scope: 'private' })
      assert.equal(res.statusCode, 403, res.body)
      const [row] = await db.select({ scope: schema.pages.scope, createdBy: schema.pages.createdBy }).from(schema.pages).where(eq(schema.pages.id, P))
      assert.equal(row.scope, 'shared')
      assert.equal(row.createdBy, null)
      // an ownerless page below the member's own page: refused too
      const Mine = await page(ws, M, 'mine')
      await db.update(schema.pages).set({ parentId: Mine }).where(eq(schema.pages.id, C))
      const res2 = await as(M, 'PATCH', `/api/pages/${Mine}`, { scope: 'private' })
      assert.equal(res2.statusCode, 400, res2.body)
      // the owner (manager) may still claim it
      const own = await as(O, 'PATCH', `/api/pages/${P}`, { scope: 'private' })
      assert.equal(own.statusCode, 200, own.body)
    })
  })
})
