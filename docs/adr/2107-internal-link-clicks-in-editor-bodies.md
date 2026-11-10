# 2107. Internal link clicks in editor bodies: one owner per click

- Status: Accepted
- Date: 2026-11-10

## Context
Page links are drawn as `<a href="/w/…" target="_blank">`. The editor moved in the app on a click on
such a link (`onClickCapture` + React Router), but BlockNote's link plugin also handles clicks in an
editable editor (on mouseup, before the click event) and calls `window.open(href, '_blank')` for every
link. A click on `[[Page]]` or `[[Page#Heading]]` therefore moved the current tab and opened the same
page in a new tab. ⌘-click moved the current tab as well, and inside a page embed's read-only body a
plain click did the same double move. This has been so since the first commit (BlockNote 0.51.4 and the
capture handler arrived together).

Chrome does not follow links inside `contenteditable` at all (no click, ⌘-click or middle click), so in
an editable body only script opens a tab; in a read-only body (`editable={false}`, or the embed viewer
inside an editable page) the browser follows the link itself.

## Decision
- BlockNote's `links.onClick` (an editor option, no patch) is ours: `editorLinkClick` in
  `apps/web/src/lib/internalLinks.ts`. It always reports the click handled, so BlockNote's own
  `window.open` never runs, and:
  - a plain click on an internal link (same origin, `/w/…`) does nothing there: the click handler moves
    in the app;
  - a link in a read-only island inside the editor (`!isContentEditable`, the embed body) is left to
    the browser;
  - anything else (external links, ⌘/Ctrl/Shift/Alt-click on internal links) opens one new tab with
    `noopener,noreferrer` (BlockNote's call passed no features).
- The click handler (`internalLinkClick`) moves in the app only for a plain primary click on an
  internal link and not for a click an outer body already handled (the embed body's handler runs after
  the editor's). Absolute same-origin hrefs count, other origins and protocol-relative URLs do not.
- A middle click on a link in an editable body opens a new tab (`editableLinkAuxClick`); elsewhere the
  browser does it.
- The page editor, the row-template editor (`LocalDocEditor`) and the page-embed body share these
  functions. Public pages keep their own handler, which already left modified clicks to the browser.

## Alternatives
- Patching BlockNote's click handler: the option exists, and patches are kept for what options cannot do.
- Dropping `target="_blank"` from internal links: the click plugin opens a window either way, and
  read-only bodies rely on the browser's new-tab behaviour for modified clicks.
