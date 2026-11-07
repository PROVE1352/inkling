// @ts-nocheck — Node test file (node:test types are not part of the web tsconfig); not bundled.
// Run: cd apps/server && npx tsx --test ../web/src/lib/nav.test.ts
// Open-redirect guard for ?next= (docs/adr/0851-*).
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { safeNext } from './nav'

const O = 'https://notes.example.org'

describe('safeNext (0851)', () => {
  it('keeps same-origin paths with query and hash', () => {
    assert.equal(safeNext('/w/abc/p/def', O), '/w/abc/p/def')
    assert.equal(safeNext('/join/XYZ?x=1#top', O), '/join/XYZ?x=1#top')
    assert.equal(safeNext('/', O), '/')
  })

  it('rejects empty and non-path input', () => {
    for (const v of [null, undefined, '', 'w/abc', 'evil.com', ' /w']) assert.equal(safeNext(v, O), '/')
  })

  it('rejects protocol-relative and backslash variants that resolve to another origin', () => {
    for (const v of [
      '//evil.com',
      '//evil.com/w',
      '/\\evil.com',
      '/\\/evil.com',
      '\\\\evil.com',
      '/\t/evil.com',
      '/\n/evil.com',
      '/\r\n/evil.com',
      '/\\\tevil.com',
    ]) {
      assert.equal(safeNext(v, O), '/', JSON.stringify(v))
    }
  })

  it('rejects absolute URLs and script schemes', () => {
    for (const v of [
      'https://evil.com',
      'http://notes.example.org.evil.com/',
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox',
    ]) {
      assert.equal(safeNext(v, O), '/', v)
    }
  })

  it('never returns a path that starts a protocol-relative URL after normalisation', () => {
    assert.equal(safeNext('/.//evil.com', O), '/')
    assert.equal(safeNext('/a/..//evil.com', O), '/')
  })

  it('returns the normalised path (dot segments resolved, still same origin)', () => {
    assert.equal(safeNext('/a/../w/x', O), '/w/x')
    assert.equal(safeNext('/%2F%2Fevil.com', O), '/%2F%2Fevil.com')
  })
})
