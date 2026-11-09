// @ts-nocheck — Node test file (node:test types are not part of the web tsconfig); not bundled.
// The shortcut registry: unique ids, no two commands on one key where both are live, labels in both
// languages, reserved browser keys only where a command says so (docs/adr/1400-*, 1401-*).
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { en } from '../../i18n/en'
import { ko } from '../../i18n/ko'
import { RESERVED_KEYS, SHORTCUTS, currentKeys, findConflicts, keyLabels, normalizeKey, shortcutById } from './registry'

describe('registry', () => {
  it('ids are unique', () => {
    const ids = SHORTCUTS.map((s) => s.id)
    assert.deepEqual(ids.filter((id, i) => ids.indexOf(id) !== i), [])
  })

  for (const platform of ['mac', 'other']) {
    it(`no two commands share a key where both are live (${platform})`, () => {
      assert.deepEqual(findConflicts(SHORTCUTS, platform), [])
    })

    it(`reserved browser/OS keys are bound only where a command says so (${platform})`, () => {
      const bad = []
      for (const s of SHORTCUTS) {
        for (const k of [...currentKeys(s.id, platform), ...(s.extraKeys?.[platform] ?? [])]) {
          if (RESERVED_KEYS[platform].has(normalizeKey(k, platform)) && !(s.reservedOk ?? []).includes(k)) bad.push(`${s.id} ${k}`)
        }
      }
      assert.deepEqual(bad, [])
    })
  }

  it('findConflicts catches a duplicate in one scope and across scopes that are live together', () => {
    const base = { label: 'common.search', via: 'app' }
    const k = (mac) => ({ mac: [mac], other: [mac] })
    const same = [
      { ...base, id: 'a', scope: 'editor', keys: k('Mod-d') },
      { ...base, id: 'b', scope: 'editor', keys: k('Mod-d') },
    ]
    assert.equal(findConflicts(same, 'mac').length, 1)
    // the same key spelled differently is still the same key
    const spelled = [
      { ...base, id: 'a', scope: 'editor', keys: k('Mod-Shift-d') },
      { ...base, id: 'b', scope: 'editor', keys: k('Shift-Mod-d') },
    ]
    assert.equal(findConflicts(spelled, 'mac').length, 1)
    const cross = [
      { ...base, id: 'a', scope: 'global', keys: k('Mod-d') },
      { ...base, id: 'b', scope: 'editor', keys: k('Mod-d') },
    ]
    assert.equal(findConflicts(cross, 'mac').length, 1)
    // the editor and the sidebar tree never have focus at the same time
    const apart = [
      { ...base, id: 'a', scope: 'tree', keys: k('Mod-d') },
      { ...base, id: 'b', scope: 'editor', keys: k('Mod-d') },
    ]
    assert.deepEqual(findConflicts(apart, 'mac'), [])
    // an overlap declared on purpose (the tree's F2 runs first and claims the key)
    const declared = [
      { ...base, id: 'a', scope: 'global', keys: k('F2') },
      { ...base, id: 'b', scope: 'tree', keys: k('F2'), shadows: ['a'] },
    ]
    assert.deepEqual(findConflicts(declared, 'mac'), [])
  })

  it('every label and hint has English and Korean text', () => {
    const missing = []
    for (const s of SHORTCUTS) {
      for (const key of [s.label, s.paletteLabel, s.hint].filter(Boolean)) {
        if (!(key in en)) missing.push(`en ${s.id} ${key}`)
        if (!(key in ko)) missing.push(`ko ${s.id} ${key}`)
      }
    }
    assert.deepEqual(missing, [])
  })

  it('currentKeys returns the defaults while the user changed nothing (overrides: remap.test.ts)', () => {
    assert.deepEqual(currentKeys('app.search', 'mac'), ['Mod-k'])
    assert.deepEqual(currentKeys('app.search', 'other'), ['Mod-k'])
    assert.deepEqual(currentKeys('nav.back', 'other')[0], 'Alt-ArrowLeft')
    assert.deepEqual(currentKeys('no.such.command', 'mac'), [])
    assert.equal(shortcutById('app.palette')?.scope, 'global')
  })

  it('Later, Threads and the thread follow command have no default key (docs/adr/1410-*)', () => {
    for (const id of ['app.later', 'app.threads', 'page.saveForLater', 'thread.toggleFollow']) {
      const def = shortcutById(id)
      assert.ok(def, id)
      assert.equal(def.via, 'app', id)
      assert.equal(def.keys, undefined, id)
    }
    assert.notEqual(shortcutById('app.later').palette, false)
    assert.notEqual(shortcutById('app.threads').palette, false)
    assert.notEqual(shortcutById('page.saveForLater').palette, false)
    // the palette takes the focus away from the thread card, so it cannot run this one
    assert.equal(shortcutById('thread.toggleFollow').palette, false)
  })

  it('"Insert table" is a palette command of the editor without a default key (docs/adr/1642-*)', () => {
    const def = shortcutById('editor.insertTable')
    assert.ok(def)
    assert.equal(def.via, 'editor')
    assert.equal(def.keys, undefined)
    assert.notEqual(def.palette, false)
  })

  it('labels follow the platform', () => {
    assert.deepEqual(keyLabels('app.fullTextSearch', 'mac'), ['⌘⇧F'])
    assert.deepEqual(keyLabels('app.fullTextSearch', 'other'), ['Ctrl+Shift+F'])
  })

  it('keeps the keys people already use', () => {
    const want = {
      'app.search': 'Mod-k',
      'app.quickSwitcher': 'Mod-o',
      'app.palette': 'Mod-p',
      'app.graph': 'Mod-g',
      'app.settings': 'Mod-,',
      'app.toggleSidebar': 'Mod-\\',
      'app.help': '?',
      'editor.toggleCheckbox': 'Mod-l',
      'editor.deleteBlock': 'Mod-d',
      'editor.toggleFold': 'Mod-.',
      'editor.inlineMath': 'Mod-Shift-e',
    }
    for (const [id, key] of Object.entries(want)) assert.equal(currentKeys(id, 'mac')[0], key, id)
  })
})
