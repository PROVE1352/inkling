// Restricted mode settings (docs/adr/2500-*): parsing every variable, the boot check against other
// settings, the boot lines, the test setter, the restore window, the admin status items, and the
// pure parts of sign-up hooks and request gates. No database.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DISABLED_FEATURE_NAMES } from '@inkling/shared'
import {
  accountLifetimeLine,
  assertLimitsCompatible,
  isFeatureDisabled,
  limits,
  limitsBootLines,
  LimitsConfigError,
  parseLimitsEnv,
  setLimitsForTests,
  workspaceRestoreDays,
  type Limits,
} from './limits'
import { workspaceRestoreMs } from './workspaceLive'
import { evaluateStatus, type StatusFacts } from './status/evaluate'
import { GATE_EXEMPT_ROUTES, hasRequestGates, isGateExempt, registerRequestGate, runRequestGates } from './requestGates'
import { hasSignupHooks, registerSignupHook, runBeforeSignup } from './signupHooks'
import type { AuthUser } from './auth'

const INERT: Omit<Limits, 'warnings'> = {
  loginIdMode: 'email',
  signupMaxUsers: null,
  signupPerIpPerDay: null,
  accountLifetimeDays: null,
  accountLifetimeDryRun: false,
  workspacesPerUser: null,
  membersPerWorkspace: null,
  pagesPerWorkspace: null,
  fileMb: null,
  workspaceStorageMb: null,
  versionsPerPage: null,
  disabledFeatures: [],
  workspaceRestoreDays: 30,
  legalDir: null,
  instanceLabel: null,
}

const bad = (env: Record<string, string>, re: RegExp) =>
  assert.throws(() => parseLimitsEnv(env), (err: unknown) => err instanceof LimitsConfigError && re.test(err.message))

