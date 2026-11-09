// Key specs, labels and matching for every app shortcut (docs/adr/1400-*).
//
// A key spec is written the way ProseMirror/BlockNote write them, so editor shortcuts go to the
// editor's keymap unchanged: modifiers joined with "-", then one key. `Mod` is ⌘ on a Mac and Ctrl
// elsewhere; `Ctrl` is the literal Control key on a Mac (elsewhere it is the same as Mod). Letters
// are lowercase ("Mod-Shift-f"), named keys use KeyboardEvent.key names ("ArrowUp", "Enter", "F2").
//
// The pure functions here take plain objects, not DOM events, so they run under node:test.

export type Platform = 'mac' | 'other'

/** The fields of a KeyboardEvent this module reads. */
export type KeyEventLike = {
  key: string
  code: string
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  isComposing?: boolean
  keyCode?: number
  /** e.getModifierState('AltGraph'), filled in by toKeyEvent */
  altGraph?: boolean
}

export type ParsedKey = { mod: boolean; shift: boolean; alt: boolean; ctrl: boolean; key: string }

/** Where focus is: a form field, a contenteditable (the editor), or neither. */
export type TargetKind = 'field' | 'editable' | 'none'

/**
 * When a command may run with focus in a text field. Default: a combo with Mod/Alt/Ctrl is
 * allowed everywhere (⌘K from inside the editor), a bare key is not (`?` would be typed text).
 * 'editable' allows a bare key in the editor but not in fields (F2 from the body renames the title).
 */
export type InInputs = 'allow' | 'deny' | 'editable'

const PUNCT_CODE: Record<string, string> = {
  ',': 'Comma',
  '.': 'Period',
  ';': 'Semicolon',
  '\\': 'Backslash',
  '/': 'Slash',
  '[': 'BracketLeft',
  ']': 'BracketRight',
  '=': 'Equal',
  '-': 'Minus',
  "'": 'Quote',
  '`': 'Backquote',
}

// Characters typed with Shift on most layouts: the spec names the character, Shift is implied and
// the physical key is not checked (the character moves between layouts).
const SHIFTED_CHARS = new Set(['?', '!', '@', '#', '$', '%', '^', '&', '*', '(', ')', '_', '+', '{', '}', '|', ':', '"', '<', '>', '~'])

export function parseKey(spec: string): ParsedKey {
  const out: ParsedKey = { mod: false, shift: false, alt: false, ctrl: false, key: '' }
  // the last segment is the key; "Mod--" means Mod + "-"
  let rest = spec
  if (rest.endsWith('--')) {
    out.key = '-'
    rest = rest.slice(0, -2)
  } else if (rest === '-') {
    out.key = '-'
    rest = ''
  } else {
    const i = rest.lastIndexOf('-')
    out.key = i < 0 ? rest : rest.slice(i + 1)
    rest = i < 0 ? '' : rest.slice(0, i)
  }
  for (const m of rest ? rest.split('-') : []) {
    const l = m.toLowerCase()
    if (l === 'mod' || l === 'cmd' || l === 'meta' || l === 'm') out.mod = true
    else if (l === 'shift' || l === 's') out.shift = true
    else if (l === 'alt' || l === 'a' || l === 'option') out.alt = true
    else if (l === 'ctrl' || l === 'control' || l === 'c') out.ctrl = true
    else throw new Error(`unknown modifier "${m}" in "${spec}"`)
  }
  if (out.key === 'Space') out.key = ' '
  if (out.key.length === 1 && /[A-Z]/.test(out.key)) {
    out.key = out.key.toLowerCase()
    out.shift = true
  }
  return out
}

/** One spelling per key, for comparing specs ("Shift-Mod-d" = "Mod-Shift-d"). Ctrl folds into Mod off a Mac. */
export function canonicalKey(spec: string, platform: Platform): string {
  const p = parseKey(spec)
  const mod = p.mod || (platform === 'other' && p.ctrl)
  const ctrl = platform === 'mac' && p.ctrl
  return [ctrl && 'Ctrl', mod && 'Mod', p.alt && 'Alt', p.shift && 'Shift', p.key === ' ' ? 'Space' : p.key]
    .filter(Boolean)
    .join('-')
}

