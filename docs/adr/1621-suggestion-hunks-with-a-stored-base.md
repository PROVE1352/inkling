# 1621. Suggestions are reviewed in hunks, merged 3-way against a stored base

- Status: Accepted
- Date: 2026-11-10
- Amends: 1533

## Context
ADR 1533 applies an accepted suggestion to the section as it is now; when the section changed since
the agent read it, "accept anyway" overwrote what people wrote meanwhile. A 3-way merge needs the
section as the agent read it, which was not stored ("base_version" is a 12-hex hash).

## Decision
- When an agent suggests a `replace` and its baseVersion is the section's version at that moment,
  the section's agent-notation Markdown (the same text `read_page` gave the agent) is stored as the
  base. No schema change this wave: `plugin_storage` under the reserved id `inkling:suggestion_base`,
  keyed by author and suggestion id (as ADR 1522 did for catch-up markers), capped at 512 KB; the
  entry is dropped when the suggestion is accepted whole, rejected, withdrawn, superseded or
  accepted by a rule, and by housekeeping when its suggestion is gone.
- Units are top-level blocks keyed by their agent Markdown (ADR 1500 notation), so a hunk never cuts
  a code fence, table or token. base = stored text (or the section now, while unchanged), ours = the
  live section, theirs = base with the suggestion applied. k blocks replaced by k blocks are k hunks.
- The preview of an open `replace` suggestion carries `merge: {baseKnown, key, hunks[]}`; a hunk
  that overlaps an edit people made since is a conflict (with the text there now) and starts
  unchecked. Without a stored base and with the section changed, every hunk is marked.
- `POST /suggestions/:id/accept {hunks, mergeKey}` recomputes the merge on the server (the client's
  choice is ids only), refuses a stale `mergeKey` with 409 SUGGESTION_CHANGED and the fresh hunks,
  and writes the merged section as blocks (live blocks kept) through `patchSectionAs` with the
  section's version as base version — typing that lands in between answers 409 instead of being
  undone. A chosen conflicting hunk replaces what is there now (the person decided).
- Accept without `hunks` keeps ADR 1533's behaviour for API clients.

## Alternatives considered
- **Line hunks on the Markdown**: needs boundary repair for fences, tables and tokens; block units
  have none to repair.
- **Base from the change log**: light text, capped, merged per actor within 10 minutes; the exact
  state the agent read is often gone.

## Consequences
- "Accept every hunk" of a changed section is now a merge that keeps people's edits.
- A suggestion made before this version has no stored base: its hunks are all marked once the
  section changed.

## References
- apps/server/src/suggestionMerge.ts, apps/server/src/suggestions.ts (acceptHunks),
  apps/web/src/components/SuggestionsPanel.tsx
