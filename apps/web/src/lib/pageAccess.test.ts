// @ts-nocheck — Node test file (node:test types are not part of the web tsconfig); not bundled.
// Page access levels offered in the share dialog (docs/adr/1251-*).
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { defaultLevelFor, grantableLevels, isGuestRole, levelLabel, looksLikeEmail } from './pageAccess'

describe('page access helpers (1251)', () => {
  it('never offers more than the caller has, and never full to a guest', () => {
    assert.deepEqual(grantableLevels('full', false), ['view', 'comment', 'edit', 'full'])
    assert.deepEqual(grantableLevels('full', true), ['view', 'comment', 'edit'])
    assert.deepEqual(grantableLevels('edit', false), ['view', 'comment', 'edit'])
    assert.deepEqual(grantableLevels('comment', true), ['view', 'comment'])
  })

  it('defaults to edit for members and view for guests, capped by the caller', () => {
    assert.equal(defaultLevelFor('full', false), 'edit')
    assert.equal(defaultLevelFor('full', true), 'view')
    assert.equal(defaultLevelFor('comment', false), 'comment')
  })

  it('knows the guest role and labels every level', () => {
    assert.equal(isGuestRole('guest'), true)
    assert.equal(isGuestRole('member'), false)
    assert.equal(isGuestRole(undefined), false)
    for (const l of ['view', 'comment', 'edit', 'full']) assert.notEqual(levelLabel(l), `access.level.${l}`)
  })

  it('recognises an email address roughly', () => {
    assert.equal(looksLikeEmail('a@b.co'), true)
    assert.equal(looksLikeEmail(' kim@example.org '), true)
    assert.equal(looksLikeEmail('kim'), false)
    assert.equal(looksLikeEmail('kim@host'), false)
  })
})
