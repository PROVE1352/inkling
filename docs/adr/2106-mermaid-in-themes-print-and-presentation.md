# 2106. Mermaid in dark mode, PDF export, presentation and narrow screens

- Status: Accepted
- Date: 2026-11-10

## Decision
- **Themes**: Mermaid's `default` theme in light mode, `dark` in dark mode; a theme switch re-renders
  (cached per theme).
- **PDF export** (browser print, ADR 0307): `printElement` waits up to 4 s for diagrams still in the
  render queue (`mermaidIdle`); while printing, a rendered diagram hides its code and tools, and a
  diagram drawn in the dark theme is inverted (`invert(1) hue-rotate(180deg)`) because print.css prints
  the light palette. The browser's own Ctrl/⌘+P does not wait.
- **Presentation** (ADR 1843, copies of the editor's blocks): a rendered diagram shows without its
  code, tools and language picker.
- **Narrow screens**: the image is at most the block's width and keeps its aspect ratio.

## Trade-offs
- The inverted dark diagram is close to, not equal to, the light theme's colours.
