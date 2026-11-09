// @ts-nocheck — Node test file (node:test types are not part of the web tsconfig); not bundled.
// Key specs: parsing, labels and matching on Mac and elsewhere, IME and the text-field rule (docs/adr/1400-*).
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { allowedIn, ariaKey, formatKey, isImeEvent, matchKey, parseKey, specFromEvent, targetKind } from './keys'

const ev = (o) => ({
  key: '',
  code: '',
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  isComposing: false,
  keyCode: 0,
  ...o,
})

describe('parseKey / formatKey', () => {
  it('reads ProseMirror-style specs in any modifier order', () => {
    assert.deepEqual(parseKey('Mod-Shift-f'), { mod: true, shift: true, alt: false, ctrl: false, key: 'f' })
    assert.deepEqual(parseKey('Shift-Mod-ArrowUp'), { mod: true, shift: true, alt: false, ctrl: false, key: 'ArrowUp' })
    assert.deepEqual(parseKey('Mod-\\'), { mod: true, shift: false, alt: false, ctrl: false, key: '\\' })
    assert.deepEqual(parseKey('Mod--'), { mod: true, shift: false, alt: false, ctrl: false, key: '-' })
    assert.deepEqual(parseKey('?'), { mod: false, shift: false, alt: false, ctrl: false, key: '?' })
  })

  it('labels with ⌘ symbols on a Mac and Ctrl+ elsewhere', () => {
    assert.equal(formatKey('Mod-k', 'mac'), '⌘K')
    assert.equal(formatKey('Mod-k', 'other'), 'Ctrl+K')
    assert.equal(formatKey('Mod-Shift-f', 'mac'), '⌘⇧F')
    assert.equal(formatKey('Mod-Shift-f', 'other'), 'Ctrl+Shift+F')
    assert.equal(formatKey('Mod-Alt-n', 'mac'), '⌘⌥N')
    assert.equal(formatKey('Mod-Alt-n', 'other'), 'Ctrl+Alt+N')
    assert.equal(formatKey('Mod-Alt-ArrowLeft', 'mac'), '⌘⌥←')
    assert.equal(formatKey('Alt-ArrowLeft', 'other'), 'Alt+←')
    assert.equal(formatKey('Mod-Backspace', 'mac'), '⌘⌫')
    assert.equal(formatKey('Mod-Delete', 'other'), 'Ctrl+Del')
    assert.equal(formatKey('Mod-Shift-ArrowUp', 'mac'), '⌘⇧↑')
    assert.equal(formatKey('Mod-Enter', 'other'), 'Ctrl+Enter')
    assert.equal(formatKey('Mod-\\', 'mac'), '⌘\\')
    assert.equal(formatKey('?', 'mac'), '?')
    assert.equal(formatKey('F2', 'other'), 'F2')
  })
})

