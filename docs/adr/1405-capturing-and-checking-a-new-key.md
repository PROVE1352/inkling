# 1405. Capturing a new key and checking it before it is saved

- Status: Accepted (uses 1400, 1401, 1404)
- Date: 2026-11-09

## Context
A key typed into a Settings box has to come out as the same spec that `matchKey` (ADR 1400) will later match:
⌥ and Shift change `e.key` (⌥S is ß, ⇧7 is &), a Korean layout gives ㄱ for R, an IME composition sends keydowns
that are not keys, Windows has a Windows key that `matchKey` never accepts and AltGr characters that are typing.
And not every key may be taken: a lone letter would be typed text, Enter or Tab on their own would steal the key
from every button and field, some keys never reach a page, and two commands on one key only one of which can run.

## Decision
- **Capture** (`specFromEvent` in `keys.ts`, the inverse of `matchKey`): modifier-only presses and IME keydowns
  (`isComposing`, keyCode 229) are ignored; Esc alone cancels; on Windows/Linux the Windows key and AltGr characters
  are refused with a message. Letters and digits come from `e.code` when `e.key` is not an ASCII letter (⌥, Shift on
  digits, dead keys, Korean layout), an ASCII letter on the key wins (AZERTY, as in `matchKey`); punctuation is
  stored unshifted (⌘⇧\\ → `Mod-Shift-\`); a Shift character typed alone stays the character (`?`). The capture
  box is focused when it mounts and swallows every key (preventDefault, stopPropagation), so no app shortcut runs
  while a key is being chosen. A spec from the capture always matches the same press again (tested).
- **Rules** (`checkBinding` in `remap.ts`), in this order:
  1. `via: 'blocknote'` and `via: 'browser'` commands cannot be changed (ADR 1406); Settings marks them **Built in**.
  2. A single character needs ⌘/⌃/⌥ (Ctrl/Alt elsewhere) — everywhere, Shift does not count.
  3. A named key without ⌘/⌃/⌥ is allowed only for F1–F12, and for the sidebar tree and the database table
     (arrows, Enter, Tab, Space, Home/End, Page Up/Down), where focus is never in text. Esc is never a key.
  4. **Refused**: the reserved keys of ADR 1401 (`RESERVED_KEYS`) that a page never receives or must not take —
     window/tab/app keys, screenshots, Mission Control, developer tools, clear browsing data — and select all / copy /
     cut / paste (and Shift+Insert, Ctrl+Insert off a Mac).
  5. **Refused**: a key held by a command that cannot change (⌘B for bold, ⌘C for table copy), or one of the editor's
     own keys that are not registry rows (headings 4–6, quote, code block, delete word, the Mac's Ctrl+A/E/H/D) for a
     command that is live while the editor has focus (global, page, editor scope). The editor would run first.
  6. **Asked**: other commands on the key where both are live (`findConflicts` on the registry with the user's keys
     applied, so scopes and `shadows` work as for the defaults). The message names them; "Use it here" takes the key
     away from them (they keep their other keys, or none), Cancel keeps both.
  7. **Warned, allowed after confirming**: keys a browser tab keeps but the installed app receives (⌘N, ⌘⇧N, ⌘⇧P,
     and on a Mac ⌘⌥←/→ — the keys stage 1 already binds with `reservedOk`), and browser functions a page can take
     over (find ⌘F/F3, reload ⌘R/F5, save ⌘S, zoom ⌘=/⌘-/⌘0, history ⌘[ ⌘] ⌘Y, bookmarks, downloads, F11 …).
     "Use anyway" saves.
- **Default** puts one command's keys back; if another command took one of them meanwhile, it asks first and then
  takes it back. **Reset all** clears the store after a confirmation. **Import** drops entries that break rules 1–5
  and refuses the whole file if two commands would end up on one key (listing them); a file that is not JSON or not
  an Inkling shortcut export is refused.

## Alternatives
- **Refuse every reserved key** (no warning tier): simpler, but ⌘N, ⌘⇧N and ⌘⌥←/→ do work in the installed app,
  where many people run Inkling, and stage 1 binds some of them for that reason.
- **Allow everything with a warning**: a key that never reaches the page would be saved and silently do nothing; a
  binding on ⌘C would break copying in every field.
- **Silently take the key from the other command**: the person may not notice which command lost its key.
- **Let a global command take a key the editor binds**: it would work everywhere except in the editor, where the
  editor's binding runs first — two behaviours for one key.

## Consequences
- Keys bound inside tiptap that are neither registry rows nor in the editor list here (rare emacs-style keys on
  other platforms) are not checked; the editor would win there. The list lives next to the rules in `remap.ts`.
- Tests: `keys.test.ts` (`specFromEvent`: ⌥, Korean layout, Shift digits, dead keys, AZERTY, IME, Esc, Windows key,
  AltGr, round trip with `matchKey`), `remap.test.ts` (each rule, conflicts by scope, replace, reset taking back,
  import refusing clashes), e2e (bare letter, ⌘⌥I, ⌘B, ⌘⇧N warning, ⌘K conflict cancel/replace, reset, Windows key).
