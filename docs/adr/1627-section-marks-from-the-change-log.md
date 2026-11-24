# 1627. Section marks come from the change log: the newest row per section, people and agents alike

- Status: Accepted
- Date: 2026-11-24

## Context
The page history (right panel) and the activity screen list changes, but reading a page you cannot
tell which section an agent touched last without going through them. The change log (`page_changes`,
ADR 1620) already keeps, per section anchor, who changed it (`actor_id`, `via_client`), when, and the
texts a revert needs; `page_changes_page_idx (page_id, anchor, seq)` serves "newest row per anchor".

## Decision
- `GET /pages/:id/section-provenance` returns, for each section of the current outline, the newest
  change row the user may see: one `SELECT DISTINCT ON (anchor) … ORDER BY anchor, seq DESC`, with the
  visibility rules of `GET /pages/:id/changes` (shared rows or the user's own private rows, the token
  range). Members only (guests 403, like `/changes`); not a document page → an empty list.
- Filters run after the newest row is picked: a section whose newest change is a removal or has no
  known actor (live typing by several people, KI CF-2) gets no mark, rather than an older change
  that is no longer the last one. Anchors that are not in the current outline are dropped; the
  outline gives the heading block id the web places the mark by (the REST outline does not carry it).
- Revert facts are `revertInfo` (ADR 1623), the same as the history list, and "Revert this change"
  opens the existing revert dialog on that seq (ADR 1620). No new revert logic.
- Every section with a known actor is marked (contract decision 2): an agent sign and the client
  name for agent connections (`isAgentVia`), the person's initials otherwise (public forms and
  automations count as people, ADR 1870). Text marks on the heading line, next to "✎ N suggested"
  and the claim; nothing is drawn along the section.
- An accepted suggestion is the accepting person's change (`via` null), also for the sample page's
  example suggestions (ADR 2388): acceptance writes as the person, and stamping the agent's via on it
  would make it count as an AI edit (Before AI edit versions, the AI digest, "Last AI edit").

## Alternatives considered
- Matching accepted suggestions to change rows by time, to label "accepted from Example agent": the
  merge window moves `changed_at` on every merged edit, so the match breaks in ordinary use.
- A `suggestion_id` column on `page_changes` carried through `EditActor`: exact, but a migration and
  changes to the change log, the section writer and suggestions at once; left for a later release.
- Agent marks only, or people only on pages with agent changes: the sample page has no agent rows,
  so accepting an example suggestion would show nothing.
- Per block or per paragraph colouring: the log keeps sections, not blocks.

## Consequences
- What "last change" means is what the log keeps: rows live 30 days, so older sections have no mark
  (no mark does not mean a person wrote it); one actor's edits of a section within 10 minutes are one
  row, so "Revert this change" can take several edits back (the dialog's preview shows them).
- The marks lag the editor by the change log's delay (about a second after a server write, 8–30 s
  after live typing) plus the web's polling: up to 30 s for an agent's edit on an open page, about a
  minute after typing. The web polls every 30 s, refreshes on focus, 1.5 s after a suggestion is
  decided and when a mark is opened; a revert refreshes them through the `['pageChanges']` key.

## References
- apps/server/src/sectionProvenance.ts, apps/server/src/routes/revert.ts,
  apps/web/src/components/SectionMarkers.tsx, apps/web/src/components/SectionProvenance.tsx,
  apps/web/src/lib/sectionProvenance.ts
