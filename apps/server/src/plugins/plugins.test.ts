// Run: cd apps/server && npx tsx --test src/plugins/plugins.test.ts
// Pure tests (no DB): manifest validation, on-disk confinement, frame CSP/HTML.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { frameCsp, frameHtml, SDK_SOURCE } from './frame'
import { compareSemver, parseManifest } from './manifest'
import { contentHash, loadPluginDir, scanPluginsDir } from './registry'
import { encodeValue, validateKey } from './storage'

const base = {
  id: 'word-stats',
  name: 'Word Stats',
  version: '1.0.0',
  minAppVersion: '0.1.0',
  entry: 'main.js',
  permissions: ['commands', 'read:pages'],
  commands: [{ id: 'count', title: 'Count words' }],
}
const parse = (m: unknown, dir = 'word-stats') => parseManifest(JSON.stringify(m), dir)
const expectErr = (m: unknown, re: RegExp, dir?: string) => {
  const r = parse(m, dir)
  assert.equal(r.ok, false, 'expected manifest to be rejected')
  if (!r.ok) assert.match(r.error, re)
}

describe('parseManifest', () => {
  it('accepts a valid manifest', () => {
    const r = parse(base)
    assert.equal(r.ok, true)
  })
  it('rejects non-JSON and oversized manifests', () => {
    assert.equal(parseManifest('{nope', 'word-stats').ok, false)
    const big = JSON.stringify({ ...base, description: 'x'.repeat(70 * 1024) })
    const r = parseManifest(big, 'word-stats')
    assert.equal(r.ok, false)
  })
  it('restricts id format', () => {
    for (const id of ['A', 'Word', '../x', 'a/b', '-lead', 'a', 'x'.repeat(65), 'a_b', 'a.b']) {
      expectErr({ ...base, id }, /id/, id)
    }
  })
  it('requires id == directory name', () => {
    expectErr(base, /does not match directory/, 'other-dir')
  })
  it('blocks path traversal and non-js entries', () => {
    for (const entry of ['../main.js', '/etc/passwd', 'sub/main.js', 'sub\\main.js', '..js', 'main.ts', '.hidden.js', 'a..b.js', '']) {
      expectErr({ ...base, entry }, /entry/)
    }
  })
  it('rejects unknown / duplicate permissions', () => {
    expectErr({ ...base, permissions: ['commands', 'network'] }, /permissions/)
    expectErr({ ...base, permissions: ['commands', 'commands'] }, /repeat/)
  })
  it('rejects unknown top-level keys (strict)', () => {
    expectErr({ ...base, main: 'evil.js' }, /main|Unrecognized|unrecognized/)
  })
  it('requires matching permission for declared commands/blocks', () => {
    expectErr({ ...base, permissions: ['read:pages'] }, /requires the "commands" permission/)
    expectErr(
      { ...base, blocks: [{ type: 'progress', title: 'Progress' }] },
      /requires the "blocks" permission/,
    )
  })
  it('rejects duplicate command ids / block types', () => {
    expectErr({ ...base, commands: [{ id: 'a1', title: 'x' }, { id: 'a1', title: 'y' }] }, /unique/)
  })
  it('enforces minAppVersion', () => {
    expectErr({ ...base, minAppVersion: '99.0.0' }, /requires app/)
    assert.equal(compareSemver('0.1.0', '0.1.0'), 0)
    assert.equal(compareSemver('0.2.0', '0.10.0'), -1)
  })
  it('caps block defaultData size', () => {
    expectErr(
      {
        ...base,
        permissions: ['blocks'],
        commands: undefined,
        blocks: [{ type: 'b1', title: 'B', defaultData: { s: 'x'.repeat(5000) } }],
      },
      /4 KB/,
    )
  })
})

