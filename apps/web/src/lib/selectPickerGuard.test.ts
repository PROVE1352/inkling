// @ts-nocheck — Node test file (node:test types are not part of the web tsconfig); not bundled.
// Select pickers in editor blocks (docs/adr/2108-*): which mousedown targets are kept from ProseMirror.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { inSelectControl } from './selectPickerGuard'

const here = path.dirname(fileURLToPath(import.meta.url))
const serverRequire = createRequire(path.resolve(here, '../../../server/package.json'))
const { JSDOM } = createRequire(serverRequire.resolve('@blocknote/server-util'))('jsdom')

describe('select pickers in editor blocks', () => {
  const { document } = new JSDOM(
    `<div class="ProseMirror"><div data-dbview-block><label>View <select><optgroup label="g"><option id="o">Board</option></optgroup></select></label>` +
      `<button id="b"><span id="s">Open</span></button><p id="p">text</p></div></div>`,
  ).window
  const $ = (sel) => document.querySelector(sel)

  it('the select, its options and optgroups and text inside them count', () => {
    assert.equal(inSelectControl($('select')), true)
    assert.equal(inSelectControl($('#o')), true)
    assert.equal(inSelectControl($('optgroup')), true)
    assert.equal(inSelectControl($('#o').firstChild), true) // a text node target
  })

  it('anything else in the block (label text, buttons, paragraphs) is left to the editor', () => {
    assert.equal(inSelectControl($('label')), false)
    assert.equal(inSelectControl($('#b')), false)
    assert.equal(inSelectControl($('#s')), false)
    assert.equal(inSelectControl($('#p').firstChild), false)
    assert.equal(inSelectControl(null), false)
  })
})