describe('matchKey', () => {
  it('Mod is ⌘ on a Mac and Ctrl elsewhere, never both', () => {
    assert.equal(matchKey('Mod-k', ev({ key: 'k', code: 'KeyK', metaKey: true }), 'mac'), true)
    assert.equal(matchKey('Mod-k', ev({ key: 'k', code: 'KeyK', ctrlKey: true }), 'mac'), false)
    assert.equal(matchKey('Mod-k', ev({ key: 'k', code: 'KeyK', ctrlKey: true }), 'other'), true)
    assert.equal(matchKey('Mod-k', ev({ key: 'k', code: 'KeyK', metaKey: true }), 'other'), false)
    assert.equal(matchKey('Mod-k', ev({ key: 'k', code: 'KeyK', metaKey: true, ctrlKey: true }), 'mac'), false)
  })

  it('modifiers must match exactly', () => {
    assert.equal(matchKey('Mod-p', ev({ key: 'p', code: 'KeyP', ctrlKey: true, altKey: true }), 'other'), false)
    assert.equal(matchKey('Mod-p', ev({ key: 'P', code: 'KeyP', metaKey: true, shiftKey: true }), 'mac'), false)
    assert.equal(matchKey('Mod-Shift-p', ev({ key: 'P', code: 'KeyP', metaKey: true, shiftKey: true }), 'mac'), true)
    assert.equal(matchKey('k', ev({ key: 'k', code: 'KeyK', metaKey: true }), 'mac'), false)
  })

  it('letters still match when ⌥ or a Korean layout changes e.key', () => {
    assert.equal(matchKey('Mod-Alt-n', ev({ key: '˜', code: 'KeyN', metaKey: true, altKey: true }), 'mac'), true)
    assert.equal(matchKey('Mod-Alt-n', ev({ key: 'Dead', code: 'KeyN', metaKey: true, altKey: true }), 'mac'), true)
    assert.equal(matchKey('Mod-k', ev({ key: 'ㅏ', code: 'KeyK', metaKey: true }), 'mac'), true)
    assert.equal(matchKey('Mod-Alt-1', ev({ key: '¡', code: 'Digit1', metaKey: true, altKey: true }), 'mac'), true)
  })

  it('AZERTY: an ASCII e.key wins over the physical position', () => {
    // AZERTY "A" sits on KeyQ
    assert.equal(matchKey('Mod-a', ev({ key: 'a', code: 'KeyQ', ctrlKey: true }), 'other'), true)
    assert.equal(matchKey('Mod-q', ev({ key: 'a', code: 'KeyQ', ctrlKey: true }), 'other'), false)
  })

  it('AltGr text on Windows (Ctrl+Alt + a non-ASCII character) is typing, not a shortcut', () => {
    assert.equal(matchKey('Mod-Alt-n', ev({ key: 'n', code: 'KeyN', ctrlKey: true, altKey: true }), 'other'), true)
    assert.equal(matchKey('Mod-Alt-n', ev({ key: 'ń', code: 'KeyN', ctrlKey: true, altKey: true }), 'other'), false)
    assert.equal(
      matchKey('Mod-Alt-s', ev({ key: 's', code: 'KeyS', ctrlKey: true, altKey: true, altGraph: true }), 'other'),
      false,
    )
  })

  it('punctuation matches by character or by physical key (Shift+\\ gives "|")', () => {
    assert.equal(matchKey('Mod-\\', ev({ key: '\\', code: 'Backslash', metaKey: true }), 'mac'), true)
    assert.equal(matchKey('Mod-Shift-\\', ev({ key: '|', code: 'Backslash', metaKey: true, shiftKey: true }), 'mac'), true)
    assert.equal(matchKey('Mod-Shift-\\', ev({ key: '\\', code: 'Backslash', metaKey: true }), 'mac'), false)
    assert.equal(matchKey('Mod-,', ev({ key: ',', code: 'Comma', ctrlKey: true }), 'other'), true)
    assert.equal(matchKey('Mod-.', ev({ key: '.', code: 'Period', metaKey: true }), 'mac'), true)
  })

  it('"?" implies Shift and follows the character, whatever the layout puts it on', () => {
    assert.equal(matchKey('?', ev({ key: '?', code: 'Slash', shiftKey: true }), 'mac'), true)
    assert.equal(matchKey('?', ev({ key: '?', code: 'Minus', shiftKey: true }), 'other'), true)
    assert.equal(matchKey('?', ev({ key: '/', code: 'Slash' }), 'mac'), false)
    assert.equal(matchKey('?', ev({ key: '?', code: 'Slash', shiftKey: true, metaKey: true }), 'mac'), false)
  })

  it('named keys', () => {
    assert.equal(matchKey('F2', ev({ key: 'F2', code: 'F2' }), 'mac'), true)
    assert.equal(matchKey('Mod-Enter', ev({ key: 'Enter', code: 'Enter', ctrlKey: true }), 'other'), true)
    assert.equal(matchKey('Mod-Shift-ArrowUp', ev({ key: 'ArrowUp', code: 'ArrowUp', metaKey: true, shiftKey: true }), 'mac'), true)
    assert.equal(matchKey('Space', ev({ key: ' ', code: 'Space' }), 'mac'), true)
    assert.equal(matchKey('Delete', ev({ key: 'Delete', code: 'Delete' }), 'other'), true)
  })

  it('a key pressed while an IME composes (Korean, Japanese) never matches', () => {
    assert.equal(matchKey('Mod-k', ev({ key: 'k', code: 'KeyK', metaKey: true, isComposing: true }), 'mac'), false)
    // Safari reports composition keydowns as keyCode 229 without isComposing
    assert.equal(matchKey('Mod-Enter', ev({ key: 'Enter', code: 'Enter', metaKey: true, keyCode: 229 }), 'mac'), false)
    assert.equal(isImeEvent(ev({ key: 'Process', keyCode: 229 })), true)
    assert.equal(isImeEvent(ev({ key: 'k', keyCode: 75 })), false)
  })
})

