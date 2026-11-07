# 0923. Obsidian Templater compatibility: a rewrite of three tags, no code execution

- Status: Accepted
- Date: 2026-11-07

## Context
Many users bring templates from Obsidian, where Templater tags (`<% … %>`) are common. Templater
evaluates JavaScript (`<%* … %>`, `tp.user`, `tp.web`, `tp.system`). Inkling templates are shared
between workspace members and imported from files; evaluating their code on the server or in
other members' browsers would be remote code execution by design.

## Decision
- Before substitution, a string pre-pass rewrites exactly:
  `<% tp.date.now() %>` / `<% tp.date.now("F") %>` / `<% tp.date.now("F", n) %>` (n days offset)
  → `{{date…}}`, `<% tp.file.title %>` → `{{title}}`, `<% tp.file.cursor() %>` (optional index)
  → `{{cursor}}`.
- Every other tag stays as literal text: `<%* … %>` blocks, other `tp.*` calls, user scripts.
  Nothing is parsed as an expression; the patterns are fixed regular expressions.
- The documented replacement for `tp.system.prompt` is `{{input:Question|default}}`.

## Trade-offs
Templates that depend on Templater scripts need manual conversion; the literal tags make that
visible instead of silently producing wrong text.
