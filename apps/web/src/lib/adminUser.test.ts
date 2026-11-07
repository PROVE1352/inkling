// @ts-nocheck — Node test file (node:test types are not part of the web tsconfig); not bundled.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { userOriginBadge } from './adminUser'

test('admin user badge: "Signup key" only for local accounts that actually used a key', () => {
  assert.equal(userOriginBadge({ origin: 'local', signupKey: 'ABCD-EFGH-JKMN-PQRS' }), 'signupKey')
  assert.equal(userOriginBadge({ origin: 'local', signupKey: null }), 'local')
  assert.equal(userOriginBadge({ origin: 'delegated', signupKey: null }), 'delegated')
  // a delegated mirror never shows the key badge, even with a stray value
  assert.equal(userOriginBadge({ origin: 'delegated', signupKey: 'X' }), 'delegated')
  // created by an OpenID Connect sign-in (docs/adr/1161-*)
  assert.equal(userOriginBadge({ origin: 'oidc', signupKey: null }), 'oidc')
})
