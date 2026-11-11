// LEGAL_DIR (restricted mode, docs/adr/2519-*): reading and checking the folder, the version, the
// one-language fallback, the placeholder warning, and the demo template in deploy/demo/legal. No database.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { describeBundle, LegalConfigError, loadLegalDir, pick } from './bundle'

const dirs: string[] = []
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

const SIGNUP = {
  notice: { ko: '데모입니다.', en: 'This is a demo.' },
  items: [
    { id: 'demo_notice', required: true, label: { ko: '안내를 읽었습니다.', en: 'I read the notice.' } },
    { id: 'terms', required: true, doc: 'terms', label: { ko: '약관에 동의합니다.', en: 'I agree to the terms.' } },
    { id: 'privacy', required: true, doc: 'privacy', label: { en: 'Privacy.' }, details: { ko: '| a | b |\n|---|---|\n| 1 | 2 |' } },
    { id: 'news', required: false, label: { ko: '선택 항목', en: 'Optional' } },
  ],
}

function folder(files: Record<string, string | object>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'inkling-legal-'))
  dirs.push(dir)
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), typeof body === 'string' ? body : JSON.stringify(body))
  }
  return dir
}

const good = () =>
  folder({ 'terms.ko.md': '# 약관\n', 'terms.en.md': '# Terms\n', 'privacy.en.md': '# Privacy\n', 'signup.json': SIGNUP })

/** The reason a folder refuses to boot, with the file it names. */
function refusal(files: Record<string, string | object>): string {
  try {
    loadLegalDir(folder(files))
  } catch (err) {
    assert.ok(err instanceof LegalConfigError, String(err))
    return err.message
  }
  assert.fail('the folder was accepted')
}

describe('LEGAL_DIR folder', () => {
  it('reads the documents and sign-up items; the version is a 12-character sha256 prefix', () => {
    const b = loadLegalDir(good())
    assert.match(b.version, /^[0-9a-f]{12}$/)
    assert.deepEqual(Object.keys(b.docs).sort(), ['privacy', 'terms'])
    assert.deepEqual(b.items.map((i) => [i.id, i.required, i.doc ?? null]), [
      ['demo_notice', true, null],
      ['terms', true, 'terms'],
      ['privacy', true, 'privacy'],
      ['news', false, null],
    ])
    assert.equal(pick(b.notice!, 'ko'), '데모입니다.')
    assert.deepEqual(b.placeholders, [])
    assert.deepEqual(b.ignored, [])
  })

  it('a language the folder lacks falls back to the other one', () => {
    const b = loadLegalDir(good())
    assert.equal(pick(b.docs.privacy!, 'ko'), '# Privacy\n')
    assert.equal(pick(b.items[2].label, 'ko'), 'Privacy.')
    assert.equal(pick(b.items[2].details!, 'en'), '| a | b |\n|---|---|\n| 1 | 2 |')
  })

  it('the version changes with a document and not with files outside the bundle', () => {
    const dir = good()
    const v1 = loadLegalDir(dir).version
    writeFileSync(path.join(dir, 'README.txt'), 'notes for the operator')
    writeFileSync(path.join(dir, '.DS_Store'), 'x')
    const b2 = loadLegalDir(dir)
    assert.equal(b2.version, v1)
    assert.deepEqual(b2.ignored, ['.DS_Store', 'README.txt'])
    writeFileSync(path.join(dir, 'terms.ko.md'), '# 약관 2판\n')
    assert.notEqual(loadLegalDir(dir).version, v1)
    writeFileSync(path.join(dir, 'terms.ko.md'), '# 약관\n')
    assert.equal(loadLegalDir(dir).version, v1, 'same files, same version')
  })

  it('a bad signup.json refuses to boot, naming the file and the reason', () => {
    const base = { 'terms.en.md': '# Terms\n' }
    const item = (over: object) => ({ items: [{ id: 'a', required: true, label: { en: 'A' }, ...over }] })
    // a doc the folder does not have
    assert.match(refusal({ ...base, 'signup.json': item({ doc: 'privacy' }) }), /signup\.json: items\[0\]\.doc is "privacy" but the folder has no privacy/)
    // an empty label
    assert.match(refusal({ ...base, 'signup.json': item({ label: { ko: '  ' } }) }), /signup\.json: items\[0\]\.label\.ko is empty/)
    assert.match(refusal({ ...base, 'signup.json': item({ label: {} }) }), /items\[0\]\.label is empty/)
    // the same id twice
    assert.match(
      refusal({ ...base, 'signup.json': { items: [{ id: 'a', required: true, label: { en: 'A' } }, { id: 'a', required: false, label: { en: 'B' } }] } }),
      /signup\.json: items\[1\]\.id "a" is used twice/,
    )
    // and the rest of the shape
    assert.match(refusal(base), /signup\.json: missing/)
    assert.match(refusal({ ...base, 'signup.json': '{ not json' }), /signup\.json: not valid JSON/)
    assert.match(refusal({ ...base, 'signup.json': { items: [], extra: 1 } }), /unknown key "extra"/)
    assert.match(refusal({ ...base, 'signup.json': item({ requird: true }) }), /unknown key "requird"/)
    assert.match(refusal({ ...base, 'signup.json': item({ required: 'yes' }) }), /required must be true or false/)
    assert.match(refusal({ ...base, 'signup.json': item({ id: 'Bad Id' }) }), /items\[0\]\.id must be/)
    assert.match(refusal({ ...base, 'signup.json': item({ doc: 'cookies' }) }), /doc must be "terms" or "privacy"/)
    assert.match(refusal({ ...base, 'signup.json': item({ label: { fr: 'A' } }) }), /unknown language "fr"/)
    assert.match(refusal({ 'terms.en.md': '  \n', 'signup.json': { items: [] } }), /terms\.en\.md: is empty/)
    assert.throws(() => loadLegalDir(path.join(tmpdir(), 'inkling-legal-does-not-exist')), LegalConfigError)
  })

  it('placeholders left in a document are reported for the boot warning', () => {
    const b = loadLegalDir(folder({ 'terms.en.md': 'Run by {{OPERATOR_NAME}} at {{SERVICE_URL}}', 'signup.json': { items: [] } }))
    assert.deepEqual(b.placeholders, [{ file: 'terms.en.md', found: ['{{OPERATOR_NAME}}', '{{SERVICE_URL}}'] }])
    const { warn } = describeBundle(b)
    assert.ok(warn.some((w) => w.includes('terms.en.md') && w.includes('{{OPERATOR_NAME}}')))
  })

  it('the demo template (deploy/demo/legal) loads: six required items, both documents in both languages, placeholders warned', () => {
    const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../deploy/demo/legal')
    const b = loadLegalDir(dir)
    assert.deepEqual(b.items.map((i) => i.id), ['demo_notice', 'terms', 'privacy', 'age_14', 'residence_kr_us', 'overseas_transfer'])
    assert.ok(b.items.every((i) => i.required && i.label.ko && i.label.en))
    assert.deepEqual(Object.keys(b.docs.terms ?? {}).sort(), ['en', 'ko'])
    assert.deepEqual(Object.keys(b.docs.privacy ?? {}).sort(), ['en', 'ko'])
    assert.ok(b.notice?.ko && b.notice.en)
    assert.deepEqual(b.placeholders.map((p) => p.file).sort(), ['privacy.en.md', 'privacy.ko.md', 'terms.en.md', 'terms.ko.md'])
    assert.deepEqual(b.ignored, [])
  })
})
