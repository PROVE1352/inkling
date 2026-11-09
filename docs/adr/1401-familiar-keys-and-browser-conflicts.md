# 1401. Familiar keys from Notion and Obsidian, checked against browser and OS keys

- Status: Accepted (uses 1400)
- Date: 2026-11-09

## Context
People who come from Notion or Obsidian reach for the same keys: move a block, duplicate it, turn it
into a heading, tick a to-do, open the right panel, star the page. Some of those already worked through
BlockNote and nobody knew; some were missing; some collide with what the browser or the OS does with the
same chord. A page never receives the keys a browser reserves (in a Chrome tab: ⌘N/⌘T/⌘W and their ⇧
forms, ⌘⌥←/→ on a Mac, Ctrl+Tab), and other chords are the browser's unless the page calls
`preventDefault` (⌘L address bar, ⌘D bookmark, ⌘P print).

## Decision
Keys added or confirmed in 0.11 (Mac / Windows and Linux):

| Key | Command | Checked against | Result |
|---|---|---|---|
| ⌘⇧↑ / ⌘⇧↓ (Ctrl+Shift+↑/↓) | Move block up / down | BlockNote 0.51.4 binds `Shift-Mod-ArrowUp/Down` (`moveBlocksUp/Down`). In a text field the same chord selects to the start/end; inside the editor BlockNote takes it. | Already there; listed. |
| ⌘⌥0 / ⌘⌥1–3 (Ctrl+Alt+0–3) | Text, heading 1–3 | BlockNote binds `Mod-Alt-0..6`. On a Mac ⌥ turns the key into ¡™£; prosemirror-keymap falls back to the key code, verified with real keys. On Windows AltGr layouts (German Ctrl+Alt+2 = ²) prosemirror-keymap deliberately skips that fallback, so the character is typed. | Already there; listed. |
| ⌘Enter (Ctrl+Enter) | Check / uncheck the to-do | Not bound by BlockNote or the tiptap marks. The ⌘Enter of the math field, the comment box and the day popover belong to those fields (not the editor's keymap). | New. On other blocks it does nothing (Notion). |
| ⌘L (Ctrl+L) | Turn into a to-do / toggle it | Address bar in every browser; only while the caret is in a document (editor keymap), as since M10. | Kept. |
| ⌘D (Ctrl+D) | Delete the block | Obsidian's "delete paragraph"; the browser's bookmark key outside the editor. Notion uses ⌘D for duplicate. Changing it would turn a key people already use into a different edit. | Kept. |
| ⌘⇧D (Ctrl+Shift+D) | Duplicate the block | Chrome/Edge/Firefox: "bookmark all tabs", not reserved (the page sees it first). Safari: "Add to Reading List" — untested (see below). Editor only. ⌘⌥D rejected: macOS takes it for the Dock. | New. The copy gets new block ids (two blocks with one id break Yjs lookups). |
| Tab / ⇧Tab | Indent / outdent | BlockNote's `nestBlock`/`unnestBlock`. | Already there; listed. |
| ⌘⌥N (Ctrl+Alt+N) | New page | ⌘N/Ctrl+N is reserved in a browser tab (new window) and reaches the page only in the installed app, so both stay bound and ⌘⌥N is shown first. Polish/Romanian AltGr+N types ń — the AltGr rule (1400) keeps it text. | Kept from M10; reasoned, not provable headless (see below). |
| ⌘⌥S (Ctrl+Alt+S) | Add to / remove from favorites | No binding known in Chrome, Edge, Firefox or Safari on either system. ⌘⇧B (Chrome bookmarks bar), ⌘⌥B (bookmark manager), ⌘D (editor delete) rejected. Polish AltGr+S types ś — stays text. | New. Page scope; off for guests. |
| ⌘⌥\ (Ctrl+Alt+\\) | Right panel open / close | Mirrors ⌘\ for the left sidebar. ⌘⇧\ rejected: Safari "Show All Tabs". | New. |
| ⌘⌥P (Ctrl+Alt+P) | Pen mode on / off | ⌘⇧P rejected: Firefox private window (reserved). Only on documents the viewer can edit. | New. |
| ⌘P (Ctrl+P) | Command palette | Print, prevented (since M10; Obsidian's key). Before 0.11 Ctrl+Alt+P on Windows also opened it; modifiers now match exactly. | Kept (ADR 1402). |
| ⌘⌥← / ⌘⌥→ (Alt+← / Alt+→) | Back / forward | In a Chrome or Edge tab on a Mac this is "next/previous tab" and reserved; the page never sees it. The browser's ⌘[ / ⌘] does the same history step there. The installed app gets the key. | Kept; collision documented in the guide. |

Every registry key is also checked by `registry.test.ts`: no two commands share a key where both can
be live (same scope, or one of them global/page), and no command binds a reserved browser/OS key
(`RESERVED_KEYS`: tab/window keys, macOS window and screenshot keys, devtools, private window) unless it
says so with `reservedOk` — today only ⌘N (installed app) and ⌘⌥←/→ (installed app).

## Verification
- Real key presses in headless Chromium against a running server (`scratchpad/w11/e2e.mjs`): ⌘⌥S,
  ⌘⌥\, ⌘⌥P, ⌘⌥N, ⌘K from the editor, Ctrl+K ignored on a Mac, the Windows key ignored on Windows,
  Ctrl+Alt+1 and Ctrl+Shift+↑ with a Windows `navigator.platform`, an AltGr ń keydown ignored, `?` typed
  into fields.
- `scripts/editor-typing/run.mjs` scenarios `block-move`, `heading-level`, `check-toggle`, `duplicate`,
  `delete-block`, each followed by a reload that must show the same stored document, in Chromium and
  WebKit.
- Not verifiable here: whether a real browser window hands a reserved key to the page. Headless browsers
  have no browser chrome and no menus, so Playwright's ⌘N reaches the page there; the table's "reserved"
  column comes from the browsers' documented key lists, not from a run. Safari's menu shortcuts (⌘⇧D,
  ⌘L) were not tried in a real Safari.

## Consequences
- Notion users pressing ⌘D get a delete (undo brings the block back); the guide says so next to ⌘⇧D.
- In a Chrome tab on a Mac, back/forward by keyboard is the browser's ⌘[ / ⌘]; ⌘⌥←/→ works in the
  installed app only.
