// @ts-nocheck — Node test file (node:test types are not part of the web tsconfig); not bundled.
// User remapping (docs/adr/1404-*, 1405-*): overrides replace a command's keys everywhere the registry
// is read, a new key is checked (bare characters, reserved keys, conflicts) before it is saved, and the
// JSON export reads back.
import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { SHORTCUTS, boundKeys, currentKeys, effectiveDefs, findConflicts, isRemappable, keyLabels, setKeyOverrides, shortcutById } from './registry'
import { checkBinding, defaultConflicts, exportOverrides, importOverrides, parseOverrides, withBinding, withDefault, withNoKey } from './remap'

afterEach(() => setKeyOverrides({}))

describe('overrides in the registry', () => {
  it('currentKeys, boundKeys and labels follow an override; the hidden aliases go with the defaults', () => {
    assert.deepEqual(boundKeys('app.newPage', 'other'), ['Mod-Alt-n', 'Mod-n'])
    setKeyOverrides({ other: { 'app.newPage': ['Mod-Shift-y'] } })
    assert.deepEqual(currentKeys('app.newPage', 'other'), ['Mod-Shift-y'])
    assert.deepEqual(boundKeys('app.newPage', 'other'), ['Mod-Shift-y'])
    assert.deepEqual(keyLabels('app.newPage', 'other'), ['Ctrl+Shift+Y'])
    // the other platform keeps its defaults
    assert.deepEqual(currentKeys('app.newPage', 'mac'), ['Mod-Alt-n', 'Mod-n'])
  })

  it('an empty override leaves the command without a key', () => {
    setKeyOverrides({ mac: { 'app.graph': [] } })
    assert.deepEqual(currentKeys('app.graph', 'mac'), [])
    assert.deepEqual(boundKeys('app.graph', 'mac'), [])
  })

  it('a palette-only command can get a key', () => {
    assert.deepEqual(currentKeys('app.dailyToday', 'mac'), [])
    setKeyOverrides({ mac: { 'app.dailyToday': ['Mod-Alt-t'] } })
    assert.deepEqual(currentKeys('app.dailyToday', 'mac'), ['Mod-Alt-t'])
  })

  it('effectiveDefs carries the overrides into the conflict check', () => {
    setKeyOverrides({ mac: { 'app.graph': ['Mod-k'] } })
    const c = findConflicts(effectiveDefs('mac'), 'mac')
    assert.deepEqual(c.map((x) => [x.a, x.b].sort().join()), ['app.graph,app.search'])
  })

  it('keys the pinned editor or the browser handle cannot be remapped', () => {
    assert.equal(isRemappable(shortcutById('editor.bold')), false)
    assert.equal(isRemappable(shortcutById('table.copy')), false)
    assert.equal(isRemappable(shortcutById('editor.duplicateBlock')), true)
    assert.equal(isRemappable(shortcutById('tree.rename')), true)
    assert.equal(isRemappable(shortcutById('table.down')), true)
  })
})