describe('parseLimitsEnv', () => {
  it('nothing set (or only empty strings) is the 0.21.1 server: no limit, nothing off', () => {
    assert.deepEqual(parseLimitsEnv({}), { ...INERT, warnings: [] })
    const empty: Record<string, string> = {}
    for (const k of [
      'LOGIN_ID_MODE', 'SIGNUP_MAX_USERS', 'SIGNUP_PER_IP_PER_DAY', 'ACCOUNT_LIFETIME_DAYS', 'ACCOUNT_LIFETIME_DRY_RUN',
      'LIMIT_WORKSPACES_PER_USER', 'LIMIT_MEMBERS_PER_WORKSPACE', 'LIMIT_PAGES_PER_WORKSPACE', 'LIMIT_FILE_MB',
      'LIMIT_WORKSPACE_STORAGE_MB', 'LIMIT_VERSIONS_PER_PAGE', 'DISABLED_FEATURES', 'WORKSPACE_RESTORE_DAYS', 'LEGAL_DIR', 'INSTANCE_LABEL',
    ]) empty[k] = '  '
    assert.deepEqual(parseLimitsEnv(empty), { ...INERT, warnings: [] })
  })

  it('this process (no restricted settings in the test environment) is inert', () => {
    assert.deepEqual({ ...limits, warnings: [] }, { ...INERT, warnings: [] })
  })

  it('reads every variable', () => {
    const l = parseLimitsEnv({
      LOGIN_ID_MODE: 'Username',
      SIGNUP_MAX_USERS: '50',
      SIGNUP_PER_IP_PER_DAY: '2',
      ACCOUNT_LIFETIME_DAYS: '14',
      ACCOUNT_LIFETIME_DRY_RUN: '1',
      LIMIT_WORKSPACES_PER_USER: '2',
      LIMIT_MEMBERS_PER_WORKSPACE: '4',
      LIMIT_PAGES_PER_WORKSPACE: '300',
      LIMIT_FILE_MB: '2.5',
      LIMIT_WORKSPACE_STORAGE_MB: '20',
      LIMIT_VERSIONS_PER_PAGE: '10',
      DISABLED_FEATURES: 'webhooks, public-links,WEBHOOKS  ical',
      WORKSPACE_RESTORE_DAYS: '7',
      LEGAL_DIR: '/legal',
      INSTANCE_LABEL: ' 데모 ',
    })
    assert.deepEqual(l, {
      loginIdMode: 'username',
      signupMaxUsers: 50,
      signupPerIpPerDay: 2,
      accountLifetimeDays: 14,
      accountLifetimeDryRun: true,
      workspacesPerUser: 2,
      membersPerWorkspace: 4,
      pagesPerWorkspace: 300,
      fileMb: 2.5,
      workspaceStorageMb: 20,
      versionsPerPage: 10,
      disabledFeatures: ['ical', 'public-links', 'webhooks'],
      workspaceRestoreDays: 7,
      legalDir: '/legal',
      instanceLabel: '데모',
      warnings: [],
    })
  })

  it('every documented feature name is accepted', () => {
    const l = parseLimitsEnv({ DISABLED_FEATURES: DISABLED_FEATURE_NAMES.join(',') })
    assert.deepEqual(l.disabledFeatures, [...DISABLED_FEATURE_NAMES].sort())
  })

  it('refuses values it cannot take as written', () => {
    bad({ LOGIN_ID_MODE: 'phone' }, /LOGIN_ID_MODE=phone/)
    for (const name of [
      'SIGNUP_MAX_USERS', 'SIGNUP_PER_IP_PER_DAY', 'ACCOUNT_LIFETIME_DAYS', 'LIMIT_WORKSPACES_PER_USER',
      'LIMIT_MEMBERS_PER_WORKSPACE', 'LIMIT_PAGES_PER_WORKSPACE', 'LIMIT_VERSIONS_PER_PAGE', 'WORKSPACE_RESTORE_DAYS',
    ]) {
      for (const v of ['0', '-1', '1.5', 'ten', '1e3', '0x10']) bad({ [name]: v }, new RegExp(`^${name}=`))
    }
    for (const name of ['LIMIT_FILE_MB', 'LIMIT_WORKSPACE_STORAGE_MB']) {
      for (const v of ['0', '-5', 'big', '1e2', 'Infinity', '0.0000000001']) bad({ [name]: v }, new RegExp(`^${name}=`))
    }
    bad({ ACCOUNT_LIFETIME_DRY_RUN: 'yes' }, /ACCOUNT_LIFETIME_DRY_RUN=yes/)
    bad({ INSTANCE_LABEL: 'x'.repeat(21) }, /INSTANCE_LABEL is longer than 20/)
    bad({ INSTANCE_LABEL: 'Demo\nserver' }, /control character/)
  })

  it('LIMIT_FILE_MB can only lower the 25 MB cap; LIMIT_VERSIONS_PER_PAGE the 50 versions', () => {
    assert.equal(parseLimitsEnv({ LIMIT_FILE_MB: '25' }).fileMb, 25)
    bad({ LIMIT_FILE_MB: '25.5' }, /LIMIT_FILE_MB=25.5 is above 25/)
    bad({ LIMIT_FILE_MB: '100' }, /above 25/)
    assert.equal(parseLimitsEnv({ LIMIT_VERSIONS_PER_PAGE: '50' }).versionsPerPage, 50)
    bad({ LIMIT_VERSIONS_PER_PAGE: '51' }, /above 50/)
  })

  it('an unknown feature name refuses to boot and lists the known ones', () => {
    bad({ DISABLED_FEATURES: 'webhooks,public-link' }, /unknown name\(s\): public-link .*known: public-links/)
  })

  it('a 20-character label counts characters, not bytes', () => {
    assert.equal(parseLimitsEnv({ INSTANCE_LABEL: '가'.repeat(20) }).instanceLabel, '가'.repeat(20))
  })

  it('dry run without a lifetime is a warning, not an error', () => {
    assert.deepEqual(parseLimitsEnv({ ACCOUNT_LIFETIME_DRY_RUN: '1' }).warnings, ['ACCOUNT_LIFETIME_DRY_RUN=1 does nothing without ACCOUNT_LIFETIME_DAYS'])
    assert.equal(parseLimitsEnv({ ACCOUNT_LIFETIME_DRY_RUN: '0' }).accountLifetimeDryRun, false)
  })
})

