// 0.22 settings passed through compose.yaml as `${VAR:-}` arrive as empty strings (0.22 integration,
// contract §13): every one of them must read exactly as unset, or the release server, which runs this
// compose file with none of them set, would fail to boot or change behaviour.
// Also: INSTANCE_NOTICE's own rules (500 characters, line breaks only), and the boot line of the two
// settings the integration adds.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { assertLimitsCompatible, limitsBootLines, LimitsConfigError, parseLimitsEnv } from '../limits'

/** Every variable 0.22 adds (limits.ts reads them all), in the order of compose.yaml. */
export const SETTINGS_022 = [
  'LOGIN_ID_MODE',
  'SIGNUP_MAX_USERS',
  'SIGNUP_PER_IP_PER_DAY',
  'ACCOUNT_LIFETIME_DAYS',
  'ACCOUNT_LIFETIME_DRY_RUN',
  'LIMIT_WORKSPACES_PER_USER',
  'LIMIT_MEMBERS_PER_WORKSPACE',
  'LIMIT_PAGES_PER_WORKSPACE',
  'LIMIT_FILE_MB',
  'LIMIT_WORKSPACE_STORAGE_MB',
  'LIMIT_VERSIONS_PER_PAGE',
  'LIMIT_TRASH_DAYS',
  'DISABLED_FEATURES',
  'WORKSPACE_RESTORE_DAYS',
  'LEGAL_DIR',
  'INSTANCE_LABEL',
  'INSTANCE_NOTICE',
  'SIGNUP_PER_HOUR',
  'OAUTH_UNUSED_CLIENT_HOURS',
  'OAUTH_UNUSED_CLIENT_MAX',
  'LIMIT_WORKSPACES_TOTAL',
  'LIMIT_INSTANCE_STORAGE_MB',
] as const

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '../../../..')

describe('0.22 settings: an empty string is the same as unset', () => {
  const unset = parseLimitsEnv({})

  for (const name of SETTINGS_022) {
    it(`${name}='' reads as unset`, () => {
      assert.deepEqual(parseLimitsEnv({ [name]: '' }), unset)
      assert.deepEqual(parseLimitsEnv({ [name]: '   ' }), unset)
    })
  }

  it('all of them empty at once: unset, no boot line, no boot conflict (LOGIN_ID_MODE= is email)', () => {
    const all = Object.fromEntries(SETTINGS_022.map((k) => [k, '']))
    const l = parseLimitsEnv(all)
    assert.deepEqual(l, unset)
    assert.equal(l.loginIdMode, 'email')
    assert.equal(l.legalDir, null)
    assert.equal(l.instanceLabel, null)
    assert.deepEqual(limitsBootLines(l), [])
    assert.doesNotThrow(() => assertLimitsCompatible(l, { delegated: true, oidc: true, mail: true }))
  })

  it('a process started with every one of them empty (as compose passes them) loads the settings as unset', () => {
    const env = { ...process.env, ...Object.fromEntries(SETTINGS_022.map((k) => [k, ''])) }
    const tsx = path.join(repo, 'apps/server/node_modules/tsx/dist/cli.mjs')
    const script = `import('./src/limits.ts').then((m) => { const { warnings, ...rest } = m.limits; console.log(JSON.stringify({ rest, warnings, lines: m.limitsBootLines(m.limits) })) })`
    const r = spawnSync(process.execPath, [tsx, '--eval', script], { cwd: path.join(repo, 'apps/server'), env, encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    const out = JSON.parse(r.stdout.trim().split('\n').pop()!)
    const { warnings: _w, ...rest } = unset
    assert.deepEqual(out, { rest: JSON.parse(JSON.stringify(rest)), warnings: [], lines: [] })
  })

  it('compose.yaml passes every 0.22 setting as ${VAR:-} and .env.example mentions each one', () => {
    const compose = readFileSync(path.join(repo, 'compose.yaml'), 'utf8')
    const example = readFileSync(path.join(repo, '.env.example'), 'utf8')
    for (const k of SETTINGS_022) {
      assert.ok(compose.includes(`${k}: \${${k}:-}`), `compose.yaml ${k}`)
      assert.match(example, new RegExp(`^# ${k}=`, 'm'), `.env.example ${k}`)
    }
  })

  it('the demo overlay passes every 0.22 setting', () => {
    const overlay = readFileSync(path.join(repo, 'deploy/demo/compose.demo.yaml'), 'utf8')
    const env = readFileSync(path.join(repo, 'deploy/demo/demo.env.example'), 'utf8')
    for (const k of SETTINGS_022) {
      if (k === 'ACCOUNT_LIFETIME_DRY_RUN') continue // the operator's first-run check, not a demo value
      assert.match(overlay, new RegExp(`^\\s+${k}: `, 'm'), `overlay ${k}`)
      if (k !== 'LEGAL_DIR') assert.match(env, new RegExp(`^${k}=`, 'm'), `demo.env.example ${k}`)
    }
  })
})

describe('INSTANCE_NOTICE', () => {
  const bad = (v: string, re: RegExp) =>
    assert.throws(() => parseLimitsEnv({ INSTANCE_NOTICE: v }), (e: unknown) => e instanceof LimitsConfigError && re.test(e.message))

  it('plain text up to 500 characters, line breaks kept (CRLF read as LF), outer spaces trimmed', () => {
    assert.equal(parseLimitsEnv({ INSTANCE_NOTICE: ' 점검 안내\n11/20 02:00–03:00 ' }).instanceNotice, '점검 안내\n11/20 02:00–03:00')
    assert.equal(parseLimitsEnv({ INSTANCE_NOTICE: 'a\r\nb\rc' }).instanceNotice, 'a\nb\nc')
    assert.equal(parseLimitsEnv({ INSTANCE_NOTICE: '가'.repeat(500) }).instanceNotice, '가'.repeat(500))
    // markup and addresses are only characters here; the screen draws them as text
    assert.equal(parseLimitsEnv({ INSTANCE_NOTICE: '<b>x</b> https://example.com' }).instanceNotice, '<b>x</b> https://example.com')
  })

  it('longer than 500 characters, or another control character, refuses to boot', () => {
    bad('가'.repeat(501), /longer than 500/)
    bad('tab\there', /control character other than a line break/)
    bad('esc\u001b[31m', /control character/)
    bad('nul\u0000', /control character/)
    bad('del\u007f', /control character/)
  })

  it('boot line: the cap and the notice length, nothing else of the text', () => {
    const l = parseLimitsEnv({ LIMIT_TRASH_DAYS: '7', INSTANCE_NOTICE: 'Maintenance on Friday' })
    assert.deepEqual(limitsBootLines(l), ['restricted mode: trash kept at most 7 days, instance notice (21 characters)'])
  })
})
