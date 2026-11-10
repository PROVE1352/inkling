# 1843. Presentation mode: slides from headings, read-only copies

- Status: Accepted
- Date: 2026-11-10

## Context
People present meeting notes and study pages straight from Inkling; scrolling a long page on a
projector is awkward. A separate slide format would mean a second copy of the content.

## Decision
- **Split** (`lib/present.ts`, unit-tested on jsdom): the page's top-level blocks; every heading of
  the highest level present starts a slide; a divider ends one and is not shown. Slide 1 is the page
  title plus whatever comes before the first split. Blank blocks at slide edges are dropped.
- **Read-only by construction**: slides show copies of blocks — `cloneNode` of the live editor's
  top-level blocks (no `data-id`, no `contenteditable`, inputs disabled) in the app, and the already
  sanitized server HTML parsed in an inert `<template>` on public links. The editor never becomes the
  slide, so keys and clicks cannot reach the document.
- **Full screen** through the Fullscreen API where allowed, a fixed overlay otherwise (iOS Safari);
  leaving full screen ends the presentation. Keys: ←/→, PageUp/PageDown, Space, Home/End, Esc
  (captured, so app shortcuts underneath do not fire). Touch/pen swipe (≥ 50 px, mostly sideways).
- **Motion**: the slide change fades only without `prefers-reduced-motion` (checked at open, and the
  `nd-fade` class is off under reduced motion in index.css anyway).
- **Where**: "Present" in the page ⋯ menu (documents), and a "Present" button on shared pages
  (single links and folder children). It mounts as a sibling keyed `pres:<pageId>`.

## Alternatives considered
- **`editor.blocksToFullHTML` in the app**: renders custom React blocks (embeds, queries, charts)
  outside their providers; the live DOM already shows them correctly.
- **Read-only BlockNote instance per slide**: heavy, and one editor per page is the rule.
- **Split at every heading level**: a page with H2 + H3 becomes dozens of tiny slides.

## Consequences
- Folded headings show in full on slides; fonts scale with the viewport (`clamp`).
