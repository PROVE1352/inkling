// Request-log URL masking for secrets in a path (0.25.4 security fix F-3 / E-3, on top of C-L8):
// public form tokens, page invite tokens, workspace invite codes, SPA links that carry them, signup
// keys in admin paths, and a sign-in redirect (`next`, `returnTo`) that points at one of them.
// Run: cd apps/server && node ../../scripts/run-tests.mjs --test-name-pattern=mask
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { maskUrlSecrets } from './util'

describe('maskUrlSecrets: secrets in paths', () => {
  const cases: [string, string][] = [
    // API
    ['/api/public/forms/FORMTOKEN123', '/api/public/forms/***'],
    ['/api/public/forms/FORMTOKEN123?x=1', '/api/public/forms/***?x=1'],
    ['/api/page-invites/INVITETOKEN', '/api/page-invites/***'],
    ['/api/page-invites/INVITETOKEN/accept', '/api/page-invites/***/accept'],
    ['/api/admin/signup-keys/ABCD-EFGH-JKLM-NPQR', '/api/admin/signup-keys/***'],
    ['/api/admin/signup-keys/ABCD-EFGH-JKLM-NPQR/send-invite', '/api/admin/signup-keys/***/send-invite'],
    // SPA paths (the shell answers them, and that request is logged too)
    ['/join/ABCD-EFGH', '/join/***'],
    ['/invite/page/PAGEINVITETOKEN', '/invite/page/***'],
    ['/f/FORMTOKEN123', '/f/***'],
    ['/s/SHARETOKEN/p/ref', '/s/***/p/ref'],
    // a sign-in redirect to one of them, encoded or not
    ['/login?next=%2Fjoin%2FABCD-EFGH', `/login?next=${encodeURIComponent('/join/***')}`],
    ['/login?next=/invite/page/PAGEINVITETOKEN', `/login?next=${encodeURIComponent('/invite/page/***')}`],
    ['/api/auth/oidc/start?returnTo=%2Ff%2FFORMTOKEN123', `/api/auth/oidc/start?returnTo=${encodeURIComponent('/f/***')}`],
    // a redirect that carries its own secret query
    ['/login?next=%2Fsetup%3Fcode%3DSETUPCODE', `/login?next=${encodeURIComponent('/setup?code=***')}`],
  ]
  for (const [url, want] of cases) {
    it(`${url} → ${want}`, () => {
      const got = maskUrlSecrets(url)
      assert.equal(got, want)
      for (const secret of ['FORMTOKEN123', 'INVITETOKEN', 'ABCD-EFGH', 'PAGEINVITETOKEN', 'SETUPCODE', 'SHARETOKEN']) {
        assert.ok(!got.includes(secret), `${secret} left in ${got}`)
      }
    })
  }

  it('paths without a secret stay as they are', () => {
    for (const url of ['/api/pages/1', '/login', '/login?next=%2Fw%2Fabc%2Fp%2Fdef', '/w/abc/p/def', '/api/workspaces/join', '/api/admin/signup-keys', '/files/abc']) {
      const got = maskUrlSecrets(url)
      assert.equal(decodeURIComponent(got), decodeURIComponent(url))
    }
  })
})
