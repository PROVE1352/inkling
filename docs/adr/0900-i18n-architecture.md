# 0900. UI localization without a library: flat per-area dictionaries and a module-level `t()`

- Status: Accepted
- Date: 2026-11-07

## Context
The web UI was written in Korean with some newer features in English (`strings.ts` modules).
The public release targets an English-speaking audience first while the original deployment keeps
running in Korean. The dependency policy (ADR 0882) rules out adding i18next/FormatJS for this.

## Decision
`apps/web/src/i18n/` holds a small runtime and the dictionaries:
- `en/<area>.ts` is the source of truth; `ko/<area>.ts` is typed
  `Partial<Record<keyof typeof en, string>>`, so a Korean key that does not exist in English is a
  type error. `en.ts`/`ko.ts` merge the areas (core, auth-admin, pages, graph-canvas, shell,
  editor, lib, collection). Keys are flat `'screen.key'` strings; the key type is
  `keyof typeof en`, which stays cheap for `tsc` at a few thousand keys (no recursive path types).
- `t(key, params)` fills `{name}` placeholders (numbers via `Intl.NumberFormat`) and, with a
  numeric `count`, tries `key_<Intl.PluralRules category>` then `key_other`. Missing Korean falls
  back to English with a one-time `console.warn` in dev builds; an unknown key renders as the key.
- `useT()` subscribes a component to locale changes (`useSyncExternalStore`). The app root is
  keyed on the locale (`main.tsx`), so a language switch remounts the tree and every `t()` in
  render re-runs; plain `t()` is therefore safe anywhere except module top level.
- Dates and numbers use `Intl` through `fmtDate`, `fmtDateTime`, `fmtRelative`
  (`Intl.RelativeTimeFormat`), `fmtMonthYear`, `weekdayNames`, `monthNames`, `fmtList`.
  Stored data formats (`YYYY-MM-DD` values, ISO times) are unchanged.
- BlockNote gets its bundled dictionary for the active locale (`@blocknote/core/locales` `en` /
  `ko`); custom slash items are translated with `t()` and keep both English and Korean aliases
  so either keyword finds them.
- `i18n.test.ts` checks that Korean keys are a subset of English, that placeholders match, and
  prints the key counts.

## Alternatives considered
- i18next / react-intl: mature, but new dependencies and more runtime than this needs.
- Nested JSON dictionaries with dot-path types: nicer to browse, but template-literal path types
  over thousands of keys slow `tsc` noticeably.
- Re-rendering through context instead of remounting: avoids losing transient UI state on a switch,
  but every non-component helper would need the locale passed in. Language changes are rare.

## Trade-offs
Switching language remounts the app (open menus, scroll positions and the editor connection are
re-created). Only English and Korean are supported; adding a language is a new `xx/` folder plus
`Locale` and `normalizeLocale` entries.
