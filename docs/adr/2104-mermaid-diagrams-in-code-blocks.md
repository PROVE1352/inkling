# 2104. Mermaid diagrams are code blocks in language `mermaid`, drawn on demand

- Status: Accepted
- Date: 2026-11-10

## Context
Notion and Obsidian draw ```mermaid fences; Inkling showed the source only. Agents already write
Mermaid in Markdown, and the fence must keep round-tripping byte for byte through MCP, vault sync and
exports. Mermaid is large (5.1 MB of chunks over all diagram types) and most pages have no diagram.

## Decision
- **The block stays a code block** (`language: mermaid`, or `mmd`): no schema change; the diagram is
  view state. The node view gets a non-editable host after the code (the query block's pattern,
  QueryBlock.tsx) and `<MermaidPortals>` renders into it (`components/blocks/MermaidBlock.tsx`, wired
  in the page editor and the row-template editor; the page-embed viewer shows the code). Public pages
  draw them in the reader's browser since integration (ADR 2191).
- **Code and diagram**: the code shows while the caret is in the block, while the source is empty or
  has an error, and always after "Show code" (per block, per tab, not stored); otherwise only the
  diagram. Clicking the diagram puts the caret into the code. Edits re-render after 350 ms. A syntax
  error is one short line in the block (Mermaid's message, two lines at most); the page never breaks.
- **Loading**: `import('mermaid')` on the first diagram (`lib/mermaid.ts`); Mermaid and the libraries
  only it uses (including the d3 parts only its charts use) are emitted under `assets/lazy/` (vite.config.ts `LAZY_ONLY`) and not precached by
  the service worker. Renders run one at a time (Mermaid's configuration is global) and are cached per
  (theme, source), 200 entries.
- **Dependency**: `mermaid` 12.3.0, exact (ADR 0882), released 2026-11-03 — past pnpm's minimum
  release age; package.json and pnpm-lock.yaml changed together, no workspace exceptions.
- **Agents**: nothing changes — read_page shows the ```mermaid fence, patch_section writes it back as
  written; `[[…]]` inside code is no longer turned into links on import (ADR 2100), so `A[[Name]]`
  survives. Notion: the publish mapper already sends `mermaid` as a Notion code language, and Notion's
  Markdown export arrives as a ```mermaid fence.

## Measurements (`vite build`, HEAD vs HEAD + this change, other 0.17 work excluded)
| chunk | before | after |
|---|---|---|
| entry `index-*.js` | 413.91 kB (gzip 114.58) | 413.86 kB (gzip 114.57) |
| editor `PageView-*.js` | 521.27 kB (gzip 144.09) | 533.19 kB (gzip 148.44) |
| precache | 94 entries, 4313.82 KiB | 95 entries, 4327.98 KiB |
| Mermaid, lazy (all diagram types) | — | 90 files, 5.16 MB (gzip 1.44 MB) |
| first flowchart (static closure) | — | 26 files, 941 kB (gzip 246 kB) |

The one new precached entry is d3-interpolate's core (`value`), now a chunk shared by the editor, the
canvas and Mermaid; the d3 parts only Mermaid's charts use (d3-scale, d3-array, d3-shape, …, cubehelix)
are in `LAZY_ONLY`. A static-import walk from the entry, editor and code-block chunks reaches none of
the Mermaid chunks.

## Alternatives considered
- **A new `mermaid` block type.** Schema change on both sides and a second Markdown notation for what
  is already a fenced code block.
- **Render in a sandboxed iframe (securityLevel `sandbox`).** Sizing, printing and presentation copies
  of iframes are awkward; an `<img>` gives the same "no script" guarantee (ADR 2105).
- **Server-side rendering.** Mermaid needs a browser layout engine (headless Chrome on the server).

## Trade-offs
- The first diagram on a page costs about 250 kB gzip of downloads (cached afterwards).
- Diagrams are images: their text is not found by find-in-page or selectable (the code is).