describe('boot check against other settings', () => {
  const off = { delegated: false, oidc: false, mail: false }
  const username = parseLimitsEnv({ LOGIN_ID_MODE: 'username', DISABLED_FEATURES: 'password-reset' })

  it('email mode never conflicts', () => {
    assert.doesNotThrow(() => assertLimitsCompatible(parseLimitsEnv({}), { delegated: true, oidc: true, mail: true }))
  })

  it('username mode needs delegated sign-in, OIDC and mail off and password reset disabled', () => {
    assert.doesNotThrow(() => assertLimitsCompatible(username, off))
    const refuse = (l: Limits, ctx: typeof off, re: RegExp) =>
      assert.throws(() => assertLimitsCompatible(l, ctx), (e: unknown) => e instanceof LimitsConfigError && re.test(e.message))
    refuse(username, { ...off, delegated: true }, /DELEGATED_AUTH_URL is set/)
    refuse(username, { ...off, oidc: true }, /OIDC sign-in is configured/)
    refuse(username, { ...off, mail: true }, /SMTP mail is configured/)
    refuse(parseLimitsEnv({ LOGIN_ID_MODE: 'username' }), off, /does not include password-reset/)
    // every reason at once, so the operator fixes them in one go
    refuse(parseLimitsEnv({ LOGIN_ID_MODE: 'username' }), { delegated: true, oidc: true, mail: true }, /DELEGATED.*OIDC.*SMTP.*password-reset/)
  })
})

describe('boot lines', () => {
  it('nothing set: no line', () => {
    assert.deepEqual(limitsBootLines(parseLimitsEnv({})), [])
    assert.equal(accountLifetimeLine(parseLimitsEnv({}), 13), null)
  })

  it('one line for limits, one for features; the lifetime line counts the accounts it leaves alone', () => {
    const l = parseLimitsEnv({ SIGNUP_MAX_USERS: '50', LIMIT_FILE_MB: '5', DISABLED_FEATURES: 'slack,ical', INSTANCE_LABEL: 'Demo', ACCOUNT_LIFETIME_DAYS: '14' })
    assert.deepEqual(limitsBootLines(l), [
      'restricted mode: 50 accounts in total, 5 MB per uploaded file, instance label "Demo"',
      'features turned off: ical, slack',
    ])
    assert.equal(accountLifetimeLine(l, 13), 'accounts created from now on expire after 14 days; 13 existing accounts are not affected')
    assert.match(accountLifetimeLine({ ...l, accountLifetimeDryRun: true }, 0) ?? '', /dry run/)
  })
})

describe('module settings', () => {
  it('setLimitsForTests changes the live values and puts them back', () => {
    assert.equal(isFeatureDisabled('webhooks'), false)
    assert.equal(workspaceRestoreDays(), 30)
    assert.equal(workspaceRestoreMs(), 30 * 86_400_000)
    const restore = setLimitsForTests({ disabledFeatures: ['webhooks'], workspaceRestoreDays: 7 })
    try {
      assert.equal(isFeatureDisabled('webhooks'), true)
      assert.equal(isFeatureDisabled('slack'), false)
      assert.equal(workspaceRestoreMs(), 7 * 86_400_000)
    } finally {
      restore()
    }
    assert.equal(isFeatureDisabled('webhooks'), false)
    assert.equal(workspaceRestoreMs(), 30 * 86_400_000)
  })
})

// --- admin status items (docs/adr/1230-*) ---------------------------------------------------------