describe('checkBinding', () => {
  it('accepts a free combination', () => {
    assert.deepEqual(checkBinding('app.graph', 'Mod-Shift-g', 'mac', {}), { conflicts: [] })
  })

  it('refuses a character without ⌘/Ctrl/⌥ anywhere, and bare keys outside the tree and the table', () => {
    assert.equal(checkBinding('app.graph', 'g', 'mac', {}).problem?.kind, 'bareChar')
    assert.equal(checkBinding('app.graph', 'Shift-g', 'mac', {}).problem?.kind, 'bareChar')
    assert.equal(checkBinding('table.down', 'j', 'mac', {}).problem?.kind, 'bareChar')
    assert.equal(checkBinding('app.graph', 'Enter', 'mac', {}).problem?.kind, 'bareKey')
    assert.equal(checkBinding('editor.duplicateBlock', 'Shift-Enter', 'mac', {}).problem?.kind, 'bareKey')
    // function keys are fine anywhere; navigation keys in the tree and the table
    assert.equal(checkBinding('app.graph', 'F8', 'mac', {}).problem, undefined)
    assert.equal(checkBinding('table.down', 'PageDown', 'mac', {}).problem, undefined)
    assert.equal(checkBinding('tree.open', 'Space', 'mac', {}).problem, undefined)
  })

  it('refuses keys the OS or the browser never hands to a page, and the clipboard keys', () => {
    assert.deepEqual(checkBinding('app.graph', 'Mod-w', 'mac', {}).problem, { kind: 'blocked', why: 'os' })
    assert.deepEqual(checkBinding('app.graph', 'Mod-Alt-i', 'mac', {}).problem, { kind: 'blocked', why: 'os' })
    assert.deepEqual(checkBinding('app.graph', 'Alt-F4', 'other', {}).problem, { kind: 'blocked', why: 'os' })
    assert.deepEqual(checkBinding('app.graph', 'Mod-c', 'mac', {}).problem, { kind: 'blocked', why: 'textEditing' })
  })

  it('warns, without refusing, about keys a browser tab keeps but the installed app gets, and browser functions', () => {
    const tab = checkBinding('app.graph', 'Mod-Shift-n', 'mac', {})
    assert.equal(tab.problem, undefined)
    assert.equal(tab.warning, 'tabReserved')
    assert.equal(checkBinding('app.graph', 'Mod-r', 'mac', {}).warning, 'browser')
    assert.equal(checkBinding('app.graph', 'F5', 'other', {}).warning, 'browser')
  })

  it('names the commands that already use the key where both are live', () => {
    assert.deepEqual(checkBinding('app.graph', 'Mod-k', 'mac', {}).conflicts, ['app.search'])
    // editor and tree never have focus together
    assert.deepEqual(checkBinding('tree.rename', 'Mod-d', 'mac', {}).conflicts, [])
    // after the search key moved away, ⌘K is free
    assert.deepEqual(checkBinding('app.graph', 'Mod-k', 'mac', { mac: { 'app.search': ['Mod-Shift-k'] } }).conflicts, [])
  })

  it('a key held by a command that cannot change (the editor’s bold, the editor’s own heading 4) is refused', () => {
    assert.deepEqual(checkBinding('app.graph', 'Mod-b', 'mac', {}).problem, { kind: 'fixedConflict', with: 'editor.bold' })
    assert.deepEqual(checkBinding('editor.duplicateBlock', 'Mod-Alt-4', 'mac', {}).problem, { kind: 'fixedConflict', with: 'editor.builtin' })
    assert.deepEqual(checkBinding('table.newRow', 'Mod-c', 'mac', {}).problem, { kind: 'blocked', why: 'textEditing' })
  })

  it('a command that cannot be remapped says so', () => {
    assert.deepEqual(checkBinding('editor.bold', 'Mod-Alt-b', 'mac', {}).problem, { kind: 'notRemappable' })
  })
})

