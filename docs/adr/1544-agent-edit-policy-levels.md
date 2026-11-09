# 1544. Agent edit policy: direct, accept by rules, review everything

- Status: Accepted
- Date: 2026-11-09

## Context
Suggestions (ADR 1530) and the "agents: suggestions only" lock (ADR 1532) let a team review agent
edits page by page. Teams asked for a workspace-wide choice — let agents write, let rules accept the
harmless edits, or review everything — with locked pages and folders able to choose differently.

## Decision
- Three levels. **direct** (default, today's behaviour): agents write. **auto**: agent body edits
  become suggestions and the auto-accept rules (ADR 1545) accept those that pass, the rest wait for a
  person. **review**: every agent body edit waits for a person (= the suggestions-only lock).
- **Workspace default**: one `agent_edit_policies` row with `page_id NULL` (level + rules), set in
  Workspace settings › Connected agents by owners and admins (browser only, audited as
  `agent_policy.changed`). It applies to body writes only — `patch_section`, `patch_sections`,
  `update_page` — through `suggestionMode` after the edit check passes; it does not refuse renames,
  moves or trash the way a lock does.
- **Lock nodes override it** with the agents preset, which now reads `same | direct | auto | suggest |
  comment | read`:
  - `same` — no agents rule on this node: inherit (the nearest node with a rule, else the workspace
    default). Relabelled "Workspace default" in the lock dialog; the stored rows are unchanged.
  - `direct` — a marker-only row (`allow DIRECT=16`, deny 0): agents write directly here even if the
    workspace default is auto/review. It grants no bit: a lock never loosens, so `direct` below a
    suggestions-only node still suggests.
  - `auto` — `allow SUGGEST|AUTO(8), deny EDIT`: like `suggest` for the caps (ADR 1532), plus a
    marker; the node's rules are an `agent_edit_policies` row keyed by its page id, changed by whoever
    may manage the node's lock (audited).
  - `suggest` — review; `comment`/`read` as before.
- **Resolution**: walk the lock chain from the page up; the first node with an agents row decides
  (`chainAgentPolicy`): direct / auto (that node's rules) / review; a comment/read row leaves it to the
  caps (the write is refused anyway). No node → the workspace default. Marker bits never leave
  `effectiveCaps`.
- Policies are read fresh for each agent write (one indexed lookup), so changing rules needs no
  access-version bump; switching a node's preset is a lock change and bumps as before (ADR 1071).
- The `can:` line says how body edits land: `edit` (direct), `suggest` (review), `suggest,auto`
  (rules may accept). Deterministic, no dates.
- Asking for a suggestion (`suggest=true`) is never auto-accepted.

## Alternatives considered
- **A separate policy tree** next to the lock tree: a second inheritance walk with its own cache and
  its own UI, for a decision that already belongs to "what may agents do here".
- **`same` keeps meaning "direct"**: every existing people-only lock (default agents = same) would then
  silently override a workspace that chose review. Inheriting is the safer reading.
- **A `direct` row that allows EDIT**: would let an agent exceed what a nearer agents rule allows;
  markers keep the evaluation order of ADR 0971 intact.

## Consequences
- An older server reads `auto` as suggestions-only (deny EDIT, allow SUGGEST) and `direct` as no rule:
  a downgrade never loosens.

## References
- apps/server/src/autoAccept.ts, apps/server/src/editLock.ts (`chainAgentPolicy`, `CAP_AUTO`,
  `CAP_DIRECT`), apps/server/src/routes/agentPolicy.ts, apps/server/src/suggestions.ts (`suggestionMode`),
  apps/web/src/pages/WorkspaceSettings.tsx, apps/web/src/components/PageLockModal.tsx