describe('text-field rule', () => {
  const input = { tagName: 'INPUT', isContentEditable: false }
  const textarea = { tagName: 'TEXTAREA', isContentEditable: false }
  const editable = { tagName: 'DIV', isContentEditable: true }
  const body = { tagName: 'BODY', isContentEditable: false }

  it('classifies the focused element', () => {
    assert.equal(targetKind(input), 'field')
    assert.equal(targetKind(textarea), 'field')
    assert.equal(targetKind({ tagName: 'SELECT' }), 'field')
    assert.equal(targetKind(editable), 'editable')
    assert.equal(targetKind(body), 'none')
    assert.equal(targetKind(null), 'none')
  })

  it('modifier combos work in fields by default; bare keys do not', () => {
    assert.equal(allowedIn('Mod-k', undefined, 'field'), true)
    assert.equal(allowedIn('Mod-k', undefined, 'editable'), true)
    assert.equal(allowedIn('Alt-ArrowLeft', undefined, 'field'), true)
    assert.equal(allowedIn('?', undefined, 'field'), false)
    assert.equal(allowedIn('?', undefined, 'editable'), false)
    assert.equal(allowedIn('?', undefined, 'none'), true)
    // Shift alone is not a modifier for this rule: Shift+letter is typing
    assert.equal(allowedIn('Shift-a', undefined, 'editable'), false)
  })

  it('a command can narrow or widen the rule', () => {
    // F2 (rename the title) works from the editor body but not from a field
    assert.equal(allowedIn('F2', 'editable', 'editable'), true)
    assert.equal(allowedIn('F2', 'editable', 'field'), false)
    assert.equal(allowedIn('Mod-z', 'deny', 'field'), false)
    assert.equal(allowedIn('Mod-z', 'deny', 'none'), true)
  })
})

describe('ariaKey', () => {
  it('spells keys for aria-keyshortcuts', () => {
    assert.equal(ariaKey('Mod-Alt-s', 'mac'), 'Meta+Alt+S')
    assert.equal(ariaKey('Mod-Alt-s', 'other'), 'Control+Alt+S')
    assert.equal(ariaKey('Mod-Shift-ArrowUp', 'mac'), 'Meta+Shift+ArrowUp')
    assert.equal(ariaKey('F2', 'other'), 'F2')
  })
})

