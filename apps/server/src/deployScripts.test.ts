// deploy/signup-key.sh makes keys from the operating system's random source, not bash $RANDOM
// (0.25.4 security fix A-F3 / F-6). bash's RANDOM is a 31-bit generator: seeded the same way it gives
// the same key, so a stolen key hash could be matched offline. The test runs the script's own
// gen_key function twice with the same RANDOM seed; the keys must differ and keep the key format.
// Run: cd apps/server && node ../../scripts/run-tests.mjs --test-name-pattern=signup-key
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..')
const SCRIPT = path.join(ROOT, 'deploy/signup-key.sh')

/** The gen_key function of the script, as its source text. */
function genKeySource(): string {
  const text = readFileSync(SCRIPT, 'utf8')
  const m = /^gen_key\(\) \{\n[\s\S]*?\n\}\n/m.exec(text)
  assert.ok(m, 'gen_key() not found in deploy/signup-key.sh')
  return m[0]
}

function genKey(seed: number): string {
  return execFileSync('bash', ['-c', `set -euo pipefail\n${genKeySource()}\nRANDOM=${seed}\ngen_key`], { encoding: 'utf8' })
}

describe('deploy/signup-key.sh gen_key', () => {
  it('the same bash RANDOM seed gives a different key each time (no $RANDOM)', () => {
    const a = genKey(4242)
    const b = genKey(4242)
    assert.notEqual(a, b, `two keys from one seed: ${a}`)
  })

  it('keeps the format: seven groups of four (about 138 bits) from the alphabet without 0/O/1/I/L', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 20; i++) {
      const k = genKey(i)
      assert.match(k, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}(-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}){6}$/)
      seen.add(k)
    }
    assert.equal(seen.size, 20)
  })

  it('does not call $RANDOM', () => {
    assert.doesNotMatch(genKeySource(), /\$RANDOM|\bRANDOM\b/)
  })
})
