// Trial accounts (docs/adr/2555-*), the parts without a database: names and addresses, the TRIAL_*
// settings, the list of refused routes, and two sweeps of the source that keep that list in step with
// the routes that exist (every write route of the source is either refused or allowed below with a
// reason, so a new one fails until someone decides) and with the MCP tools (none calls a refused route,
// so the gate needs nothing MCP-specific).
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

/** Why a trial account may use a route (each write route not refused names one). */
const WHY = {
  CONTENT: "content of the person's own workspace: bounded by the workspace limits, nothing leaves the server or becomes public (sheet sync and the clipper read in through safeFetch; automations and buttons call only a registered webhook, which a trial account cannot register)",
  WORKSPACE: 'settings and members of the own workspace: no one else can be in it (joining is refused and the invite link stays off: PATCH /settings refuses inviteLinkEnabled: true)',
  STOPS: 'removes, withdraws or turns off: never publishes or brings anyone in',
  PERSON: 'about the person only: session, preferences, lists, read marks, consent, push to their own browsers (endpoint hosts checked), leaving',
  AGENTS: "the person's own agent connections and API tokens (what the demo is for); every REST call they make runs the gate",
  READS: 'a read sent as POST',
  NO_SESSION: 'no session, so no trial account behind it: sign-in routes (the reserved domain is refused there), public reads and forms, Slack calling in, OAuth client registration and tokens',
} as const

/**
 * Every write route (POST, PUT, PATCH, DELETE) of the source that a trial account may use, by reason.
 * With TRIAL_RESTRICTED_ROUTES it covers every write route: a new one fails the sweep until someone
 * puts it in one or the other (closed by default). The admin API is left out (requireAdmin; a trial
 * account is never an admin).
 */