const NOW = Date.parse('2026-11-12T12:00:00Z')
function facts(security: Partial<StatusFacts['security']> = {}): StatusFacts {
  return {
    now: NOW,
    isProd: true,
    backup: { configured: false, alert: null, stale: false, status: null },
    disks: { data: null, backups: null, sameDisk: false },
    dbBytes: null,
    uploads: null,
    largePages: null,
    uptimeSec: 3600,
    version: '0.22.0',
    restarts: { available: true, restarts24h: 0, unclean24h: 0, lastUncleanAt: null },
    errors: { sinceBoot: 0, last24h: 0, lastHour: 0, lastAt: null },
    migrations: { applied: 63, expected: 63, latest: '0062_limits_accounts' },
    security: {
      secretKey: true,
      plaintextSecrets: 0,
      sealedSecrets: 0,
      publicUrl: true,
      publicUrlHttps: true,
      cookieSecure: true,
      signupRequiresKey: true,
      delegated: false,
      oidcEnabled: false,
      oidcOpenAutoCreate: false,
      dbPasswordWeak: null,
      ...security,
    },
    update: { enabled: false, current: '0.22.0', latest: null, updateAvailable: false, securityFix: null },
  }
}
const securityItems = (f: StatusFacts) => evaluateStatus(f).groups.find((g) => g.id === 'security')!.items
const keys = (f: StatusFacts) => securityItems(f).map((i) => i.key)
const restricted = (r: Partial<NonNullable<StatusFacts['security']['restricted']>> = {}) => ({
  signupMaxUsers: null,
  accountLifetimeDays: null,
  accountLifetimeDryRun: false,
  ...r,
})

describe('admin status: restricted mode items', () => {
  it('without the facts (or with nothing set) the security items are those of 0.21.1', () => {
    const before = keys(facts())
    assert.ok(!before.includes('security.signupCap') && !before.includes('security.accountLifetime'))
    assert.deepEqual(keys(facts({ restricted: restricted() })), before)
  })

  it('open sign-up without an account cap warns in production; with a cap it is ok', () => {
    const open = (r: ReturnType<typeof restricted>) => securityItems(facts({ signupRequiresKey: false, restricted: r })).find((i) => i.key === 'security.signupCap')
    assert.deepEqual(open(restricted()), { key: 'security.signupCap', group: 'security', level: 'warn', data: { max: null } })
    assert.equal(open(restricted({ signupMaxUsers: 50 }))?.level, 'ok')
    // a key or delegated sign-in already closes sign-up: no item
    assert.ok(!keys(facts({ restricted: restricted() })).includes('security.signupCap'))
    assert.ok(!keys(facts({ signupRequiresKey: false, delegated: true, restricted: restricted() })).includes('security.signupCap'))
  })

  it('account lifetime is shown when on; its dry run is a warning', () => {
    const life = (r: ReturnType<typeof restricted>) => securityItems(facts({ restricted: r })).find((i) => i.key === 'security.accountLifetime')
    assert.deepEqual(life(restricted({ accountLifetimeDays: 14 })), {
      key: 'security.accountLifetime',
      group: 'security',
      level: 'ok',
      data: { days: 14, dryRun: false },
    })
    assert.equal(life(restricted({ accountLifetimeDays: 14, accountLifetimeDryRun: true }))?.level, 'warn')
    assert.equal(life(restricted({ accountLifetimeDryRun: true }))?.level, 'warn')
  })
})

// --- pure parts of the plug points -----------------------------------------------------------------

describe('request gates (pure)', () => {
  it('exempt routes: sign-out, who am I, legal texts and consent, account deletion', () => {
    assert.ok(isGateExempt('POST', '/api/auth/logout'))
    assert.ok(isGateExempt('GET', '/api/auth/me'))
    assert.ok(isGateExempt('HEAD', '/api/auth/me'))
    assert.ok(isGateExempt('GET', '/api/legal'))
    assert.ok(isGateExempt('GET', '/api/legal/:doc'))
    assert.ok(isGateExempt('POST', '/api/legal/consent'))
    assert.ok(isGateExempt('DELETE', '/api/me'))
    assert.ok(isGateExempt('GET', '/api/me/delete-preview'))
    // near misses are gated
    assert.ok(!isGateExempt('PATCH', '/api/auth/me/locale'))
    assert.ok(!isGateExempt('POST', '/api/auth/me'))
    assert.ok(!isGateExempt('GET', '/api/legalese'))
    assert.ok(!isGateExempt('GET', '/api/me'))
    assert.ok(!isGateExempt('GET', '/api/workspaces'))
    assert.ok(!isGateExempt('GET', undefined))
    assert.equal(GATE_EXEMPT_ROUTES.length, 5)
  })

  it('gates run in order, the first refusal decides, and unregistering empties the list', async () => {
    assert.equal(hasRequestGates(), false)
    const seen: string[] = []
    const offA = registerRequestGate('a', () => {
      seen.push('a')
    })
    const offB = registerRequestGate('b', () => {
      seen.push('b')
      throw new Error('no')
    })
    const offC = registerRequestGate('c', () => {
      seen.push('c')
    })
    assert.throws(() => registerRequestGate('a', () => {}), /already registered/)
    const user = { id: 'u', email: 'e', name: 'n', isAdmin: false } satisfies AuthUser
    await assert.rejects(runRequestGates({ user, req: null, via: 'collab', channel: 'collab' }), /no/)
    assert.deepEqual(seen, ['a', 'b'])
    offA()
    offB()
    offC()
    assert.equal(hasRequestGates(), false)
  })
})

