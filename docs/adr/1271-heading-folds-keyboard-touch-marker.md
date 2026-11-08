# 1271. Heading folds: keyboard shortcut, touch screens, "…" marker

- Status: Accepted (extends 1221)
- Date: 2026-11-08

## Context
ADR 1221 shipped folds for a mouse only: the arrow appears on hover, so there was no way to fold from
the keyboard or on a phone, and a folded heading looked like an ordinary one except for its arrow.

## Decision
- **Shortcut ⌘. (Mac) / Ctrl+. (others)** folds or unfolds the section at the caret: the top-level heading
  the caret is in, otherwise the nearest top-level heading above the caret's top-level block (pure
  function `foldTarget` in `lib/headingFolds.ts`). When the caret is in the section's body or in the
  heading's nested children, it first moves to the end of the heading; otherwise the fold would hide the
  caret and `foldsToOpen` would reopen it at once (the ADR 0850 safety rule). Registered in
  `HeadingFolds.tsx` next to the ⌘F handler, listed in the shortcut list.
  Conflict check: nothing in the app, BlockNote 0.51.4 or tiptap binds Mod-. (grep of the keymaps and of
  AppLayout's global handler). Browsers: Safari binds ⌘. to "Stop loading"; the page receives the
  keydown first and the handler calls `preventDefault` only when it acts, but this was not verified in a
  real Safari (headless WebKit has no menu shortcuts), nor in desktop Chrome or Firefox. Windows' emoji
  panel is Win+., not Ctrl+.. Some Chinese IMEs use Ctrl+. for punctuation width; the handler ignores
  keys during composition. VS Code (Ctrl+Shift+[ / ]) and Obsidian (no default) were considered; ⌘. is
  one chord, free in Inkling and reads as "collapse" in macOS outliners.
- **Touch screens**: where there is no hover (`(hover: hover) and (pointer: fine)` does not match), the
  arrow shows next to the top-level heading the caret is in. Tap a heading, then tap the arrow; folded
  headings keep their arrow. Phones have no left gutter (the editor's side padding is 0 below 640 px; the
  arrow left of the text was cut off at the screen edge), so on touch the 28 px arrow sits at the right
  end of the heading's first line, and top-level headings get 30 px of right padding so text never runs
  under it. Rejected: long-press on the heading (the system text-selection gesture in both iOS and
  Android, so it would fight selection and the callout menu), always showing every arrow (noise on every
  heading of every page), a "fold" entry in the block menu (block handles are hidden on phones).
- **"…" marker** after the text of a folded heading that hides something: a `::after` pseudo-element in
  the generated fold stylesheet (`foldCss`), styled with the theme tokens, with an empty alternative text
  for screen readers. Not a DOM node, so ProseMirror never sees it and the caret cannot enter it; no
  attribute or class on editor DOM (ADR 1221). Typing at the end of a folded heading puts the text before
  the marker (checked with real keys in Chromium and WebKit).
- **⌘F / Ctrl+F** keeps opening every fold of the page (ADR 1221): the browser's find bar cannot report
  which match it is on, and opening only the folds that contain the search text would need the query,
  which the page never sees. Documented in the guide.

## Verification
`scripts/editor-typing/run.mjs`, 30 runs each in headless Chromium and WebKit, keys with no delay:
fold with ⌘. from the section body, Enter at the end of the heading, `abcdef` Enter `ghijkl` (the fold
opens, both lines kept), and ⌘. then `XYZ` (appended to the heading, section still folded). Phone flow
(tap heading, tap arrow, type) in WebKit and Chromium with `hasTouch` at 390 px.

## Consequences
- On touch screens top-level headings wrap 30 px earlier.
- Folds made with the shortcut are stored like the others: per page, on this device.
- In Safari ⌘. may still stop a page load in some states; the arrow remains.
