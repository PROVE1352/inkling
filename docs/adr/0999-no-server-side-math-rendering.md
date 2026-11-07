# 0999. The server never renders math

- Status: Accepted
- Date: 2026-11-07

## Context
The public share page and Markdown export could show pre-rendered equations if the server ran
KaTeX. The server is one Node process: one event loop serves the API, the collaboration
WebSocket and every share page.

## Decision
- The server handles LaTeX only as text: it stores it in the Yjs node, writes it into Markdown
  and into the share page HTML (`data-latex` plus the source as text), and indexes it for search.
  KaTeX is not a server dependency and is never loaded there.
- Every rendering happens in the viewer's browser (ADR 0997, 0998).

## Why
- **Single-threaded event loop.** `katex.renderToString` is synchronous CPU work. A page with
  hundreds of formulas, or one adversarial formula near the limits (`maxExpand`, nested
  `\frac`/`\sqrt`, 4,000 characters), would block every other request and every collaboration
  message for the duration of the render.
- **Unauthenticated load.** Share pages are public: rendering on the server would let anyone turn
  CPU time on the server into a denial of service by requesting a math-heavy public page repeatedly
  (the HTML is rebuilt per request).
- **Nothing to gain for editors.** The editor renders in the browser anyway; only public pages
  would profit.

## Alternatives considered
- **Render on the server, cache the HTML per page version**: still a synchronous render on a cache
  miss, and the cache needs invalidation and memory bounds.
- **Render in isolated `worker_threads` with a time limit**: removes the event-loop risk at the cost
  of a worker pool, a timeout/kill path and per-request memory. Revisit if public pages with math
  prove slow in practice (measure first-display time of real share pages), not before.

## Consequences
- A share page shows the LaTeX source as text until the client renders it, and without JavaScript
  (feed readers, unfurl crawlers) only the source.
- Markdown export and MCP output contain LaTeX, which is what agents and other tools expect.
