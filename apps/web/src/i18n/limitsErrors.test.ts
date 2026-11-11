// Restricted mode errors (0.22, docs/adr/2500-*): every new code has text in both languages, and a
// limit error that carries { limit, used } shows those numbers.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { RESTRICTED_MODE_ERRORS } from '@inkling/shared'
import { en } from './en'
import { ko } from './ko'
import { setLocaleChoice, t, type TKey } from './index'
import { localizeApiError } from './errors'

test('every restricted-mode error code has English and Korean text', () => {
  for (const code of Object.keys(RESTRICTED_MODE_ERRORS)) {
    assert.ok(`errors.${code}` in en, `en errors.${code}`)
    assert.ok(`errors.${code}` in ko, `ko errors.${code}`)
  }
})

test('limit errors: {limit} and {used} from the error, the plain text without them', () => {
  setLocaleChoice('ko')
  try {
    const counted = localizeApiError('LIMIT_PAGES', 'Page limit reached', { limit: 300, used: 300 })
    assert.equal(counted, t('errors.LIMIT_PAGES_counts' as TKey, { limit: 300, used: 300 }))
    assert.match(counted, /300개 중 300개/)
    assert.equal(localizeApiError('LIMIT_PAGES', 'Page limit reached'), ko['errors.LIMIT_PAGES'])
    assert.equal(localizeApiError('LIMIT_PAGES', 'Page limit reached', { limit: '300' }), ko['errors.LIMIT_PAGES'])
    // a code without a counted text keeps its plain one
    assert.equal(localizeApiError('LIMIT_STORAGE', 'Storage full', { limit: 1, used: 2 }), ko['errors.LIMIT_STORAGE'])
    assert.ok(!/\{\w+\}/.test(localizeApiError('LIMIT_MEMBERS', '', { limit: 4, used: 4 })))
  } finally {
    setLocaleChoice('en')
  }
  // English shows the server's own sentence, as for every other error
  assert.equal(localizeApiError('LIMIT_PAGES', 'Page limit reached (300)', { limit: 300, used: 300 }), 'Page limit reached (300)')
  assert.equal(localizeApiError('LIMIT_PAGES', '', { limit: 300, used: 12 }), en['errors.LIMIT_PAGES_counts'].replace('{used}', '12').replace('{limit}', '300'))
})