describe('withBinding / withDefault', () => {
  it('gives the key to the command and takes it from the one that had it', () => {
    const o = withBinding({}, 'app.graph', 'Mod-k', 'mac')
    assert.deepEqual(o, { mac: { 'app.graph': ['Mod-k'], 'app.search': [] } })
    setKeyOverrides(o)
    assert.deepEqual(findConflicts(effectiveDefs('mac'), 'mac'), [])
  })

  it('taking a key that is another command’s hidden alias switches the alias off', () => {
    // Ctrl+N is a hidden alias of "New page" off a Mac (the installed app gets it)
    setKeyOverrides(withBinding({}, 'app.graph', 'Mod-n', 'other'))
    assert.ok(!boundKeys('app.newPage', 'other').includes('Mod-n'))
    assert.deepEqual(currentKeys('app.newPage', 'other'), ['Mod-Alt-n'])
    assert.deepEqual(findConflicts(effectiveDefs('other'), 'other'), [])
  })

  it('a binding back to the default removes the override', () => {
    let o = withBinding({}, 'app.graph', 'Mod-Shift-g', 'mac')
    o = withBinding(o, 'app.graph', 'Mod-g', 'mac')
    assert.deepEqual(o, {})
    o = withBinding({}, 'app.graph', 'Mod-Shift-g', 'other')
    assert.deepEqual(withDefault(o, 'app.graph', 'other'), {})
  })

  it('a reset takes the default key back from a command that got it meanwhile', () => {
    let o = withBinding({}, 'app.graph', 'Mod-k', 'mac') // search lost ⌘K
    assert.deepEqual(defaultConflicts(o, 'app.search', 'mac'), ['app.graph'])
    o = withDefault(o, 'app.search', 'mac')
    assert.deepEqual(o, { mac: { 'app.graph': [] } })
    setKeyOverrides(o)
    assert.deepEqual(currentKeys('app.search', 'mac'), ['Mod-k'])
    assert.deepEqual(findConflicts(effectiveDefs('mac'), 'mac'), [])
  })

  it('a command can be left without a key; a palette-only command without one stores nothing', () => {
    assert.deepEqual(withNoKey({}, 'app.graph', 'mac'), { mac: { 'app.graph': [] } })
    assert.deepEqual(withNoKey({}, 'app.dailyToday', 'mac'), {})
  })

  it('specs are stored in one spelling', () => {
    assert.deepEqual(withBinding({}, 'app.graph', 'Shift-Mod-G', 'mac'), { mac: { 'app.graph': ['Mod-Shift-g'] } })
  })
})

describe('stored and exported overrides', () => {
  it('drops unknown commands, unparsable keys and commands that cannot be remapped', () => {
    const { overrides, dropped } = parseOverrides({
      version: 1,
      mac: { 'app.graph': ['Mod-Shift-g'], 'no.such': ['Mod-j'], 'editor.bold': ['Mod-j'], 'app.search': ['Mod-Hyper-k'], 'app.help': 'F1' },
      other: { 'app.graph': ['g'] },
    })
    assert.deepEqual(overrides, { mac: { 'app.graph': ['Mod-Shift-g'] } })
    assert.deepEqual(dropped.sort(), ['mac app.help', 'mac app.search', 'mac editor.bold', 'mac no.such', 'other app.graph'])
  })

  it('exports and imports the same overrides', () => {
    const o = withBinding(withBinding({}, 'app.graph', 'Mod-Shift-g', 'mac'), 'table.newRow', 'Mod-Shift-Enter', 'other')
    const text = exportOverrides(o)
    const parsed = JSON.parse(text)
    assert.equal(parsed.app, 'inkling')
    assert.equal(parsed.kind, 'shortcuts')
    assert.equal(parsed.version, 1)
    const back = importOverrides(text)
    assert.equal(back.ok, true)
    assert.deepEqual(back.overrides, o)
  })

  it('an import that is not JSON, not ours, or leaves two commands on one key is refused whole', () => {
    assert.deepEqual(importOverrides('{nope'), { ok: false, error: 'json' })
    assert.deepEqual(importOverrides('{"theme":"dark"}'), { ok: false, error: 'format' })
    const clash = JSON.stringify({ app: 'inkling', kind: 'shortcuts', version: 1, mac: { 'app.graph': ['Mod-k'] } })
    const r = importOverrides(clash)
    assert.equal(r.ok, false)
    assert.equal(r.error, 'conflict')
    assert.deepEqual(r.conflicts.map((c) => [c.a, c.b].sort().join()), ['app.graph,app.search'])
  })

  it('every remappable command is in the default registry without conflicts', () => {
    for (const s of SHORTCUTS) if (isRemappable(s)) assert.equal(checkBinding(s.id, s.keys?.mac?.[0] ?? 'F9', 'mac', {}).problem?.kind !== 'notRemappable', true)
  })
})
