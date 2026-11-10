// @ts-nocheck — Node test file (node:test types are not part of the web tsconfig); not bundled.
// Length warning for agent instruction pages (docs/adr/2021-*).
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { setLocaleChoice } from '../i18n'
import { InstructionLengthWarning } from '../components/InstructionLengthWarning'
import { instructionLengthOf, isInstructionLong, roundTokens } from './instructionLength'

setLocaleChoice('en')

const lengths = {
  limits: { lines: 200, bytes: 25000 },
  always: { lines: 260, bytes: 9000, tokens: 2300, long: true, pages: 2 },
  pages: [
    { pageId: 'p-long', mode: 'always', lines: 240, bytes: 8000, tokens: 4249, long: true, truncated: false },
    { pageId: 'p-short', mode: 'always', lines: 20, bytes: 1000, tokens: 300, long: false, truncated: false },
  ],
}

describe('instructionLengthOf (GET /workspaces/:id/agent-instructions/length)', () => {
  it('matches the page by id and keeps the server sizes', () => {
    assert.deepEqual(instructionLengthOf(lengths, 'p-long'), { lines: 240, bytes: 8000, tokens: 4249, long: true })
    assert.equal(instructionLengthOf(lengths, 'p-short')?.long, false)
  })

  it('no answer, no page id or an unmeasured page shows nothing', () => {
    assert.equal(instructionLengthOf(undefined, 'p-long'), null)
    assert.equal(instructionLengthOf(lengths, undefined), null)
    assert.equal(instructionLengthOf(lengths, 'other'), null)
  })
})

describe('isInstructionLong', () => {
  it('follows the server: long only when the server says so', () => {
    assert.equal(isInstructionLong(instructionLengthOf(lengths, 'p-long')), true)
    assert.equal(isInstructionLong(instructionLengthOf(lengths, 'p-short')), false)
    assert.equal(isInstructionLong(null), false)
    assert.equal(isInstructionLong(undefined), false)
    assert.equal(isInstructionLong({ lines: 1, bytes: 1, tokens: Number.NaN, long: true }), false)
  })
})

describe('roundTokens', () => {
  it('rounds to tens below 1,000 and hundreds above', () => {
    assert.equal(roundTokens(437), 440)
    assert.equal(roundTokens(4249), 4200)
  })
})

describe('InstructionLengthWarning', () => {
  const html = (length, compact = false) => renderToStaticMarkup(createElement(InstructionLengthWarning, { length, compact }))

  it('renders nothing without a long length', () => {
    assert.equal(html(null), '')
    assert.equal(html(instructionLengthOf(lengths, 'p-short')), '')
  })

  it('full form says the size and asks for a short index', () => {
    const out = html(instructionLengthOf(lengths, 'p-long'))
    assert.match(out, /data-testid="instruction-long"/)
    assert.match(out, /4,200/)
    assert.match(out, /index/i)
  })

  it('compact form is one badge', () => {
    const out = html(instructionLengthOf(lengths, 'p-long'), true)
    assert.match(out, /data-testid="instruction-long-badge"/)
    assert.doesNotMatch(out, /role="note"/)
  })
})
