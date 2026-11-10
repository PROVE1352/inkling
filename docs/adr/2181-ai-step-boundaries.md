# 2181. Where one AI step ends: batches, people in between, suggestions, conflicts and restores

- Status: Accepted
- Date: 2026-11-10

## Context
ADR 2180 makes every agent write one version ("AI step"). "One write" needs a rule for the cases
where the write is not a plain section patch: several sections in one call, a write that becomes a
suggestion, a write that is refused, a person editing between two agent writes, a suggestion a person
accepts later, and restoring a version. The rule also decides what `restore_version` names as its undo
point, and whether the people's 10-minute autosaves still happen while an agent is busy.

## Decision
- **One call = one step.** `patch_sections` (all-or-nothing, ADR 1542) stores one step whose `step`
  names every written anchor (three shown, `more` counts the rest) and sums the lines of all edits.
  `update_page` replace and append are one step each (no anchors = the whole body; a replace of a
  page too large for the echo, > 2,000 blocks, reports no line counts).
- **People in between.** Before an agent write the page's digest is compared with the newest version.
  Equal: the agent's previous step is the page now, nothing is stored. Different: someone (a person,
  another client, an autosave-less import) changed the page since, so a "Before AI edit" row of the
  page as it is now is stored first. People's edits therefore always survive as their own version,
  and a run of steps never mixes two clients: step numbers (`n`) count consecutive step rows of one
  client with no other row in between.
- **No change, no step.** A write whose result has the digest of the newest row stores nothing
  (rewriting a section with the same text). A conflict (`SECTION_CONFLICT`), a missing section or a
  refused write stores no step; the "before" row may have been stored already when someone edited
  since the last version — it holds a real state of the page (theirs), so it is kept.
- **Suggestions.** `suggest=true`, a lock that asks for suggestions, and suggest-only after flagged
  content (ADR 2040) turn the write into a suggestion before any version work: nothing is stored.
  Accepting a suggestion is a person's edit made with the agent's text (ADR 1533): it keeps the
  "Before AI edit" undo point it had (one per page per 2 minutes, ADR 0930) and stores no step row,
  because the edit is the person's (no agent `via`). The agent's next write then sees a different
  digest and stores the accepted page as a "Before AI edit" row before its own step.
- **Restore.** An agent's `restore_version` is a step on top of the history: the page before it is the
  agent's previous step when nothing changed since (no "Before restore" copy of it), else a
  "Before restore" row; the restored page is stored as a step with `restoredFrom`. Steps after the
  restored version stay in the history and can be restored in turn. The route answers
  `{ before, step }` and the tool names the `before` version as the undo point. A person's restore in
  the web app is unchanged ("Before restore" row, no step).
- **Same permissions as before.** The restore route still checks membership, the edit lock
  (`assertPageEditable`, so a page locked for agents or set to "agents: suggestions only" refuses
  with `PAGE_LOCKED`), the write gate (ADR 1513) and, because it is not in `OPEN_WHILE_SUGGEST_ONLY`,
  refuses a suggest-only connection (ADR 2040, 0.16). Refused restores store nothing.
- **Autosaves.** The 10-minute autosave throttle looks only at rows without `step`, so a busy agent
  does not stop the people's autosaves. An autosave whose stored state has the newest row's digest
  (the store right after an agent step) is skipped and noted, so the step is not copied.

## Alternatives considered
- **A step per section in `patch_sections`**: the batch is all-or-nothing; restoring "half a batch"
  would bring back a state that never existed.
- **Accepted suggestions as the agent's steps (via the suggestion's client)**: the history would say
  the agent edited when a person decided; ADR 1623 already treats people's actions on agent text as
  the person's.
- **Store the "before" row only once the write succeeded**: needs a copy of the page held in memory
  across the write (a whole encode of a live document) on every write, to save a row that is a real
  state of the page anyway.
- **Keep "Before restore" for agent restores even when it equals the previous step**: the same
  document twice, one more row against the caps; the tool names the step instead.

## Consequences
- The user's case (four patches of one section) lists "Before AI edit" and AI steps 1–4; restoring
  step 2 gives the page after the second patch, steps 3 and 4 stay, the restore is step 5.
- A person typing while an agent writes adds "Before AI edit" rows (one per agent write that finds
  the page changed); they count against the 50-row cap like autosaves.

## References
- apps/server/src/context/sectionWrite.ts (`asAgentStep`, `sectionEditDelta`), apps/server/src/routes/sectionBatch.ts,
  apps/server/src/pageContentWrite.ts, apps/server/src/routes/snapshots.ts, apps/server/src/snapshotStore.ts
- apps/server/src/mcpTools/aiSteps.db.test.ts, apps/server/src/mcpTools/agentTools012.db.test.ts
- ADR 0930, 1513, 1533, 1542, 1623, 2040, 2180, 2182
