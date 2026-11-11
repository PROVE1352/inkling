// Storage and file-size limit errors (docs/adr/2505-*): the server sends bytes marked `unit: 'bytes'`;
// Korean shows them in MB, English the server's sentence; without the mark the plain text stays.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ko } from './ko'
import { setLocaleChoice } from './index'
import { formatMb, localizeApiError } from './errors'

test('formatMb: one decimal under 10 MB, whole above', () => {
  assert.equal(formatMb(5 * 1024 * 1024), '5 MB')
  assert.equal(formatMb(4.84 * 1024 * 1024), '4.8 MB')
  assert.equal(formatMb(20 * 1024 * 1024), '20 MB')
  assert.equal(formatMb(0), '0 MB')
})

test('LIMIT_STORAGE and LIMIT_FILE in bytes are shown in MB', () => {
  setLocaleChoice('ko')
  try {
    const s = localizeApiError('LIMIT_STORAGE', 'full', { limit: 20 * 1024 * 1024, used: 21 * 1024 * 1024, unit: 'bytes' })
    assert.match(s, /20 MB 중 21 MB/)
    const f = localizeApiError('LIMIT_FILE', 'big', { limit: 5 * 1024 * 1024, used: 5 * 1024 * 1024 + 1, unit: 'bytes' })
    assert.match(f, /5 MB까지/)
    assert.equal(localizeApiError('LIMIT_STORAGE', 'full', { limit: 1, used: 2 }), ko['errors.LIMIT_STORAGE'])
  } finally {
    setLocaleChoice('en')
  }
})
