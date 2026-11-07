# 0402. Plugin permissions: parent proxies with the user's session; server re-checks

- Status: Accepted (experimental `plugins`)
- Date: 2026-11-07

## Context
Plugins need data (read/search pages, write pages, store settings) but cannot hold credentials:
the sandbox has no cookies and no network. Every access must stay within (a) the permissions the
administrator granted and (b) what the signed-in user can see.

## Decision
No plugin tokens. The frame sends RPCs over its MessagePort; the parent broker validates size,
rate, schema, declared contributions and the **approved** permission set before calling
`/api/plugins/:id/*` with the user's own cookie. Those routes accept cookie sessions only, return
404 unless the plugin is active, check the permission again, and then reuse the app's guards:
`findVisiblePage` + `requireMembership` (pages.get), or an internal `inject` into the existing
search / content routes with the same cookie and client IP (pages.search, pages.update), so
visibility, membership and rate limits are exactly those of the user. `pages.update` additionally
requires a user confirmation in the parent (one pending dialog per plugin, ≥ 3 s apart) and keeps a
pre-edit snapshot (existing content route behaviour).

## Alternatives considered
- **Scoped plugin tokens (OAuth-like)**: would require a token inside the sandbox and a second
  authorisation system; a leaked token outlives the page.
- **Parent-only checks**: sufficient against the sandbox, but a server re-check makes the
  permission model testable server-side and survives a parent-side bug.
- **Dedicated plugin data queries**: would duplicate (and risk diverging from) visibility rules.

## Trade-offs
Each proxied call costs one extra in-process request (`inject`). Plugin RPC routes have their own
per-IP rate limits on top of the broker's per-frame limits.

## How others solve it
Figma and Slack app UIs call host APIs via message passing rather than holding tokens; VS Code
gates extension API surface by contribution declarations.

## Consequences
A plugin can never act as anyone but the signed-in user and never see more than that user. Adding
a capability means adding a broker method, a permission mapping and a server route.

## References
- apps/web/src/plugins/broker.ts:105 (`receive` pipeline)
- apps/web/src/plugins/protocol.ts:73 (`METHOD_PERMISSION`), :144 (`validateParams`)
- apps/web/src/plugins/host.ts:102 (`makeHandlers`, confirmation gating)
- apps/server/src/plugins/routes.ts:85 (`getActivePlugin`), :308 / :331 / :351 (pages routes)
- apps/server/src/pageDto.ts:110 (`findVisiblePage`), apps/server/src/routes/pageContent.ts
