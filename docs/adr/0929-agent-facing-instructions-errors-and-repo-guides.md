# 0929. Agent-facing text: server instructions, tool descriptions, errors, AGENTS.md and llms.txt

- Status: Accepted
- Date: 2026-11-07

## Context
The old instructions told agents to `list_workspaces` → `list_pages`/`search` → `read_page`, the
most expensive path. 404s said only "does not exist or you don't have access". Coding agents working
on this repository had to rediscover rules that already lived in CONTRIBUTING.md and ADRs.

## Decision
- **Instructions** (`mcp.ts` `SERVER_INSTRUCTIONS`): five short English sentences in cost order:
  find_context first; outline → section / read_pages when that is not enough; patch_section for
  edits with conflict retry; changes_since with a stored cursor for sync; Markdown/wiki-link/trash
  facts. A constant string (no per-request insertion) so clients can cache it (ADR 0937); a
  read-only connection appends one fixed sentence (ADR 0935).
- **Descriptions** say when to use the tool and when not ("prefer find_context", "prefer
  patch_section"), state defaults and limits, and name the ids the result carries.
- **Errors say what to do next.** `mcpTools/core.ts` appends a hint per status: 404 → "use
  find_context or list_pages to get a valid id", 403 → "use list_workspaces", 409/412 → "re-read and
  retry", 429 → "wait a minute". Section errors list valid anchors; patch conflicts return the
  current text and version; a missing baseVersion says where to get one.
- **`AGENTS.md`** at the repository root: layout, commands, and the hard rules already documented
  elsewhere (pins, migrations, tests, ADRs, MCP permission pattern), each with a link to its source.
  **`llms.txt`**: an index of the public docs in the llms.txt format.

## Alternatives considered
- Long instructions with examples: every client pays them on every session; descriptions carry the
  per-tool details instead.
- Dynamic instructions listing the user's workspaces: saves one call but breaks prompt caching and
  leaks workspace names into every session's system prompt.

## Trade-offs
Hints are generic per status code; a route-specific hint needs a code-specific message from the route.

## How others solve it
Anthropic's tool-use guidance and the MCP spec recommend descriptions that say when to use a tool;
llms.txt (llmstxt.org) is the common convention for an LLM-oriented docs index; AGENTS.md is the
cross-tool convention for repository instructions to coding agents.

## Consequences
New tools follow the same pattern: wrap/wrapWrite, call() through REST, next-step error text.

## References
- apps/server/src/mcp.ts:144 (`SERVER_INSTRUCTIONS`)
- apps/server/src/mcpTools/core.ts:48 (`call`, `NEXT_STEP`)
- apps/server/src/routes/context.ts (`sectionNotFound`, conflict body)
- AGENTS.md, llms.txt
