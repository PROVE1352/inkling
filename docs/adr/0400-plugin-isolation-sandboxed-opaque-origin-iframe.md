# 0400. Plugin isolation: sandboxed opaque-origin iframe + strict CSP + MessagePort

- Status: Accepted (experimental `plugins`)
- Date: 2026-11-07

## Context
Plugin code is third-party JavaScript that runs in every user's browser on a shared, multi-user
server. It must not reach the session cookie, the app DOM, browser storage, other users' data or
the network, and a buggy or hostile plugin must not be able to freeze or spam the app.

## Decision
Each plugin instance (hidden command worker or visible block) runs in
`<iframe sandbox="allow-scripts">` — never `allow-same-origin` — loading
`/api/plugin-frame/<id>/<hash>/index.html`. That response carries its own CSP:
`default-src 'none'; script-src 'nonce-<fresh>'; connect-src 'none'; form-action 'none';
base-uri 'none'; frame-ancestors 'self'; sandbox allow-scripts` (+ `nosniff`, `no-referrer`,
deny-all Permissions-Policy). Exactly two scripts run: the app-owned SDK and the approved bundle.
On the first `load` the parent transfers a `MessagePort` to that `contentWindow`; all traffic then
flows over the port as JSON strings. A second `load` (self-navigation) kills the frame. A
heartbeat (4 s ping, 12 s deadline) removes unresponsive frames; frame count is capped at 8 and
block frames only exist while on screen (IntersectionObserver).

## Alternatives considered
- **Separate plugin origin** (e.g. `plugins.example.com`): strongest isolation, but every self-host
  operator would need a second hostname + TLS certificate. Opaque origins give the same
  cookie/DOM/storage isolation without extra DNS. Can be added later behind the same protocol.
- **Web Worker / ShadowRealm / SES-style in-page sandbox**: workers cannot render blocks; JS-level
  sandboxes share the app's process and origin and have a long history of escapes.
- **`window.postMessage` with origin checks**: opaque origins are all `"null"`, so origin checks
  cannot tell frames apart; a transferred port binds the channel to one frame instead.
- **`script-src 'self'`**: works in Chrome, but relies on CSP3 "self" semantics for sandboxed
  documents and would also allow loading any other same-origin script; a per-response nonce is
  unambiguous.

## Trade-offs
`style-src 'unsafe-inline'` is allowed inside the frame (harmless in an opaque sandbox). A plugin
can still exfiltrate data it was *granted* by navigating its own frame (no browser can prevent
self-navigation); the parent detects and kills it, but approval remains the trust boundary for
readable data. Killing a busy loop requires the browser to run the frame out of process (Chrome
does; verified in headless Chrome 157).

## How others solve it
Figma runs plugin logic in a sandboxed realm and UI in an iframe with `postMessage`; VS Code web
runs extensions in a Web Worker on a separate origin and webviews in sandboxed iframes; Notion and
Coda embed third-party content via sandboxed iframes. Obsidian runs plugins with full Electron
privileges (no isolation), which is why we do not follow it.

## Consequences
Plugins are asynchronous message-passing programs with no direct DOM or network access. All
capabilities are explicit RPCs that the parent can validate and rate-limit (ADR 0402).

## References
- apps/server/src/plugins/frame.ts:25 (`frameCsp`), :63 (`frameHtml`), :92 (`SDK_SOURCE`)
- apps/server/src/plugins/routes.ts:407 (frame route), :417 (bundle route)
- apps/web/src/plugins/host.ts:238 (`start`, sandbox attributes), :269 (`onLoad` handshake + navigation kill), :306 (heartbeat)
- apps/web/src/plugins/PluginBlock.tsx:85 (IntersectionObserver)
- apps/server/src/plugins/browser-harness/ (real-browser verification)
