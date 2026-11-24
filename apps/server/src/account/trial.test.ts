// Trial accounts (docs/adr/2555-*), the parts without a database: names and addresses, the TRIAL_*
// settings, the list of refused routes, and two sweeps of the source that keep that list in step with
// the routes that exist (every write route of the files or paths that publish, invite, join, send out or
// change how an account signs in is either refused or reviewed below) and with the MCP tools (none calls
// a refused route, so the gate needs nothing MCP-specific).
// Run: cd apps/server && node ../../scripts/run-tests.mjs --test-name-pattern="trial accounts"
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { isTrialEmail, TRIAL_EMAIL_SUFFIX } from '@inkling/shared'
import { limitsBootLines, LimitsConfigError, parseLimitsEnv } from '../limits'
import { LOGIN_ID_RE, normalizeLoginId } from './loginId'
import { TRIAL_INVITE_LINK_ROUTE, TRIAL_RESTRICTED_ROUTES, trialEmail, trialName, trialRestriction } from './trial'

const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Every `x.post|put|patch|delete('/path'` in the server's non-test source: method, path, file. */
function writeRoutesInSource(): { method: string; url: string; file: string }[] {
  const out: { method: string; url: string; file: string }[] = []
  const walk = (dir: string) => {
    for (const f of readdirSync(dir)) {
      const p = path.join(dir, f)
      if (statSync(p).isDirectory()) walk(p)
      else if (p.endsWith('.ts') && !/\.test\.ts$|testHarness|TestKit/.test(p)) {
        const text = readFileSync(p, 'utf8')
        const re = /\b\w+\.(post|put|patch|delete)(?:<[^>()]*>)?\(\s*(['"`])(\/[^'"`]*)\2/g
        let m: RegExpExecArray | null
        while ((m = re.exec(text))) out.push({ method: m[1].toUpperCase(), url: m[3], file: path.relative(src, p).split(path.sep).join('/') })
      }
    }
  }
  walk(src)
  return out
}

/** Files whose every write route is reviewed, and paths that are, wherever they live. */
const SENSITIVE_FILES = new Set([
  'routes/slack.ts', 'routes/webhooks.ts', 'routes/forms.ts', 'routes/public.ts', 'routes/pageAccess.ts',
  'routes/ical.ts', 'routes/notion.ts', 'routes/oidc.ts', 'routes/twoFactor.ts', 'routes/workspaces.ts',
  'routes/auth.ts', 'routes/automations.ts', 'routes/sheetSync.ts', 'push/routes.ts', 'routes/clip.ts',
])
const SENSITIVE_PATH = /share|invite|join|webhook|slack|form-link|publish|ical|member|transfer|password|oidc|2fa|guest|access|public|email|login|sync|^\/workspaces$/

/**
 * Write routes of that class a trial account may use, each with the reason. A new route there that is
 * in neither list fails the sweep until someone decides.
 */
const TRIAL_REVIEWED_ALLOWED: Record<string, string> = {
  'DELETE /collection-views/:id/form-link': 'stops a public form',
  'DELETE /collections/:id/automations/:ruleId': 'removes a rule',
  'PATCH /collections/:id/automations/:ruleId': 'a webhook action needs a webhook registered in the workspace, which a trial account cannot register',
  'POST /collections/:id/automations': 'as above',
  'POST /pages/:id/button-webhook': 'as above: only a registered webhook is called',
  'DELETE /me/ical': 'stops the feed',
  'DELETE /pages/:id/access/:userId': 'removes access',
  'DELETE /pages/:id/invites/:inviteId': 'withdraws an invitation',
  'POST /workspaces/:id/guests/remove': 'removes guests',
  'DELETE /pages/:id/share': 'stops a public link',
  'POST /workspaces/:id/shared/unpublish': 'stops public links',
  'DELETE /webhooks/:id': 'removes a webhook',
  'DELETE /workspaces/:id/slack': 'turns Slack off',
  'DELETE /workspaces/:id/slack/links/:userId': 'unlinks',
  'POST /slack/w/:workspaceId/commands': 'Slack calling in, signed by Slack, no session; needs the Slack setting a trial account cannot make',
  'POST /slack/w/:workspaceId/events': 'as above',
  'POST /public/:token/unlock': 'no session: reading someone else\'s public link',
  'POST /public/forms/:token': 'no session: answering someone else\'s public form',
  'DELETE /pages/:id/collection/sheet-sync': 'stops a sync',
  'PUT /pages/:id/collection/sheet-sync': 'reads a public Google Sheet (fixed host, safeFetch); sends nothing of the person\'s',
  'POST /pages/:id/collection/sheet-sync/run': 'as above',
  'POST /clip': 'web clipper: reads a page into the person\'s own workspace through safeFetch, as link previews do',
  'DELETE /push/devices/:id': 'push to the person\'s own browsers (endpoint hosts checked, push/config.ts)',
  'DELETE /push/subscriptions': 'as above',
  'PATCH /push/settings': 'as above',
  'POST /push/subscriptions': 'as above',
  'POST /push/test': 'as above',
  'DELETE /pages/:id/sync': 'vault sync (experimental) of the person\'s own pages',
  'POST /workspaces/:id/sync/pages': 'as above',
  'POST /workspaces/:id/sync/read': 'as above',
  'PUT /pages/:id/sync/md': 'as above',
  'DELETE /workspaces/:id': 'deletes the own workspace',
  'PATCH /workspaces/:id': 'renames the own workspace',
  'POST /workspaces/:id/restore': 'brings back the own workspace (still one)',
  'DELETE /workspaces/:id/members/:userId': 'leaving; nobody else can be a member',
  'PATCH /workspaces/:id/members/:userId': 'roles; nobody else can be a member',
  'PATCH /auth/me/locale': 'the interface language',
  'POST /auth/2fa/disable': 'nothing to turn off: setup and enable are refused',
  'POST /auth/2fa/recovery-codes': 'as above',
  'POST /auth/login': 'no session; the reserved domain is refused in the route',
  'POST /auth/login/totp': 'no session; follows a password sign-in',
  'POST /auth/logout': 'signing out',
  'POST /auth/register': 'no session; the reserved domain is refused in the route (EMAIL_RESERVED)',
  'POST /auth/forgot-password': 'no session; the reserved domain gets nothing (no mail, no admin queue)',
  'POST /auth/reset-password': 'no session; the reserved domain is refused in the route',
  'POST /auth/verify-email': 'no session; a token from a mail the reserved domain never gets',
  'POST /auth/verify-email/send': 'no mail goes to the reserved domain (mail.ts)',
}

const key = (r: { method: string; url: string }) => `${r.method} ${r.url}`
const withoutApi = (url: string) => url.replace(/^\/api(?=\/)/, '')

describe('trial accounts: names, addresses and settings', () => {
  it('the address is in the reserved domain, the name says trial in the person\'s language', () => {
    const e = trialEmail()
    assert.match(e, /^trial-[0-9a-f-]{36}@trial\.invalid$/)
    assert.ok(isTrialEmail(e))
    assert.ok(isTrialEmail(` TRIAL-x${TRIAL_EMAIL_SUFFIX.toUpperCase()} `))
    assert.ok(!isTrialEmail('someone@example.com'))
    assert.ok(!isTrialEmail('trial.invalid@example.com'))
    assert.notEqual(trialEmail(), trialEmail())
    assert.equal(trialName('en', '4F2A'), 'Trial 4F2A')
    assert.equal(trialName('ko', '4F2A'), '체험 4F2A')
    assert.match(trialName('en'), /^Trial [0-9A-F]{4}$/)
  })

  it('LOGIN_ID_MODE=username: no sign-in ID a person can choose is a trial address (an ID has no @)', () => {
    assert.ok(!LOGIN_ID_RE.test(trialEmail()))
    assert.throws(() => normalizeLoginId(trialEmail()), /IDs are 3 to 30/)
    assert.throws(() => normalizeLoginId('x@trial.invalid'), /IDs are 3 to 30/)
    // an ID that merely starts with trial- is an ordinary ID: it is never a trial account's identifier
    assert.equal(normalizeLoginId('trial-1234'), 'trial-1234')
    assert.ok(!isTrialEmail(normalizeLoginId('trial-1234')))
  })

  it('TRIAL_ACCOUNTS=1: defaults 24 hours, 30 accounts, 3 per address; a boot line', () => {
    const l = parseLimitsEnv({ TRIAL_ACCOUNTS: '1' })
    assert.deepEqual(l.trial, { lifetimeHours: 24, maxAccounts: 30, perIpPerDay: 3 })
    assert.deepEqual(limitsBootLines(l), ['restricted mode: trial accounts (30 at once, 24 hours each, 3 per IP per day)'])
    const m = parseLimitsEnv({ TRIAL_ACCOUNTS: '1', TRIAL_LIFETIME_HOURS: '168', TRIAL_MAX_ACCOUNTS: '5', TRIAL_PER_IP_PER_DAY: '1' })
    assert.deepEqual(m.trial, { lifetimeHours: 168, maxAccounts: 5, perIpPerDay: 1 })
  })

  it('off (unset, empty or 0): no key at all; the other three alone only warn', () => {
    for (const v of [undefined, '', '0']) {
      const l = parseLimitsEnv(v === undefined ? {} : { TRIAL_ACCOUNTS: v })
      assert.ok(!('trial' in l))
      assert.deepEqual(limitsBootLines(l), [])
    }
    const l = parseLimitsEnv({ TRIAL_MAX_ACCOUNTS: '5' })
    assert.ok(!('trial' in l))
    assert.deepEqual(l.warnings, ['TRIAL_LIFETIME_HOURS, TRIAL_MAX_ACCOUNTS and TRIAL_PER_IP_PER_DAY do nothing without TRIAL_ACCOUNTS=1'])
  })

  it('a value out of range refuses to boot, even while TRIAL_ACCOUNTS is off', () => {
    const bad = (e: Record<string, string>, re: RegExp) =>
      assert.throws(() => parseLimitsEnv(e), (err: unknown) => err instanceof LimitsConfigError && re.test(err.message))
    bad({ TRIAL_ACCOUNTS: 'yes' }, /TRIAL_ACCOUNTS=yes is not 1 or 0/)
    bad({ TRIAL_ACCOUNTS: '1', TRIAL_LIFETIME_HOURS: '169' }, /TRIAL_LIFETIME_HOURS=169 is above 168/)
    bad({ TRIAL_ACCOUNTS: '1', TRIAL_LIFETIME_HOURS: '0' }, /TRIAL_LIFETIME_HOURS=0 is not a whole number/)
    bad({ TRIAL_ACCOUNTS: '1', TRIAL_LIFETIME_HOURS: '1.5' }, /not a whole number/)
    bad({ TRIAL_ACCOUNTS: '1', TRIAL_MAX_ACCOUNTS: '0' }, /TRIAL_MAX_ACCOUNTS=0/)
    bad({ TRIAL_ACCOUNTS: '1', TRIAL_PER_IP_PER_DAY: '-1' }, /TRIAL_PER_IP_PER_DAY=-1/)
    bad({ TRIAL_LIFETIME_HOURS: '500' }, /above 168/)
  })
})

describe('trial accounts: the refused routes', () => {
  it('a listed route is refused by method and pattern; anything else passes', () => {
    assert.equal(trialRestriction('POST', '/api/pages/:id/share', {}), 'public')
    assert.equal(trialRestriction('post', '/api/workspaces', undefined), 'workspace')
    assert.equal(trialRestriction('POST', '/api/workspaces/join', {}), 'join')
    assert.equal(trialRestriction('DELETE', '/api/pages/:id/share', {}), null)
    assert.equal(trialRestriction('GET', '/api/pages/:id/share', {}), null)
    assert.equal(trialRestriction('POST', '/api/pages', {}), null)
    assert.equal(trialRestriction('POST', undefined, {}), null)
  })

  it('workspace settings: refused only when turning the invite link on', () => {
    const { method, url } = TRIAL_INVITE_LINK_ROUTE
    assert.equal(trialRestriction(method, url, { inviteLinkEnabled: true }), 'members')
    assert.equal(trialRestriction(method, url, { inviteLinkEnabled: false }), null)
    assert.equal(trialRestriction(method, url, { name: 'x' }), null)
    assert.equal(trialRestriction(method, url, null), null)
  })

  it('every refused route exists in the source (a typo would be a silent hole) and appears once', () => {
    const found = new Set(writeRoutesInSource().map(key))
    const missing = TRIAL_RESTRICTED_ROUTES.filter((r) => !found.has(`${r.method} ${withoutApi(r.url)}`)).map(key)
    assert.deepEqual(missing, [])
    assert.ok(found.has(`${TRIAL_INVITE_LINK_ROUTE.method} ${withoutApi(TRIAL_INVITE_LINK_ROUTE.url)}`))
    assert.equal(new Set(TRIAL_RESTRICTED_ROUTES.map(key)).size, TRIAL_RESTRICTED_ROUTES.length)
    for (const r of TRIAL_RESTRICTED_ROUTES) assert.match(r.url, /^\/api\//, key(r))
  })

  it('sweep: each write route that publishes, invites, joins, sends out or signs in is refused or reviewed', () => {
    const refused = new Set(TRIAL_RESTRICTED_ROUTES.map((r) => `${r.method} ${withoutApi(r.url)}`))
    const unreviewed: string[] = []
    const seen = new Set<string>()
    for (const r of writeRoutesInSource()) {
      // the admin API: requireAdmin, and a trial account is never an admin
      if (r.url.startsWith('/admin/')) continue
      if (!SENSITIVE_FILES.has(r.file) && !SENSITIVE_PATH.test(r.url)) continue
      const k = key(r)
      seen.add(k)
      if (!refused.has(k) && !(k in TRIAL_REVIEWED_ALLOWED)) unreviewed.push(`${k} (${r.file})`)
    }
    assert.deepEqual(unreviewed, [], 'add each to TRIAL_RESTRICTED_ROUTES (trial.ts) or, with a reason, to TRIAL_REVIEWED_ALLOWED')
    // a reviewed entry for a route that no longer exists is stale
    assert.deepEqual(Object.keys(TRIAL_REVIEWED_ALLOWED).filter((k) => !seen.has(k)), [])
    // the sweep sees the routes it is about
    for (const k of ['POST /pages/:id/share', 'POST /workspaces/:id/webhooks', 'PUT /workspaces/:id/slack', 'POST /collection-views/:id/form-link']) assert.ok(seen.has(k), k)
  })

  it('MCP tools: no tool calls a refused route (they reach REST through the gated routes only)', () => {
    const dir = path.join(src, 'mcpTools')
    const calls: string[] = []
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.ts') || f.endsWith('.test.ts') || f === 'testHarness.ts') continue
      const text = readFileSync(path.join(dir, f), 'utf8')
      const re = /'(POST|PUT|PATCH|DELETE)',\s*(['`])(\/api\/[^'`]*)\2/g
      let m: RegExpExecArray | null
      while ((m = re.exec(text))) calls.push(`${m[1]} ${m[3]}`)
    }
    assert.ok(calls.length > 10, `${calls.length} write calls found`)
    // a template like `/api/pages/${id}/share` against the pattern `/api/pages/:id/share`
    const asRegex = (url: string) => new RegExp(`^${url.replace(/:[A-Za-z]+/g, '[^/]+').replace(/\//g, '\\/')}$`)
    const hits = calls.filter((c) => {
      const [method, url] = c.split(' ')
      const concrete = url.replace(/\$\{[^}]+\}/g, 'x')
      return TRIAL_RESTRICTED_ROUTES.some((r) => r.method === method && asRegex(r.url).test(concrete))
    })
    assert.deepEqual(hits, [])
    // and no tool writes the database itself
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.ts') || f.endsWith('.test.ts') || f === 'testHarness.ts') continue
      const text = readFileSync(path.join(dir, f), 'utf8')
      assert.ok(!/\b(db|tx)\.(insert|update|delete)\(/.test(text), `${f} writes the database directly`)
    }
  })
})
