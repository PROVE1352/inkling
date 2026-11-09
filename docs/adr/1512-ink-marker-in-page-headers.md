# 1512. Page headers mark handwriting with one line, never its content, and only where agents may read it

- Status: Accepted
- Date: 2026-11-09

## Context
`read_ink` costs images and is meant to be called only when needed (1510). An agent cannot know a
page has handwriting unless something says so. Putting stroke data or a rendered picture into
`read_page` would cost every reader.

## Decision
- `read_page` (full read) adds `- ink: N strokes (read_ink to view)` to its header, and
  `find_context` adds `; ink: N strokes (read_ink to view)` to the fragment's fact line, for pages
  with at least one stroke. Ink content never appears in these tools.
- Only where the workspace allows agents to read handwriting. With the setting off nothing is
  shown: "off" means agents see nothing of the ink layer, not even that it exists, and agents do
  not keep suggesting a tool they cannot use. An agent asked about handwriting can still call
  `read_ink` and gets the refusal that names the setting.
- One query per call: `jsonb_array_length` over `page_ink` joined to the workspace setting
  (`inkStrokeCounts`, `apps/server/src/agentInk.ts`), for ids that already passed the page's
  permission check.
- Not added (yet) to `read_page` outline/section reads and `read_pages`; the full read and
  `find_context` are where an agent decides what to open.

## Alternatives considered
- **Show the marker with the setting off** ("not readable here"): tells the agent handwriting
  exists so it can ask the person; rejected for the reason above, kept as an option.
- **A field in `AgentContextDTO`** (`can:` facts for every page tool): one source for all tools,
  but it changes the shared agent-context route; the two header points are enough for 0.12.

## Consequences
- The marker changes when strokes are added or erased, so the header of a page with ink is as
  stable as its ink (0937).
- Touch points (shared with other work on these tools): `apps/server/src/mcp.ts` read_page full-read
  `header` array (the `inkStrokes` line), and `apps/server/src/mcpTools/contextTools.ts`
  `renderFindContext` (optional `ink` argument, the `inkNote` in the fragment line).
