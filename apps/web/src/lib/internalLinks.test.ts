// @ts-nocheck — Node test file (node:test types are not part of the web tsconfig); not bundled.
// Internal link clicks in editor bodies: which hrefs move inside the app, which clicks are plain.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { internalLinkPath, isPlainClick } from './internalLinks'

const ORIGIN = 'https://notes.example.org'
const click = (over = {}) => ({ button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...over })

describe('internal links in editor bodies', () => {
  it('page and section links under /w/ (relative or absolute, same origin) are internal', () => {
    assert.equal(internalLinkPath('/w/ws1/p/page1', ORIGIN), '/w/ws1/p/page1')
    assert.equal(internalLinkPath('/w/ws1/p/page1#h=section-a', ORIGIN), '/w/ws1/p/page1#h=section-a')
    assert.equal(internalLinkPath('/w/ws1/p/page1?block=b1', ORIGIN), '/w/ws1/p/page1?block=b1')
    // an anchor's resolved .href is absolute
    assert.equal(internalLinkPath(`${ORIGIN}/w/ws1/p/page1#h=x`, ORIGIN), '/w/ws1/p/page1#h=x')
  })

  it('external, other-origin, protocol-relative and non-page links are not', () => {
    assert.equal(internalLinkPath('https://example.com/w/ws1/p/page1', ORIGIN), null)
    assert.equal(internalLinkPath('//evil.example/w/ws1/p/page1', ORIGIN), null)
    assert.equal(internalLinkPath('http://notes.example.org/w/ws1', ORIGIN), null) // another scheme is another origin
    assert.equal(internalLinkPath('/s/token/p/ref', ORIGIN), null)
    assert.equal(internalLinkPath('/api/files/x', ORIGIN), null)
    assert.equal(internalLinkPath('/wiki', ORIGIN), null)
    assert.equal(internalLinkPath('mailto:a@b.c', ORIGIN), null)
    assert.equal(internalLinkPath('', ORIGIN), null)
    assert.equal(internalLinkPath(null, ORIGIN), null)
  })

  it('only a primary click without modifiers is plain; ⌘/Ctrl/Shift/Alt and other buttons keep the new tab', () => {
    assert.equal(isPlainClick(click()), true)
    assert.equal(isPlainClick(click({ metaKey: true })), false)
    assert.equal(isPlainClick(click({ ctrlKey: true })), false)
    assert.equal(isPlainClick(click({ shiftKey: true })), false)
    assert.equal(isPlainClick(click({ altKey: true })), false)
    assert.equal(isPlainClick(click({ button: 1 })), false)
    assert.equal(isPlainClick(click({ button: 2 })), false)
  })
})
