// LIMIT_WORKSPACES_TOTAL (contract §14, security review F1, docs/adr/2531-*).
//  - The review's R8: an account that deletes itself hands its workspaces to a member past
//    LIMIT_WORKSPACES_PER_USER (by design: shared workspaces stay until everyone left), and its sign-up
//    slot comes free, so a keeper collected 2 workspaces per throwaway sign-up without end. The total
//    of workspaces on the server now bounds it: sign-up (SIGNUP_FULL) and new workspaces
//    (LIMIT_WORKSPACES_TOTAL) are refused at it, however long the loop runs.
//  - Concurrent creations at the edge cannot pass it together (one server-wide lock).
//  - Restoring a deleted workspace is not refused (it is counted already).
//  - Unset: nothing is refused, and GET /api/auth/mode gains no field.
// Own database: the limit counts every workspace on the server.
process.env.SIGNUP_REQUIRE_KEY = '0'
for (const k of ['DELEGATED_AUTH_URL', 'SMTP_HOST', 'MAIL_FROM', 'REQUIRE_EMAIL_VERIFICATION', 'OIDC_ISSUER']) delete process.env[k]

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, describe, it } from 'node:test'

const HAS_DB = !!process.env.DATABASE_URL

describe('[db] LIMIT_WORKSPACES_TOTAL (F1)', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const kit = await import('../restrictedMode/restrictedTestKit')
  const drop = await kit.scratchDatabase('w22x1total')
  const { db } = await import('../db/index')
  const schema = await import('../db/schema')
  const { sql } = await import('drizzle-orm')
  const L = await import('../limits')
  const { hashPassword, createSession, SESSION_COOKIE } = await import('../auth')
  const app = await kit.buildRestrictedApp()
  after(async () => {
    await app.close()
    await drop()
    setTimeout(() => process.exit(0), 300).unref()
  })

  const DEMO = { loginIdMode: 'username' as const, disabledFeatures: ['password-reset' as const], signupMaxUsers: 50, signupPerIpPerDay: 2, accountLifetimeDays: 14, workspacesPerUser: 2, membersPerWorkspace: 4, pagesPerWorkspace: 300, workspaceStorageMb: 20 }
  const tag = () => randomBytes(4).toString('hex')
  const total = async () => Number(((await db.execute(sql`SELECT count(*)::int AS n FROM workspaces`)) as unknown as { n: number }[])[0].n)
  const ownedBy = async (uid: string) =>
    Number(((await db.execute(sql`SELECT count(*)::int AS n FROM workspace_members WHERE user_id = ${uid} AND role = 'owner'`)) as unknown as { n: number }[])[0].n)
  const codeOf = (r: { json: () => unknown }) => (r.json() as { error?: { code?: string } }).error?.code
  let v6 = 0
  const signUp = (loginId: string) =>
    app.inject({ method: 'POST', url: '/api/auth/register', remoteAddress: `2001:db8:77:${(v6++).toString(16)}::1`, payload: { loginId, name: 'N', password: 'password123', formMs: 2500 } })
  const signedUp = async (loginId: string) => {
    const r = await signUp(loginId)
    assert.equal(r.statusCode, 200, r.body)
    const cookie = kit.cookieOf(r)
    const me = (await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })).json() as { user: { id: string } }
    return { id: me.user.id, loginId, cookie }
  }
  const wsOf = async (cookie: string) =>
    ((await app.inject({ method: 'GET', url: '/api/workspaces', headers: { cookie } })).json() as { workspaces: { id: string }[] }).workspaces

  before(async () => {
    // an admin exists, so restricted sign-up is open (SETUP_REQUIRED does not fire)
    const [a] = await db.insert(schema.users).values({ email: `op-${tag()}@t.t`, name: 'Operator', passwordHash: await hashPassword('password123'), isAdmin: true }).returning()
    void a
  })

  it('R8 with LIMIT_WORKSPACES_TOTAL: throwaway sign-ups that hand their workspaces to a keeper stop at the total', async () => {
    const limit = (await total()) + 7
    const restore = L.setLimitsForTests({ ...DEMO, workspacesTotal: limit })
    try {
      const keeper = await signedUp(`keeper${tag()}`)
      const seen: number[] = []
      let refusedSignUp = 0
      let refusedCreate = 0
      for (let i = 0; i < 8; i++) {
        const loginId = `throw${tag()}`
        const s = await signUp(loginId)
        if (s.statusCode !== 200) {
          assert.equal(codeOf(s), 'SIGNUP_FULL', s.body)
          refusedSignUp++
          seen.push(await total())
          continue
        }
        const cookie = kit.cookieOf(s)
        const c = await app.inject({ method: 'POST', url: '/api/workspaces', headers: { cookie }, payload: { name: `extra ${i}` } })
        if (c.statusCode !== 200) {
          assert.equal(codeOf(c), 'LIMIT_WORKSPACES_TOTAL', c.body)
          refusedCreate++
        }
        for (const w of await wsOf(cookie)) {
          const g = await app.inject({ method: 'POST', url: `/api/workspaces/${w.id}/invite/regenerate`, headers: { cookie } })
          const code = (g.json() as { workspace: { inviteCode: string } }).workspace.inviteCode
          const j = await app.inject({ method: 'POST', url: '/api/workspaces/join', headers: { cookie: keeper.cookie }, payload: { inviteCode: code } })
          assert.equal(j.statusCode < 300, true, j.body)
        }
        const d = await app.inject({ method: 'DELETE', url: '/api/me', headers: { cookie }, payload: { confirm: loginId, password: 'password123' } })
        assert.equal(d.statusCode, 200, d.body)
        seen.push(await total())
      }
      const owned = await ownedBy(keeper.id)
      const mode = (await app.inject({ method: 'GET', url: '/api/auth/mode' })).json() as { signupFull?: boolean }
      const mine = await app.inject({ method: 'POST', url: '/api/workspaces', headers: { cookie: keeper.cookie }, payload: { name: 'one more' } })
      console.log(`[F1] LIMIT_WORKSPACES_TOTAL=${limit}: totals after each round ${seen.join(',')}; keeper owns ${owned}; sign-ups refused ${refusedSignUp}, creates refused ${refusedCreate}; keeper's create: ${codeOf(mine) ?? mine.statusCode}; auth/mode signupFull ${mode.signupFull}`)
      for (const n of seen) assert.ok(n <= limit, `${n} workspaces > ${limit}`)
      assert.ok(refusedSignUp > 0, 'sign-up is refused at the total')
      assert.equal(mode.signupFull, true)
      assert.ok(['LIMIT_WORKSPACES_TOTAL', 'LIMIT_WORKSPACES'].includes(codeOf(mine) ?? ''), mine.body)
    } finally {
      restore()
    }
  })

  it('concurrent creations at the edge: the total is never passed', async () => {
    const people = await Promise.all(
      Array.from({ length: 6 }, async () => {
        const [u] = await db.insert(schema.users).values({ email: `c-${tag()}@t.t`, name: 'C', passwordHash: 'x' }).returning()
        const { token } = await createSession(u.id)
        return `${SESSION_COOKIE}=${token}`
      }),
    )
    const limit = (await total()) + 3
    const restore = L.setLimitsForTests({ workspacesTotal: limit })
    try {
      const rs = await Promise.all(people.map((cookie, i) => app.inject({ method: 'POST', url: '/api/workspaces', headers: { cookie }, payload: { name: `race ${i}` } })))
      const ok = rs.filter((r) => r.statusCode === 200).length
      assert.equal(ok, 3, rs.map((r) => r.statusCode).join(','))
      for (const r of rs) if (r.statusCode !== 200) assert.equal(codeOf(r), 'LIMIT_WORKSPACES_TOTAL')
      assert.equal(await total(), limit)
      // the refusal carries the numbers
      const e = rs.find((r) => r.statusCode !== 200)!.json() as { error: { limit: number; used: number } }
      assert.equal(e.error.limit, limit)
    } finally {
      restore()
    }
  })

  it('restoring a deleted workspace at the total is not refused (it is counted already)', async () => {
    const [u] = await db.insert(schema.users).values({ email: `r-${tag()}@t.t`, name: 'R', passwordHash: 'x' }).returning()
    const { token } = await createSession(u.id)
    const cookie = `${SESSION_COOKIE}=${token}`
    const c = await app.inject({ method: 'POST', url: '/api/workspaces', headers: { cookie }, payload: { name: 'to restore' } })
    const id = (c.json() as { workspace: { id: string } }).workspace.id
    const del = await app.inject({ method: 'DELETE', url: `/api/workspaces/${id}`, headers: { cookie }, payload: { name: 'to restore' } })
    assert.ok(del.statusCode < 300, del.body)
    const restore = L.setLimitsForTests({ workspacesTotal: await total() })
    try {
      const r = await app.inject({ method: 'POST', url: `/api/workspaces/${id}/restore`, headers: { cookie } })
      assert.ok(r.statusCode < 300, r.body)
      const again = await app.inject({ method: 'POST', url: '/api/workspaces', headers: { cookie }, payload: { name: 'new' } })
      assert.equal(codeOf(again), 'LIMIT_WORKSPACES_TOTAL')
    } finally {
      restore()
    }
  })

  it('unset: nothing refused past any count, and auth mode has no new field', async () => {
    assert.equal(L.limits.workspacesTotal, undefined)
    const mode = (await app.inject({ method: 'GET', url: '/api/auth/mode' })).json() as Record<string, unknown>
    assert.equal('signupFull' in mode, false)
    assert.equal('instanceFull' in mode, false)
    const [u] = await db.insert(schema.users).values({ email: `n-${tag()}@t.t`, name: 'N', passwordHash: 'x' }).returning()
    const { token } = await createSession(u.id)
    const before = await total()
    for (let i = 0; i < 3; i++) {
      const r = await app.inject({ method: 'POST', url: '/api/workspaces', headers: { cookie: `${SESSION_COOKIE}=${token}` }, payload: { name: `free ${i}` } })
      assert.equal(r.statusCode, 200, r.body)
    }
    assert.equal(await total(), before + 3)
    const s = await app.inject({ method: 'POST', url: '/api/auth/register', remoteAddress: '198.51.100.9', payload: { email: `free-${tag()}@example.com`, name: 'F', password: 'password123' } })
    assert.equal(s.statusCode, 200, s.body)
  })
})
