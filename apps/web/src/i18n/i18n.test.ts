import assert from 'node:assert/strict'
import { test } from 'node:test'
import { en } from './en'
import { ko } from './ko'
import {
  fmtRelative,
  getLocale,
  normalizeLocale,
  setLocaleChoice,
  setServerDefaultLocale,
  t,
  tMaybe,
} from './index'
import { localizeApiError } from './errors'

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()

test('every Korean key exists in the English source dictionary', () => {
  const extra = Object.keys(ko).filter((k) => !(k in en))
  assert.deepEqual(extra, [])
})

test('Korean strings use the same {placeholders} as English', () => {
  const bad: string[] = []
  for (const [k, v] of Object.entries(ko)) {
    const src = (en as Record<string, string>)[k]
    if (src !== undefined && v !== undefined && placeholders(src).join() !== placeholders(v).join()) bad.push(k)
  }
  assert.deepEqual(bad, [])
})

test('every English key has a Korean translation (Korean has no `_one` plural form)', () => {
  const total = Object.keys(en).length
  const missing = Object.keys(en).filter((k) => !(k in ko) && !k.endsWith('_one'))
  console.log(`[i18n] en keys: ${total}, ko keys: ${Object.keys(ko).length}, missing ko: ${missing.length}`)
  assert.deepEqual(missing, [])
})

test('no key is defined in two area files (a later spread would silently win)', async () => {
  const { readdirSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  for (const [lang, dict] of [['en', en], ['ko', ko]] as const) {
    const dir = fileURLToPath(new URL(`./${lang}/`, import.meta.url))
    const owner = new Map<string, string>()
    const dupes: string[] = []
    let sum = 0
    // ko/server-messages-*.ts is the separate server-message dictionary of errors.ts (checked below)
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.startsWith('server-messages')).sort()) {
      const mod = (await import(`./${lang}/${file}`)) as { default: Record<string, string> }
      for (const k of Object.keys(mod.default)) {
        sum++
        const prev = owner.get(k)
        if (prev) dupes.push(`${lang}: ${k} in ${prev} and ${file}`)
        else owner.set(k, file)
      }
    }
    assert.deepEqual(dupes, [])
    assert.equal(Object.keys(dict).length, sum, `${lang}: an area file is not spread into the dictionary`)
  }
  const seen = new Map<string, string>()
  const dupes: string[] = []
  for (const file of ['server-messages-a', 'server-messages-b', 'server-messages-c']) {
    const mod = (await import(`./ko/${file}.ts`)) as { default: Record<string, string> }
    for (const k of Object.keys(mod.default)) {
      const prev = seen.get(k)
      if (prev && mod.default[k] !== (await import(`./ko/${prev}.ts`)).default[k]) dupes.push(`${k} in ${prev} and ${file}`)
      else seen.set(k, file)
    }
  }
  assert.deepEqual(dupes, [])
})

test('normalizeLocale accepts tags and rejects unknown languages', () => {
  assert.equal(normalizeLocale('ko-KR'), 'ko')
  assert.equal(normalizeLocale('EN_us'), 'en')
  assert.equal(normalizeLocale('fr'), null)
  assert.equal(normalizeLocale(undefined), null)
})

test('resolution: user choice beats server default; clearing falls back', () => {
  setServerDefaultLocale('ko')
  setLocaleChoice('en')
  assert.equal(getLocale(), 'en')
  setLocaleChoice(null)
  assert.equal(getLocale(), 'ko')
  setServerDefaultLocale(null)
  setLocaleChoice('en')
})

test('t interpolates, falls back to English and returns unknown keys as-is', () => {
  setLocaleChoice('ko')
  assert.equal(t('common.cancel'), '취소')
  assert.equal(tMaybe('errors.MAIL_FAILED', { message: '535' }), '메일 발송에 실패했습니다 (535).')
  assert.equal(t('no.such.key' as never), 'no.such.key')
  assert.equal(tMaybe('no.such.key'), undefined)
  setLocaleChoice('en')
  assert.equal(t('common.cancel'), 'Cancel')
})

test('relative time follows the locale', () => {
  const now = Date.parse('2026-11-07T12:00:00Z')
  setLocaleChoice('en')
  assert.equal(fmtRelative('2026-11-07T11:57:00Z', now), '3 minutes ago')
  assert.equal(fmtRelative('2026-11-07T11:59:30Z', now), 'just now')
  setLocaleChoice('ko')
  assert.equal(fmtRelative('2026-11-07T11:57:00Z', now), '3분 전')
  setLocaleChoice('en')
})

test('API errors: English shows the server text, Korean translates by code', () => {
  setLocaleChoice('en')
  assert.equal(localizeApiError('INVALID_CREDENTIALS', 'Wrong email or password'), 'Wrong email or password')
  assert.equal(localizeApiError('INTERNAL', ''), en['errors.INTERNAL'])
  setLocaleChoice('ko')
  assert.equal(localizeApiError('INVALID_CREDENTIALS', 'Wrong email or password'), ko['errors.INVALID_CREDENTIALS'])
  assert.equal(localizeApiError('SOME_NEW_CODE', 'Plain English'), 'Plain English')
  setLocaleChoice('en')
})