describe('plugin directory scan (confinement)', () => {
  let root: string
  let outside: string
  const manifest = (id: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ ...base, id, ...extra })

  before(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'inkling-plugins-'))
    outside = await mkdtemp(path.join(tmpdir(), 'inkling-outside-'))
    await writeFile(path.join(outside, 'secret.js'), 'secret')
    await writeFile(path.join(outside, 'manifest.json'), manifest('linked-dir'))

    // good
    await mkdir(path.join(root, 'good-one'))
    await writeFile(path.join(root, 'good-one', 'manifest.json'), manifest('good-one'))
    await writeFile(path.join(root, 'good-one', 'main.js'), 'console.log(1)')
    // entry symlink pointing outside the plugins root
    await mkdir(path.join(root, 'sym-entry'))
    await writeFile(path.join(root, 'sym-entry', 'manifest.json'), manifest('sym-entry'))
    await symlink(path.join(outside, 'secret.js'), path.join(root, 'sym-entry', 'main.js'))
    // manifest symlink
    await mkdir(path.join(root, 'sym-manifest'))
    await symlink(path.join(outside, 'manifest.json'), path.join(root, 'sym-manifest', 'manifest.json'))
    // whole directory symlinked
    await symlink(outside, path.join(root, 'linked-dir'))
    // id mismatch (claims another plugin's id)
    await mkdir(path.join(root, 'impostor'))
    await writeFile(path.join(root, 'impostor', 'manifest.json'), manifest('good-one'))
    await writeFile(path.join(root, 'impostor', 'main.js'), '1')
    // invalid dir names are ignored/rejected
    await mkdir(path.join(root, 'Bad.Name'))
    // missing entry
    await mkdir(path.join(root, 'no-entry'))
    await writeFile(path.join(root, 'no-entry', 'manifest.json'), manifest('no-entry'))
  })
  after(async () => {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  })

  it('loads a good plugin and hashes manifest+entry', async () => {
    const r = await loadPluginDir(root, 'good-one')
    assert.equal(r.ok, true)
    if (r.ok) {
      assert.equal(r.entry.toString(), 'console.log(1)')
      assert.equal(r.hash, contentHash(Buffer.from(manifest('good-one')), Buffer.from('console.log(1)')))
    }
  })
  it('rejects a symlinked entry that escapes the plugin dir', async () => {
    const r = await loadPluginDir(root, 'sym-entry')
    assert.equal(r.ok, false)
    if (!r.ok) assert.match(r.error, /outside|symlink/)
  })
  it('rejects a symlinked manifest', async () => {
    const r = await loadPluginDir(root, 'sym-manifest')
    assert.equal(r.ok, false)
  })
  it('rejects a symlinked plugin directory', async () => {
    const r = await loadPluginDir(root, 'linked-dir')
    assert.equal(r.ok, false)
  })
  it('rejects id/directory mismatch', async () => {
    const r = await loadPluginDir(root, 'impostor')
    assert.equal(r.ok, false)
  })
  it('rejects traversal in the directory name itself', async () => {
    for (const d of ['..', '../etc', 'a/../../b', 'Bad.Name']) {
      const r = await loadPluginDir(root, d)
      assert.equal(r.ok, false, d)
    }
  })
  it('scan lists only real directories and never throws on a missing root', async () => {
    const list = await scanPluginsDir(root)
    const ok = list.filter((p) => p.ok).map((p) => p.dirName)
    assert.deepEqual(ok, ['good-one'])
    assert.ok(!list.some((p) => p.dirName === 'linked-dir'), 'symlinked dir must be skipped')
    assert.deepEqual(await scanPluginsDir(path.join(root, 'does-not-exist')), [])
  })
  it('hash changes when the bundle changes (forces re-approval)', async () => {
    const before = await loadPluginDir(root, 'good-one')
    await writeFile(path.join(root, 'good-one', 'main.js'), 'console.log(2)')
    const afterChange = await loadPluginDir(root, 'good-one')
    assert.ok(before.ok && afterChange.ok)
    if (before.ok && afterChange.ok) assert.notEqual(before.hash, afterChange.hash)
  })
})

describe('frame document', () => {
  it('CSP: nonce-only scripts, no network, sandboxed, app-only framing', () => {
    const csp = frameCsp('N0nce')
    const d = Object.fromEntries(
      csp.split(';').map((s) => {
        const [k, ...v] = s.trim().split(/\s+/)
        return [k, v.join(' ')]
      }),
    )
    assert.equal(d['default-src'], "'none'")
    assert.equal(d['script-src'], "'nonce-N0nce'")
    assert.ok(!/unsafe-eval|unsafe-inline|strict-dynamic|\*|https?:/.test(d['script-src']))
    assert.equal(d['connect-src'], "'none'")
    assert.equal(d['frame-ancestors'], "'self'")
    assert.equal(d['form-action'], "'none'")
    assert.equal(d['sandbox'], 'allow-scripts', 'no allow-same-origin / popups / top-navigation')
  })
  it('HTML loads exactly two nonce-pinned scripts and escapes inputs', () => {
    const html = frameHtml('word-stats', 'a'.repeat(64), 'abc"<x>')
    const scripts = html.match(/<script\b[^>]*>/g) ?? []
    assert.equal(scripts.length, 2)
    for (const s of scripts) assert.match(s, /nonce="abc&quot;&lt;x&gt;"/)
    assert.ok(html.includes(`/api/plugin-frame/word-stats/${'a'.repeat(64)}/main.js`))
  })
  it('SDK only accepts the handshake from window.parent and talks over a MessagePort', () => {
    assert.match(SDK_SOURCE, /e\.source !== window\.parent/)
    assert.match(SDK_SOURCE, /e\.ports\[0\]/)
    assert.ok(!SDK_SOURCE.includes('fetch('), 'SDK must not use network APIs')
  })
})

describe('storage validation', () => {
  it('validates keys', () => {
    assert.equal(validateKey('notes.count:v1'), 'notes.count:v1')
    for (const k of ['', '../x', 'a/b', 'x'.repeat(129), 'sp ace']) {
      assert.throws(() => validateKey(k))
    }
  })
  it('caps value size at 64 KB', () => {
    assert.equal(encodeValue({ a: 1 }).bytes, 7)
    assert.throws(() => encodeValue('x'.repeat(70 * 1024)), /64 KB/)
    assert.throws(() => encodeValue(undefined))
  })
})

describe('bundled examples', () => {
  it('every plugin in examples/plugins validates', async () => {
    const dir = path.resolve(import.meta.dirname, '../../../../examples/plugins')
    const list = await scanPluginsDir(dir)
    assert.ok(list.length >= 2)
    for (const p of list) assert.equal(p.ok, true, `${p.dirName}: ${p.ok ? '' : p.error}`)
  })
  it('every test-only plugin in fixtures/ validates (security-probe)', async () => {
    const dir = path.resolve(import.meta.dirname, 'fixtures')
    const list = await scanPluginsDir(dir)
    assert.ok(list.some((p) => p.dirName === 'security-probe'))
    for (const p of list) assert.equal(p.ok, true, `${p.dirName}: ${p.ok ? '' : p.error}`)
  })
})