const TRIAL_ALLOWED: Record<string, keyof typeof WHY> = {
  'POST /pages': 'CONTENT',
  'PATCH /pages/:id': 'CONTENT',
  'DELETE /pages/:id': 'CONTENT',
  'DELETE /pages/:id/purge': 'CONTENT',
  'POST /pages/:id/duplicate': 'CONTENT',
  'POST /pages/:id/expand-canvas': 'CONTENT',
  'POST /pages/:id/restore': 'CONTENT',
  'PATCH /pages/:id/props': 'CONTENT',
  'PUT /pages/:id/collection/fields': 'CONTENT',
  'POST /pages/:id/collection/views': 'CONTENT',
  'PATCH /collection-views/:id': 'CONTENT',
  'DELETE /collection-views/:id': 'CONTENT',
  'PATCH /pages/:id/collection/rows/batch': 'CONTENT',
  'POST /pages/:id/collection/rows/batch': 'CONTENT',
  'POST /pages/:id/collection/rows': 'CONTENT',
  'POST /pages/:id/collection/row-templates': 'CONTENT',
  'PATCH /collection-row-templates/:id': 'CONTENT',
  'DELETE /collection-row-templates/:id': 'CONTENT',
  'POST /pages/:id/comments': 'CONTENT',
  'PATCH /comments/:id': 'CONTENT',
  'DELETE /comments/:id': 'CONTENT',
  'POST /pages/:id/section': 'CONTENT',
  'POST /pages/:id/sections': 'CONTENT',
  'POST /pages/:id/content': 'CONTENT',
  'PUT /pages/:id/ink': 'CONTENT',
  'POST /pages/:id/snapshots': 'CONTENT',
  'POST /pages/:id/snapshots/:sid/restore': 'CONTENT',
  'POST /pages/:id/rotation/target': 'CONTENT',
  'POST /pages/:id/split': 'CONTENT',
  'PUT /pages/:id/rotation': 'CONTENT',
  'PATCH /pages/:id/tasks/:blockId': 'CONTENT',
  'POST /workspaces/:id/tasks': 'CONTENT',
  'POST /pages/from-template': 'CONTENT',
  'POST /workspaces/:id/templates': 'CONTENT',
  'POST /workspaces/:id/templates/import': 'CONTENT',
  'DELETE /templates/:id': 'CONTENT',
  'POST /workspaces/:id/import': 'CONTENT',
  'POST /workspaces/:id/import-folder': 'CONTENT',
  'POST /files': 'CONTENT',
  'POST /changes/:seq/revert': 'CONTENT',
  'POST /pages/:id/revert': 'CONTENT',
  'POST /workspaces/:id/revert': 'CONTENT',
  'POST /pages/:id/claims': 'CONTENT',
  'DELETE /pages/:id/claims': 'CONTENT',
  'POST /suggestions/:id/accept': 'CONTENT',
  'POST /suggestions/:id/reject': 'CONTENT',
  'POST /suggestions/:id/withdraw': 'CONTENT',
  'POST /pages/:id/verification': 'CONTENT',
  'DELETE /pages/:id/verification': 'CONTENT',
  'PUT /pages/:id/lock': 'CONTENT',
  'PUT /pages/:id/agent-instructions': 'CONTENT',
  'DELETE /pages/:id/agent-instructions': 'CONTENT',
  'PUT /pages/:id/agent-rules': 'CONTENT',
  'PUT /pages/:id/living': 'CONTENT',
  'PUT /pages/:id/owner': 'CONTENT',
  'POST /pages/:id/review': 'CONTENT',
  'POST /pages/:id/view': 'CONTENT',
  'POST /me/onboarding/sample': 'CONTENT',
  'POST /collections/:id/automations': 'CONTENT',
  'PATCH /collections/:id/automations/:ruleId': 'CONTENT',
  'DELETE /collections/:id/automations/:ruleId': 'CONTENT',
  'POST /pages/:id/button-webhook': 'CONTENT',
  'POST /clip': 'CONTENT',
  'PUT /pages/:id/collection/sheet-sync': 'CONTENT',
  'POST /pages/:id/collection/sheet-sync/run': 'CONTENT',
  'DELETE /pages/:id/collection/sheet-sync': 'CONTENT',
  'DELETE /pages/:id/sync': 'CONTENT',
  'POST /workspaces/:id/sync/pages': 'CONTENT',
  'POST /workspaces/:id/sync/read': 'CONTENT',
  'PUT /pages/:id/sync/md': 'CONTENT',
  'POST /plugins/:id/pages/:pageId/content': 'CONTENT',
  'PUT /plugins/:id/storage/:key': 'CONTENT',
  'DELETE /plugins/:id/storage/:key': 'CONTENT',
  'PATCH /workspaces/:id': 'WORKSPACE',
  'DELETE /workspaces/:id': 'WORKSPACE',
  'DELETE /workspaces/:id/permanent': 'WORKSPACE',
  'POST /workspaces/:id/restore': 'WORKSPACE',
  'PATCH /workspaces/:id/settings': 'WORKSPACE',
  'PUT /workspaces/:id/settings/agent-ink': 'WORKSPACE',
  'PUT /workspaces/:id/settings/two-factor': 'WORKSPACE',
  'PUT /workspaces/:id/settings/agent-taint': 'WORKSPACE',
  'PUT /workspaces/:id/settings/agent-uploads': 'WORKSPACE',
  'PUT /workspaces/:id/agent-policy': 'WORKSPACE',
  'POST /workspaces/:id/agents/blocks': 'WORKSPACE',
  'DELETE /workspaces/:id/agents/blocks/:blockId': 'WORKSPACE',
  'POST /workspaces/:id/agent-connections/release': 'WORKSPACE',
  'PATCH /workspaces/:id/members/:userId': 'WORKSPACE',
  'DELETE /workspaces/:id/members/:userId': 'WORKSPACE',
  'PUT /workspaces/:id/notification-level': 'WORKSPACE',
  'DELETE /pages/:id/share': 'STOPS',
  'DELETE /collection-views/:id/form-link': 'STOPS',
  'POST /workspaces/:id/shared/unpublish': 'STOPS',
  'DELETE /me/ical': 'STOPS',
  'DELETE /pages/:id/access/:userId': 'STOPS',
  'DELETE /pages/:id/invites/:inviteId': 'STOPS',
  'POST /workspaces/:id/guests/remove': 'STOPS',
  'DELETE /webhooks/:id': 'STOPS',
  'DELETE /workspaces/:id/slack': 'STOPS',
  'DELETE /workspaces/:id/slack/links/:userId': 'STOPS',
  'POST /auth/2fa/disable': 'STOPS',
  'POST /auth/2fa/recovery-codes': 'STOPS',
  'PATCH /auth/me/locale': 'PERSON',
  'POST /auth/logout': 'PERSON',
  'DELETE /me': 'PERSON',
  'PATCH /me/onboarding': 'PERSON',
  'PUT /me/sidebar': 'PERSON',
  'PUT /me/status': 'PERSON',
  'DELETE /me/status': 'PERSON',
  'PATCH /me/notification-settings': 'PERSON',
  'PUT /pages/:id/subscription': 'PERSON',
  'POST /notifications/read': 'PERSON',
  'POST /inbox/ack': 'PERSON',
  'POST /later': 'PERSON',
  'PATCH /later/:id': 'PERSON',
  'DELETE /later/:id': 'PERSON',
  'POST /threads/:id/read': 'PERSON',
  'PUT /threads/:id/follow': 'PERSON',
  'POST /pages/:id/bookmark': 'PERSON',
  'POST /me/workspace-groups': 'PERSON',
  'PATCH /me/workspace-groups/:id': 'PERSON',
  'DELETE /me/workspace-groups/:id': 'PERSON',
  'POST /me/workspace-groups/:id/archive': 'PERSON',
  'PUT /me/workspace-groups/order': 'PERSON',
  'PUT /me/workspace-order': 'PERSON',
  'PATCH /me/workspaces/:id/listing': 'PERSON',
  'POST /legal/consent': 'PERSON',
  'POST /push/subscriptions': 'PERSON',
  'DELETE /push/subscriptions': 'PERSON',
  'DELETE /push/devices/:id': 'PERSON',
  'PATCH /push/settings': 'PERSON',
  'POST /push/test': 'PERSON',
  'POST /tokens': 'AGENTS',
  'PATCH /tokens/:id': 'AGENTS',
  'DELETE /tokens/:id': 'AGENTS',
  'POST /agent-tokens': 'AGENTS',
  'DELETE /agent-tokens/:id': 'AGENTS',
  'PATCH /oauth/grants/:id': 'AGENTS',
  'DELETE /oauth/grants/:id': 'AGENTS',
  'POST /oauth/authorize': 'AGENTS',
  'POST /mcp': 'AGENTS',
  'DELETE /mcp': 'AGENTS',
  'POST /connections/release': 'AGENTS',
  'POST /workspaces/:id/query': 'READS',
  'POST /workspaces/:id/charts/aggregate': 'READS',
  'POST /auth/register': 'NO_SESSION',
  'POST /auth/login': 'NO_SESSION',
  'POST /auth/login/totp': 'NO_SESSION',
  'POST /auth/forgot-password': 'NO_SESSION',
  'POST /auth/reset-password': 'NO_SESSION',
  'POST /auth/verify-email': 'NO_SESSION',
  'POST /auth/verify-email/send': 'NO_SESSION',
  'POST /auth/trial': 'NO_SESSION',
  'POST /oauth/register': 'NO_SESSION',
  'POST /oauth/token': 'NO_SESSION',
  'POST /public/:token/unlock': 'NO_SESSION',
  'POST /public/forms/:token': 'NO_SESSION',
  'POST /slack/w/:workspaceId/commands': 'NO_SESSION',
  'POST /slack/w/:workspaceId/events': 'NO_SESSION',
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

  it('the instance storage fuse refuses POST /api/auth/trial (it is not on the open list)', async () => {
    const { refusedWhenFull, OPEN_WHEN_FULL } = await import('../quota/instanceGate')
    assert.equal(refusedWhenFull({ method: 'POST', url: '/api/auth/trial', routeOptions: { url: '/api/auth/trial' } } as never), true)
    assert.ok(!OPEN_WHEN_FULL.includes('POST /api/auth/trial'))
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

  it('closed sweep: every write route of the source is refused or allowed with a reason, never both, none stale', () => {
    const refused = new Set(TRIAL_RESTRICTED_ROUTES.map((r) => `${r.method} ${withoutApi(r.url)}`))
    const routes = writeRoutesInSource()
    assert.ok(routes.length > 180, `${routes.length} write routes found`)
    const unclassified: string[] = []
    const both: string[] = []
    const seen = new Set<string>()
    for (const r of routes) {
      const k = key(r)
      seen.add(k)
      // the admin API: requireAdmin, and a trial account is never an admin
      if (r.url.startsWith('/admin/')) continue
      const isRefused = refused.has(k)
      const isAllowed = k in TRIAL_ALLOWED
      if (isRefused && isAllowed) both.push(k)
      if (!isRefused && !isAllowed) unclassified.push(`${k} (${r.file})`)
    }
    assert.deepEqual(unclassified, [], 'a new write route: add it to TRIAL_RESTRICTED_ROUTES (account/trial.ts) or, with a reason, to TRIAL_ALLOWED here')
    assert.deepEqual(both, [])
    assert.deepEqual(Object.keys(TRIAL_ALLOWED).filter((k) => !seen.has(k)), [], 'allowed but no longer a route')
    for (const why of Object.values(TRIAL_ALLOWED)) assert.ok(WHY[why].length > 10)
  })

  it('the extraction finds what the quota sweep finds (same source, DELETE added)', () => {
    // quota/writeSweep.test.ts reads POST/PUT/PATCH with `(app|api|s|inner|root|scope).method(`; this
    // sweep reads any receiver, so it can only find more
    const ours = new Set(writeRoutesInSource().map(key))
    const re = /\b(?:app|api|s|inner|root|scope)\.(post|put|patch|delete)(?:<[^>]*>)?\(\s*(['`])([^'`]+)\2/g
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const f of readdirSync(dir)) {
        const p = path.join(dir, f)
        if (statSync(p).isDirectory()) walk(p, out)
        else if (p.endsWith('.ts') && !p.endsWith('.test.ts') && !/TestKit|testHarness|Fixture|fixture/.test(p)) out.push(p)
      }
      return out
    }
    const missed: string[] = []
    for (const file of walk(src)) {
      const text = readFileSync(file, 'utf8')
      let m: RegExpExecArray | null
      while ((m = re.exec(text))) if (m[3].startsWith('/') && !ours.has(`${m[1].toUpperCase()} ${m[3]}`)) missed.push(`${m[1].toUpperCase()} ${m[3]}`)
    }
    assert.deepEqual(missed, [])
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
