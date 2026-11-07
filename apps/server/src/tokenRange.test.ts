// Connection range and API token helpers without a database (docs/adr/1200-*, 1201-*).
// The [db] leak tests per path are in tokenRange.db.test.ts.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { FastifyRequest } from 'fastify'

describe('stored range ⇄ AccessRange', async () => {
  const { columnsToRange, rangeToColumns, scopeFromColumns, RANGE_MAX_DEPTH } = await import('./tokenRange')
  const { TREE_MAX_DEPTH } = await import('./pageTree')
  const ws = '11111111-1111-4111-8111-111111111111'
  const pg = '22222222-2222-4222-8222-222222222222'

  it('round-trips every kind', () => {
    for (const r of [
      { kind: 'all' as const },
      { kind: 'workspaces' as const, workspaceIds: [ws] },
      { kind: 'subtree' as const, pageId: pg },
    ]) {
      assert.deepEqual(columnsToRange(rangeToColumns(r)), r)
    }
  })

  it('legacy grants (null kind) mean everything; broken rows fail closed', () => {
    assert.deepEqual(columnsToRange({ rangeKind: null, rangeWorkspaceIds: null, rangePageId: null }), { kind: 'all' })
    for (const broken of [
      { rangeKind: 'subtree', rangeWorkspaceIds: null, rangePageId: null },
      { rangeKind: 'workspaces', rangeWorkspaceIds: null, rangePageId: null },
      { rangeKind: 'everything', rangeWorkspaceIds: null, rangePageId: null },
    ]) {
      assert.deepEqual(columnsToRange(broken), { kind: 'workspaces', workspaceIds: [] }, JSON.stringify(broken))
    }
  })

  it('a subtree whose root is gone reaches no workspace', () => {
    const s = scopeFromColumns('u', { rangeKind: 'subtree', rangeWorkspaceIds: null, rangePageId: pg }, null)
    assert.deepEqual(s, { userId: 'u', kind: 'subtree', workspaceIds: [], rootPageId: pg })
    assert.equal(scopeFromColumns('u', { rangeKind: 'all', rangeWorkspaceIds: null, rangePageId: null }, null), null)
  })

  it('the subtree walk has the same depth cap as every other tree walk', () => {
    assert.equal(RANGE_MAX_DEPTH, TREE_MAX_DEPTH)
  })
})

describe('range helpers add nothing outside a range', async () => {
  const { pageInRangeSql, rangeWorkspaceSql, runInRange, currentRange, assertTopLevelInRange, visibleRangeSql } = await import('./tokenRange')
  const { PgDialect } = await import('drizzle-orm/pg-core')
  const { sql } = await import('drizzle-orm')
  const d = new PgDialect()
  const render = (q: ReturnType<typeof sql>) => d.sqlToQuery(q).sql

  it('no store: plain true and no visibleTo term', () => {
    assert.equal(render(rangeWorkspaceSql(sql`w`)), 'true')
    assert.equal(render(pageInRangeSql(sql`p.id`, sql`p.workspace_id`)), 'true')
    assert.equal(visibleRangeSql('u'), null)
    assertTopLevelInRange('w')
  })

  it('a range applies to its own user only', () => {
    const scope = { userId: 'me', kind: 'subtree' as const, workspaceIds: ['w1'], rootPageId: 'r' }
    runInRange(scope, () => {
      assert.equal(currentRange('me'), scope)
      assert.equal(currentRange('someone-else'), null)
      assert.equal(visibleRangeSql('someone-else'), null)
      assert.match(render(pageInRangeSql(sql`p.id`, sql`p.workspace_id`, 'me')), /WITH RECURSIVE ink_range_sub/)
      assert.throws(() => assertTopLevelInRange('w1', 'me'), /outside it/)
      assert.throws(() => assertTopLevelInRange('w2', 'me'), /outside it/)
    })
    runInRange({ userId: 'me', kind: 'workspaces', workspaceIds: ['w1'], rootPageId: null }, () => {
      assertTopLevelInRange('w1', 'me')
      assert.throws(() => assertTopLevelInRange('w2', 'me'), /outside it/)
      assert.equal(render(rangeWorkspaceSql(sql`w`)), 'w = ANY($1::uuid[])')
    })
    runInRange({ userId: 'me', kind: 'subtree', workspaceIds: [], rootPageId: 'gone' }, () => {
      assert.equal(render(rangeWorkspaceSql(sql`w`)), 'false')
    })
  })
})

describe('bearer route policy', async () => {
  const { assertBearerRouteAllowed, SESSION_ONLY, RANGED_DENY, SUBTREE_DENY } = await import('./tokenPolicy')
  const req = (method: string, url: string) => ({ method, routeOptions: { url } }) as unknown as FastifyRequest
  const sub = { userId: 'u', kind: 'subtree' as const, workspaceIds: ['w'], rootPageId: 'r' }
  const wss = { userId: 'u', kind: 'workspaces' as const, workspaceIds: ['w'], rootPageId: null }

  it('session-only routes are refused with or without a range', () => {
    for (const r of SESSION_ONLY) {
      const m = r.method === '*' ? 'GET' : r.method
      assert.throws(() => assertBearerRouteAllowed(req(m, r.url), null), /web app/, r.url)
    }
    // GET of a share link is fine; only changes are browser-only
    assertBearerRouteAllowed(req('GET', '/api/pages/:id/share'), null)
  })

  it('ranged and subtree rules', () => {
    for (const r of RANGED_DENY) {
      assertBearerRouteAllowed(req(r.method, r.url), null)
      assert.throws(() => assertBearerRouteAllowed(req(r.method, r.url), wss), /outside it/)
    }
    for (const r of SUBTREE_DENY) {
      const m = r.method === '*' ? 'GET' : r.method
      assertBearerRouteAllowed(req(m, r.url), wss)
      assert.throws(() => assertBearerRouteAllowed(req(m, r.url), sub), /outside it/)
    }
    assertBearerRouteAllowed(req('GET', '/api/workspaces/:id/pages'), sub)
  })
})

describe('rate-limit key', async () => {
  const { rateLimitKey } = await import('./rateLimitKey')
  const r = (authorization?: string) => ({ headers: authorization ? { authorization } : {}, ip: '203.0.113.9' }) as unknown as FastifyRequest

  it('API tokens get their own bucket, by hash; everything else by IP', () => {
    const t = `ink_pat_${'a'.repeat(43)}`
    const k = rateLimitKey(r(`Bearer ${t}`))
    assert.match(k, /^pat:[A-Za-z0-9_-]{22}$/)
    assert.ok(!k.includes('aaaa'), 'never the raw token')
    assert.notEqual(k, rateLimitKey(r(`Bearer ink_pat_${'b'.repeat(43)}`)))
    assert.equal(rateLimitKey(r()), '203.0.113.9')
    assert.equal(rateLimitKey(r('Bearer ink_at_xyz')), '203.0.113.9')
  })
})

describe('API token format', async () => {
  const { newApiToken, isApiTokenShaped, tokenDisplayPrefix } = await import('./apiTokens')
  it('ink_pat_ + 43 base64url characters; prefix keeps 4 more', () => {
    const t = newApiToken()
    assert.match(t, /^ink_pat_[A-Za-z0-9_-]{43}$/)
    assert.ok(isApiTokenShaped(t))
    assert.equal(tokenDisplayPrefix(t).length, 12)
    assert.notEqual(newApiToken(), t)
  })
})
