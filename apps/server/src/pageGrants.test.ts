// Pure parts of people rows and guests (docs/adr/1250-*, 1251-*, 1252-*): levels to bits, and that
// visibility adds no SQL at all for a request without a guest scope (docs/PERFORMANCE.md).
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { PgDialect } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { CAP_COMMENT, CAP_EDIT, effectiveLevel, grantCaps, guestPageSql, runAsGuest } from './pageGrants'

const dialect = new PgDialect()
const render = (q: ReturnType<typeof sql>) => dialect.sqlToQuery(q).sql
const U = '00000000-0000-4000-8000-000000000001'
const WS = '00000000-0000-4000-8000-0000000000aa'
const ROOT = '00000000-0000-4000-8000-0000000000bb'

describe('page levels', () => {
  it('owners and admins are full whatever the row says', () => {
    for (const role of ['owner', 'admin'] as const) {
      assert.equal(effectiveLevel(role, 'view'), 'full')
      assert.equal(grantCaps(role, 'view'), CAP_EDIT | CAP_COMMENT)
    }
  })
  it('a member row replaces the default edit, both ways', () => {
    assert.equal(effectiveLevel('member', null), 'edit')
    assert.equal(grantCaps('member', null), CAP_EDIT | CAP_COMMENT)
    assert.equal(grantCaps('member', 'view'), 0)
    assert.equal(grantCaps('member', 'comment'), CAP_COMMENT)
    assert.equal(effectiveLevel('member', 'full'), 'full')
  })
  it('a guest has only their row, never full', () => {
    assert.equal(grantCaps('guest', null), 0)
    assert.equal(effectiveLevel('guest', null), null)
    assert.equal(effectiveLevel('guest', 'full'), 'edit')
    assert.equal(grantCaps('guest', 'edit'), CAP_EDIT | CAP_COMMENT)
  })
  it('a caller that did not resolve membership keeps the old behaviour without a row', () => {
    assert.equal(grantCaps(null, null), CAP_EDIT | CAP_COMMENT)
    assert.equal(grantCaps(null, 'view'), 0)
  })
})

describe('guest visibility SQL', () => {
  it('no scope, or a scope without guest workspaces: nothing at all', () => {
    assert.equal(guestPageSql(sql`p.id`, sql`p.workspace_id`, U), null)
    runAsGuest({ userId: U, workspaces: new Map(), token: false, hasRows: false }, () => {
      assert.equal(guestPageSql(sql`p.id`, sql`p.workspace_id`, U), null)
    })
  })
  it('visibleTo gets no range term for members (no scope, or a scope without rows)', async () => {
    const { visibleRangeSql } = await import('./tokenRange')
    assert.equal(visibleRangeSql(U), null)
    runAsGuest({ userId: U, workspaces: new Map(), token: false, hasRows: false }, () => assert.equal(visibleRangeSql(U), null))
  })
  it('a guest scope narrows only its own workspaces and only for its own user', () => {
    runAsGuest({ userId: U, workspaces: new Map([[WS, [{ pageId: ROOT, level: 'view' as const }]]]), token: false, hasRows: true }, () => {
      const q = render(guestPageSql(sql`p.id`, sql`p.workspace_id`, U)!)
      assert.match(q, /p\.workspace_id <> ALL/)
      assert.match(q, /ink_guest_sub/)
      assert.equal(guestPageSql(sql`p.id`, sql`p.workspace_id`, '00000000-0000-4000-8000-000000000002'), null)
    })
  })
  it('a token request hides guest workspaces entirely', () => {
    runAsGuest({ userId: U, workspaces: new Map([[WS, [{ pageId: ROOT, level: 'edit' as const }]]]), token: true, hasRows: true }, () => {
      const q = render(guestPageSql(sql`p.id`, sql`p.workspace_id`, U)!)
      assert.match(q, /OR false\)/)
      assert.doesNotMatch(q, /ink_guest_sub/)
    })
  })
})
