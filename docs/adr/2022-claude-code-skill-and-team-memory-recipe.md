# 2022. An Inkling skill for Claude Code and a "team memory" recipe, instead of longer tool descriptions

- Status: Accepted
- Date: 2026-11-10

## Context
The tool list and the server instructions are loaded into every MCP session (about 12,400 tokens in 0.15.1), so
0.15.1 made them shorter (ADR 1945). What they leave out is how to use the tools together: start from
`find_context`, read outline then section, keep `v=` for `baseVersion`, claim before a long rewrite, treat
`Not written` as a suggestion, `inbox` then `ack`, `catch_up` after a break, hand off through comments, split growing
logs. And how a team keeps shared notes usable when several agents write to them.

Anthropic's write-up [The components of agent memory](https://www.anthropic.com/research/components-of-agent-memory)
(read 2026-11-10) reports, among others: a wiki where several agents wrote into one shared table kept 41 of 57
facts (72%) because agents overwrote one another, one page per contract written by one agent kept all 57; longer
instruction files reduce adherence, so the always-loaded layer should stay small and act as an index; a clean-up
pass found nine links to a missing page and repointed them; maintenance sessions merged duplicates and checked
claims against the sources.

## Decision
- **A Claude Code skill** in `examples/claude-skill/inkling/SKILL.md`: frontmatter `name: inkling` and a
  `description` saying when to use it (Claude Code reads both; `name` is lowercase with hyphens and the description
  under 1,024 characters, which also meets the Agent Skills rules; https://code.claude.com/docs/en/skills,
  https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview). The body is the usage order only,
  about 500 words (3.2 KB), and names only tools and arguments that exist in `apps/server/src/mcp.ts` / `mcpTools`. Installed
  by copying the folder to `~/.claude/skills/inkling/` or a project's `.claude/skills/inkling/`.
- **docs/RECIPES.md and RECIPES.ko.md get a "Team memory" part**: one page per item, short instructions as an index,
  periodic checks, the source next to the fact, each with what it is in Inkling's tools. Numbers are quoted only
  where the article states them, with the link.
- The skill is an example file, not something the server serves: it costs tokens only when Claude Code loads it
  for a task that needs it.

## Alternatives considered
- **Put the usage order into the server instructions**: paid by every session of every client, including ones that
  only read.
- **An MCP prompt** (`prompts/get`): a server-side option the 0.16 MCP work may use for other things; a skill
  file works today without a server change and stays out of every session that does not need it.
- **A long skill with every rule from docs/MCP.md**: each load costs its full length; the tool descriptions already
  carry the details.

## Consequences
- The skill names tools; a renamed tool or argument needs the skill updated (the tool surface test lists names).
- The memory-check tool of 0.16 is added to the skill and the recipe at integration (marked in both files).
