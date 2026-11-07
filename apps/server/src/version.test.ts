// Build id / release check helpers (docs/adr/0990-*, 0994-*). Pure: no server, no network.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { isNewerRelease, normalizeVersion, parseRelease, readBuildId, sanitizeBuild } from './version'

describe('build id', () => {
  it('reads WEB_DIST/build.json before the env fallback', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'inkling-build-'))
    try {
      assert.equal(readBuildId(dir, 'from-env'), 'from-env')
      writeFileSync(path.join(dir, 'build.json'), JSON.stringify({ build: 'a1b2c3d4e5f6' }))
      assert.equal(readBuildId(dir, 'from-env'), 'a1b2c3d4e5f6')
      writeFileSync(path.join(dir, 'build.json'), '{not json')
      assert.equal(readBuildId(dir, null), null)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
    assert.equal(readBuildId(undefined, null), null)
  })

  it('keeps header-safe characters only', () => {
    assert.equal(sanitizeBuild(' 1a2b\r\nX-Evil: 1 '), '1a2bX-Evil1')
    assert.equal(sanitizeBuild('v1.2.3-rc_1'), 'v1.2.3-rc_1')
    assert.equal(sanitizeBuild(''), null)
    assert.equal(sanitizeBuild(42), null)
    assert.equal(sanitizeBuild('x'.repeat(100))?.length, 40)
  })
})

describe('release check', () => {
  it('parses GitHub releases/latest', () => {
    assert.deepEqual(parseRelease({ tag_name: 'v0.3.0', html_url: 'https://github.com/o/r/releases/tag/v0.3.0' }), {
      version: '0.3.0',
      url: 'https://github.com/o/r/releases/tag/v0.3.0',
    })
    assert.deepEqual(parseRelease({ tag_name: '1.0.0', html_url: 'javascript:alert(1)' }), { version: '1.0.0', url: '' })
    assert.equal(parseRelease({ tag_name: 'nightly' }), null)
    assert.equal(parseRelease({ tag_name: 'v2.0.0', prerelease: true }), null)
    assert.equal(parseRelease(null), null)
  })

  it('compares versions', () => {
    assert.equal(normalizeVersion('V1.2.3'), '1.2.3')
    assert.equal(isNewerRelease('0.2.0', '0.1.0'), true)
    assert.equal(isNewerRelease('0.1.0', '0.1.0'), false)
    assert.equal(isNewerRelease('0.0.9', '0.1.0'), false)
    assert.equal(isNewerRelease(null, '0.1.0'), false)
    assert.equal(isNewerRelease('0.2.0', 'custom-build'), false)
  })
})