const NAMED_LABEL: Record<string, { mac: string; other: string }> = {
  ArrowUp: { mac: '↑', other: '↑' },
  ArrowDown: { mac: '↓', other: '↓' },
  ArrowLeft: { mac: '←', other: '←' },
  ArrowRight: { mac: '→', other: '→' },
  Backspace: { mac: '⌫', other: 'Backspace' },
  Delete: { mac: '⌦', other: 'Del' },
  Escape: { mac: 'Esc', other: 'Esc' },
  ' ': { mac: 'Space', other: 'Space' },
}

/** "⌘⇧F" on a Mac, "Ctrl+Shift+F" elsewhere (the order the app has always shown). */
export function formatKey(spec: string, platform: Platform): string {
  const p = parseKey(spec)
  const named = NAMED_LABEL[p.key]
  const key = named ? named[platform] : p.key.length === 1 ? p.key.toUpperCase() : p.key
  if (platform === 'mac') {
    return `${p.ctrl ? '⌃' : ''}${p.mod ? '⌘' : ''}${p.alt ? '⌥' : ''}${p.shift ? '⇧' : ''}${key}`
  }
  const mods = [(p.mod || p.ctrl) && 'Ctrl', p.alt && 'Alt', p.shift && 'Shift'].filter(Boolean)
  return [...mods, key].join('+')
}

/** A keydown that belongs to an input method composition (Korean, Japanese, Chinese). */
export function isImeEvent(e: Pick<KeyEventLike, 'isComposing' | 'keyCode'>): boolean {
  // Safari fires the composition keydown with keyCode 229 and isComposing still false
  return !!e.isComposing || e.keyCode === 229
}

const isAsciiLetter = (s: string) => s.length === 1 && /[a-zA-Z]/.test(s)

function keyMatches(want: string, e: KeyEventLike): boolean {
  if (want.length === 1) {
    if (/[a-z]/.test(want)) {
      // An ASCII e.key decides (AZERTY, Dvorak); when ⌥, a dead key or a Korean/Cyrillic layout
      // changed it, the physical key does.
      if (isAsciiLetter(e.key)) return e.key.toLowerCase() === want
      return e.code === `Key${want.toUpperCase()}`
    }
    if (/[0-9]/.test(want)) return e.key === want || e.code === `Digit${want}`
    if (SHIFTED_CHARS.has(want)) return e.key === want
    if (want === ' ') return e.key === ' ' || e.code === 'Space'
    const code = PUNCT_CODE[want]
    return e.key === want || (!!code && e.code === code)
  }
  return e.key === want
}

export function matchKey(spec: string, e: KeyEventLike, platform: Platform): boolean {
  if (isImeEvent(e)) return false
  const p = parseKey(spec)
  const mac = platform === 'mac'
  const modDown = mac ? e.metaKey : e.ctrlKey
  const wantMod = p.mod || (!mac && p.ctrl)
  if (modDown !== wantMod) return false
  if (mac ? e.ctrlKey !== p.ctrl : e.metaKey) return false
  if (e.altKey !== p.alt) return false
  if (!SHIFTED_CHARS.has(p.key) && e.shiftKey !== p.shift) return false
  if (!mac && e.ctrlKey && e.altKey) {
    // Ctrl+Alt is AltGr on many Windows layouts (Polish ń, German @): a typed character, not ours.
    if (e.altGraph) return false
    if (e.key.length === 1 && !/[\x20-\x7e]/.test(e.key)) return false
  }
  return keyMatches(p.key, e)
}

/** Duck-typed so tests can pass plain objects; the DOM passes the event target. */
export function targetKind(el: unknown): TargetKind {
  if (!el || typeof el !== 'object') return 'none'
  const node = el as { tagName?: unknown; isContentEditable?: unknown }
  const tag = typeof node.tagName === 'string' ? node.tagName.toUpperCase() : ''
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return 'field'
  if (node.isContentEditable === true) return 'editable'
  return 'none'
}

export function allowedIn(spec: string, rule: InInputs | undefined, kind: TargetKind): boolean {
  if (kind === 'none') return true
  const p = parseKey(spec)
  const effective: InInputs = rule ?? (p.mod || p.alt || p.ctrl ? 'allow' : 'deny')
  if (effective === 'allow') return true
  if (effective === 'editable') return kind === 'editable'
  return false
}

