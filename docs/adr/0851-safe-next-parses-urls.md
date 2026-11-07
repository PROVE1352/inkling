# 0851. `?next=` redirects are validated by URL parsing, not by prefix

- Status: Accepted
- Date: 2026-11-07

## Context
Login and Register navigate to `?next=` after success (`lib/nav.ts` `safeNext`). The guard
accepted any value that started with `/` but not `//` (audit C-M7). WHATWG URL parsing treats `\`
like `/` in special schemes and strips tab, CR and LF, so `/\evil.com` and `/\t/evil.com` resolve to
`https://evil.com/`: an open redirect from a trusted login link.

## Decision
`safeNext(next, origin = location.origin)` requires a leading `/` and then parses with
`new URL(next, origin)`, the same way the browser will navigate. It returns
`pathname + search + hash` only when the parsed origin equals the app origin and the scheme is
http(s). Anything else, including parse errors, becomes `/`. A normalised path that starts with
`//` (for example from `/.//evil.com`) is rejected as well, because a router would treat it as
protocol-relative.

Tests: `apps/web/src/lib/nav.test.ts` covers `//evil.com`, `/\evil.com`, `/\/evil.com`,
`/\t/evil.com`, CR/LF variants, `https://evil.com`, a look-alike host, `javascript:`, `data:`,
dot-segment tricks, and valid paths with query and hash.

## Alternatives considered
- Regex blocklists for `\` and control characters. They are brittle and must track the URL
  spec's normalisation rules. Parsing gives exactly the browser's answer.

## Trade-offs
The returned value is the normalised path (dot segments resolved), not the raw string.
