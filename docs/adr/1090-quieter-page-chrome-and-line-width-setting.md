# 1090. Quieter page chrome: ⋯ menu, line-width slider, title-heading dedupe on import

- Status: Accepted
- Date: 2026-11-07

## Context
Next to Obsidian the document screen looked busy: nine or ten icons in the top bar (two bells side
by side), a lighter box behind the body in dark mode (BlockNote's `#1f1f1f` editor background),
near-white table borders (`#ddd`), body H1 (48px) larger than the page title (36px), colour emoji
(📄📁) as the default tree icons, and imported Markdown repeating the title as a first `# Title`.
The body width was a single on/off setting ("readable line length", fixed `max-w-4xl`).

## Decision
- **Top bar**: bookmark, share, presence (avatars + connection dot), right panel and the global bell
  stay. Pen mode, edit lock, page notifications, PDF/print and theme move to the ⋯ menu, now shown at
  every width (it was phone-only). States that left the bar are kept visible: lock set or page
  followed → a dot on ⋯ and a check on the item. On phones share and the panel also fold into ⋯.
  Keyboard paths (Esc for pen mode, the command palette's theme/panel commands) are unchanged.
  The page-notification panel opens in the same modal on desktop as on phones.
- **Line width** is a per-device number (`prefs.lineWidth`, localStorage): 600–1200 px of body
  *text* (the column adds the 54px BlockNote gutters and its padding), or 0 = full. Default 700 px,
  close to Obsidian's readable line length. Old saves migrate in `load()`: `readableLineLength`
  true → 700, false → full. The per-page "Full width" still wins. Kept per device, not per account,
  because screens differ (Mac vs tablet).
- **Editor CSS** (index.css): editor background transparent and text in `--color-ink`; table cell
  borders `--color-line` (same as database tables and query results); headings H1 1.75em /
  H2 1.4em / H3 1.2em (phones 1.5 / 1.3 / 1.15).
- **Header on the text line**: the document header (cover, icon, title, lock/provenance notices) gets the
  editor's 54px block-handle gutter as side padding (`.nd-doc-head`, 0 on phones like the editor), so the
  title starts where the body text starts; the handles stay in the gutter. Icon and "Add cover/icon"
  buttons pull their hover padding into the gutter (`-ml-1.5`) so their glyphs sit on the same line.
- **Default icons**: a page without a chosen icon shows a muted line icon (Icons.tsx style) in
  lists, and nothing above the title (a hover "Add icon" instead). Chosen emoji are unchanged.
  `pageIcon()` (string) remains for text-only uses.
- **Import**: Markdown/zip and Notion imports drop a first block that is an H1 equal to the page
  title (NFC, whitespace-collapsed, case-folded; headings with children are kept). Existing pages
  are not rewritten.

## Alternatives
- A per-account width setting: rejected, the same account is used on very different screens.
- Hiding the duplicate H1 at render time instead of on import: would hide a heading the user may
  have written on purpose in an existing page, and diverge from exports and agents' view.
- Keeping the theme button in the bar: theme is also in Settings and the command palette; it is
  rarely changed per page.

## Consequences
- One more click for pen mode, lock and print on desktop.
- Pages keep the same blocks; only new imports change.