/** Copies what matchKey needs out of a DOM KeyboardEvent. */
export function toKeyEvent(e: KeyboardEvent): KeyEventLike {
  let altGraph = false
  try {
    altGraph = e.getModifierState?.('AltGraph') ?? false
  } catch {
    // older engines without getModifierState
  }
  return {
    key: e.key ?? '',
    code: e.code ?? '',
    metaKey: e.metaKey,
    ctrlKey: e.ctrlKey,
    shiftKey: e.shiftKey,
    altKey: e.altKey,
    isComposing: e.isComposing,
    keyCode: e.keyCode,
    altGraph,
  }
}

/** The aria-keyshortcuts spelling ("Meta+Alt+S" on a Mac, "Control+Alt+S" elsewhere). */
export function ariaKey(spec: string, platform: Platform): string {
  const p = parseKey(spec)
  const mods = [
    p.ctrl && platform === 'mac' && 'Control',
    (p.mod || (p.ctrl && platform === 'other')) && (platform === 'mac' ? 'Meta' : 'Control'),
    p.alt && 'Alt',
    p.shift && 'Shift',
  ].filter(Boolean)
  const key = p.key === ' ' ? 'Space' : p.key.length === 1 ? p.key.toUpperCase() : p.key
  return [...mods, key].join('+')
}

/** What a key press in the Settings capture box means (docs/adr/1405-*). */
export type Captured =
  | { kind: 'key'; spec: string }
  /** a modifier alone, an IME composition, a key with no name: keep waiting */
  | { kind: 'ignore' }
  /** Esc: stop capturing, keep the old key */
  | { kind: 'cancel' }
  /** the Windows key, or a character typed with AltGr: never a shortcut here (matchKey refuses them) */
  | { kind: 'invalid'; reason: 'winKey' | 'altGraph' }

const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'Fn', 'FnLock', 'OS', 'Hyper', 'Super', 'NumLock', 'ScrollLock'])
const CODE_PUNCT: Record<string, string> = Object.fromEntries(Object.entries(PUNCT_CODE).map(([ch, code]) => [code, ch]))

/**
 * The spec for a pressed combination — the inverse of matchKey, so the key that was pressed matches
 * the spec that is saved: letters and digits by the physical key when ⌥, Shift, a dead key or a Korean
 * layout changed the character (an ASCII letter on the key wins, as for AZERTY), punctuation by its
 * unshifted character, a Shift character typed alone as itself ("?"), named keys by name.
 */
export function specFromEvent(e: KeyEventLike, platform: Platform): Captured {
  if (isImeEvent(e)) return { kind: 'ignore' }
  if (MODIFIER_KEYS.has(e.key)) return { kind: 'ignore' }
  const mac = platform === 'mac'
  if (!mac && e.metaKey) return { kind: 'invalid', reason: 'winKey' }
  if (!mac && e.ctrlKey && e.altKey && (e.altGraph || (e.key.length === 1 && !/[\x20-\x7e]/.test(e.key)))) {
    return { kind: 'invalid', reason: 'altGraph' }
  }
  const mod = mac ? e.metaKey : e.ctrlKey
  const ctrl = mac && e.ctrlKey
  let shift = e.shiftKey
  if (e.key === 'Escape' && !mod && !ctrl && !e.altKey && !shift) return { kind: 'cancel' }

  let key = ''
  const letter = /^Key([A-Z])$/.exec(e.code)
  const digit = /^Digit([0-9])$/.exec(e.code)
  if (isAsciiLetter(e.key)) key = e.key.toLowerCase()
  else if (letter) key = letter[1].toLowerCase()
  else if (digit) key = digit[1]
  else if (e.key === ' ' || e.code === 'Space') key = 'Space'
  else if (!mod && !ctrl && !e.altKey && SHIFTED_CHARS.has(e.key)) {
    // "?" typed on its own: the character, Shift implied (whatever key the layout puts it on)
    key = e.key
    shift = false
  } else if (CODE_PUNCT[e.code]) key = CODE_PUNCT[e.code]
  else if (e.key.length > 1 && e.key !== 'Unidentified' && e.key !== 'Dead' && e.key !== 'Process') key = e.key
  else if (e.key.length === 1 && /[\x21-\x7e]/.test(e.key)) {
    key = e.key
    if (SHIFTED_CHARS.has(key)) shift = false
  }
  if (!key) return { kind: 'ignore' }
  const spec = [ctrl && 'Ctrl', mod && 'Mod', e.altKey && 'Alt', shift && 'Shift', key].filter(Boolean).join('-')
  return { kind: 'key', spec }
}