describe('specFromEvent (capturing a new key in Settings, docs/adr/1405-*)', () => {
  const spec = (o, platform = 'mac') => specFromEvent(ev(o), platform)
  it('writes the pressed combination as a spec, in one order', () => {
    assert.deepEqual(spec({ key: 'k', code: 'KeyK', metaKey: true }), { kind: 'key', spec: 'Mod-k' })
    assert.deepEqual(spec({ key: 'K', code: 'KeyK', metaKey: true, shiftKey: true, altKey: true }), { kind: 'key', spec: 'Mod-Alt-Shift-k' })
    assert.deepEqual(spec({ key: 'k', code: 'KeyK', ctrlKey: true, metaKey: true }), { kind: 'key', spec: 'Ctrl-Mod-k' })
    assert.deepEqual(spec({ key: 'k', code: 'KeyK', ctrlKey: true }, 'other'), { kind: 'key', spec: 'Mod-k' })
    assert.deepEqual(spec({ key: 'F2', code: 'F2' }), { kind: 'key', spec: 'F2' })
    assert.deepEqual(spec({ key: ' ', code: 'Space' }), { kind: 'key', spec: 'Space' })
    assert.deepEqual(spec({ key: 'ArrowUp', code: 'ArrowUp', altKey: true }), { kind: 'key', spec: 'Alt-ArrowUp' })
  })
  it('letters and digits come from the physical key when ⌥, Shift or a Korean layout changed the character', () => {
    assert.deepEqual(spec({ key: 'ß', code: 'KeyS', metaKey: true, altKey: true }), { kind: 'key', spec: 'Mod-Alt-s' })
    assert.deepEqual(spec({ key: 'ㄱ', code: 'KeyR', metaKey: true }), { kind: 'key', spec: 'Mod-r' })
    assert.deepEqual(spec({ key: '&', code: 'Digit7', metaKey: true, shiftKey: true }), { kind: 'key', spec: 'Mod-Shift-7' })
    assert.deepEqual(spec({ key: '|', code: 'Backslash', metaKey: true, shiftKey: true }), { kind: 'key', spec: 'Mod-Shift-\\' })
    assert.deepEqual(spec({ key: 'Dead', code: 'KeyE', metaKey: true, altKey: true }), { kind: 'key', spec: 'Mod-Alt-e' })
  })
  it('AZERTY: an ASCII letter on the key wins, as in matchKey', () => {
    assert.deepEqual(spec({ key: 'a', code: 'KeyQ', ctrlKey: true }, 'other'), { kind: 'key', spec: 'Mod-a' })
  })
  it('a captured spec matches the same key press again', () => {
    for (const [o, platform] of [
      [{ key: 'ß', code: 'KeyS', metaKey: true, altKey: true }, 'mac'],
      [{ key: '&', code: 'Digit7', metaKey: true, shiftKey: true }, 'mac'],
      [{ key: 'K', code: 'KeyK', ctrlKey: true, shiftKey: true }, 'other'],
      [{ key: '?', code: 'Slash', shiftKey: true }, 'mac'],
    ]) {
      const r = specFromEvent(ev(o), platform)
      assert.equal(matchKey(r.spec, ev(o), platform), true, JSON.stringify(o))
    }
  })
  it('a shifted character keeps the character and drops the implied Shift', () => {
    assert.deepEqual(spec({ key: '?', code: 'Slash', shiftKey: true }), { kind: 'key', spec: '?' })
  })
  it('modifier presses, IME composition and Esc are not keys', () => {
    for (const key of ['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock']) assert.deepEqual(spec({ key, code: key + 'Left' }), { kind: 'ignore' })
    assert.deepEqual(spec({ key: 'Process', code: 'KeyK', isComposing: true }), { kind: 'ignore' })
    assert.deepEqual(spec({ key: 'k', code: 'KeyK', metaKey: true, keyCode: 229 }), { kind: 'ignore' })
    assert.deepEqual(spec({ key: 'Escape', code: 'Escape' }), { kind: 'cancel' })
  })
  it('the Windows key and AltGr characters cannot be bound', () => {
    assert.deepEqual(spec({ key: 'k', code: 'KeyK', metaKey: true }, 'other'), { kind: 'invalid', reason: 'winKey' })
    assert.deepEqual(spec({ key: 'ń', code: 'KeyN', ctrlKey: true, altKey: true }, 'other'), { kind: 'invalid', reason: 'altGraph' })
    assert.deepEqual(spec({ key: 'n', code: 'KeyN', ctrlKey: true, altKey: true, altGraph: true }, 'other'), { kind: 'invalid', reason: 'altGraph' })
  })
})