describe('sign-up hooks (pure)', () => {
  it('before hooks run in order; names are unique; unregistering empties the list', async () => {
    assert.equal(hasSignupHooks(), false)
    const seen: string[] = []
    const off1 = registerSignupHook('one', { before: () => void seen.push('one') })
    const off2 = registerSignupHook('two', { on: () => void seen.push('on-only') })
    const off3 = registerSignupHook('three', { before: async () => void seen.push('three') })
    assert.throws(() => registerSignupHook('one', {}), /already registered/)
    await runBeforeSignup({} as never)
    assert.deepEqual(seen, ['one', 'three'])
    off1()
    off2()
    off3()
    assert.equal(hasSignupHooks(), false)
  })
})

// --- registration places of the pieces (docs/adr/2503-*) ---------------------------------------------

describe('restricted-mode registration places', () => {
  it('housekeeping jobs run in order and one that throws does not stop the next', async () => {
    const { registerHousekeepingTask, runRegisteredHousekeepingTasks } = await import('./restrictedExtras')
    const ran: string[] = []
    const logs: string[] = []
    const offs = [
      registerHousekeepingTask('first', async () => void ran.push('first')),
      registerHousekeepingTask('broken', async () => {
        ran.push('broken')
        throw new Error('disk on fire')
      }),
      registerHousekeepingTask('last', async () => void ran.push('last')),
    ]
    assert.throws(() => registerHousekeepingTask('first', async () => {}), /already registered/)
    await runRegisteredHousekeepingTasks((m) => logs.push(m))
    assert.deepEqual(ran, ['first', 'broken', 'last'])
    assert.deepEqual(logs, ['[inkling] housekeeping task broken failed: Error: disk on fire'])
    for (const off of offs) off()
    ran.length = 0
    await runRegisteredHousekeepingTasks((m) => logs.push(m))
    assert.deepEqual(ran, [])
  })

  it('auth/mode and me extras: none = {}, several merge in order, names are unique', async () => {
    const x = await import('./restrictedExtras')
    const user = { id: 'u1', email: 'e', name: 'n', isAdmin: false }
    assert.deepEqual(await x.authModeExtraFields(), {})
    assert.deepEqual(await x.meExtraFields(user), {})
    const a = x.registerAuthModeExtra('a', () => ({ instanceLabel: 'A' }))
    const b = x.registerAuthModeExtra('b', async () => ({ instanceLabel: 'B', signupFull: true }))
    const m = x.registerMeExtra('m', async (u) => ({ expiresAt: `for ${u.id}` }))
    assert.throws(() => x.registerAuthModeExtra('a', () => ({})), /already registered/)
    assert.throws(() => x.registerMeExtra('m', () => ({})), /already registered/)
    assert.deepEqual(await x.authModeExtraFields(), { instanceLabel: 'B', signupFull: true })
    assert.deepEqual(await x.meExtraFields(user), { expiresAt: 'for u1' })
    a()
    b()
    m()
    assert.deepEqual(await x.authModeExtraFields(), {})
    assert.deepEqual(await x.meExtraFields(user), {})
  })

  it('registerRestrictedMode can run for several apps in one process', async () => {
    const Fastify = (await import('fastify')).default
    const { registerRestrictedMode } = await import('./restricted')
    for (let i = 0; i < 2; i++) {
      const app = Fastify()
      await app.register(async (api) => registerRestrictedMode(api), { prefix: '/api' })
      await app.ready()
      await app.close()
    }
  })
})
