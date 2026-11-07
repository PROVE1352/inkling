# 0936. "via agent" provenance for MCP writes

- Status: Accepted
- Date: 2026-11-07

## Context
MCP tools act as the token's user through the REST routes, so an edit, comment or snapshot an
agent made was indistinguishable from one the user typed. People reviewing history ("who
rewrote this section?") and comment threads need to tell the two apart, and the change feed
(docs/adr/0930-* family) needs the same attribution. Migration 0028 added `via_client` (text)
to `page_snapshots`, `comments` and `page_changes`; `AuthUser.via` and
`context/attribution.ts` (`actorOf`, `withEditActor`, `currentEditActor`) exist for the
change logger.

## Decision
- **Source of the label**: `getBearerUser` joins `oauth_clients` and sets `AuthUser.via` to the
  client's registered name, sanitized by `sanitizeClientName` (apps/server/src/oauth.ts:82):
  C0/C1 controls, bidi overrides/isolates and zero-width characters are removed, whitespace is
  collapsed, the result is capped at 60 code points (never splitting a surrogate pair, "…"
  marks truncation); an empty result falls back to "MCP client". Cookie sessions leave `via`
  undefined. The name is stored as plain text and rendered by React as text (escaped); no
  `dangerouslySetInnerHTML` anywhere on this path.
- **Where it is stored**:
  - Snapshots: `createSnapshot(pageId, state, label, createdBy, via = null)`
    (apps/server/src/snapshotStore.ts:37) — backward compatible. `update_page` replace passes it
    on the existing "Before AI edit" snapshot (apps/server/src/routes/pageContent.ts:65).
  - Agent append marker: an MCP append previously left no trace in history. After an agent
    append the route stores a labelled snapshot "AI edit" ("AI 편집") of the resulting state
    with `via` (pageContent.ts:74), skipped when the page already has an agent snapshot within
    the auto-snapshot throttle window (10 min, `hasRecentAgentSnapshot`, snapshotStore.ts:51).
    Replace keeps its single "Before AI edit" snapshot (undo point), unchanged. Only requests
    with `via` (bearer) take the marker, so plugin/browser appends are unaffected.
  - Comments: `POST /pages/:id/comments` stores `via_client = user.via ?? null`
    (apps/server/src/routes/comments.ts:148).
  - Change feed: the content route wraps `writeBlocksToDoc` in
    `withEditActor([id], actorOf(user), …)` (pageContent.ts:70) so the change logger, which
    indexes server edits synchronously from the store hook, records `actor_id` and
    `via_client`. The page-metadata routes (rename/move/trash/restore) are wrapped by the
    change-feed owner; `routes/context.ts` (patch_section) already wraps its write.
- **Where it is shown** (all additive DTO fields):
  - `SnapshotDTO.author?: {id, name} | null` and `viaClient?: string | null`
    (packages/shared/src/index.ts:414); the history list shows "Alice (via Claude)" under the
    label (apps/web/src/components/HistoryModal.tsx:37, :164). Labels "AI edit"/"AI 편집" are
    translated like the other system labels.
  - `CommentDTO.viaClient?: string | null` (packages/shared/src/index.ts:610); the comment
    header shows "(via Claude)" after the author (apps/web/src/components/comments/CommentsPanel.tsx:127).
  - Change feed: `page_changes.via_client`, filled from `currentEditActor`.
- **Live awareness / cursor marker: not implemented.** Server writes go through a Hocuspocus
  `DirectConnection`, which has no awareness client; showing an "AI is editing" cursor would
  need a synthetic awareness state on the server document, broadcast and cleared around each
  write, for a write that lands as one Yjs transaction in milliseconds. The marker would flash
  and vanish, while history, comments and the change feed already carry durable attribution.

## Alternatives considered
- Store the OAuth client id instead of the name: stable and unspoofable, but needs a join on
  every read and loses the label when the client registration is deleted (cascade). The name is
  what people need to read; it is captured at write time like an author name.
- A separate "agent" pseudo-user as author: breaks permission checks (edits must remain the
  user's own) and comment ownership (the user must be able to edit/delete them).
- "Before AI edit" snapshot also for appends: an undo point for a non-destructive operation,
  but the marker's job is to show *that* an agent changed the page; the post-edit "AI edit"
  snapshot does that and the previous snapshot is still the undo point.
- Unthrottled marker per agent write: an agent appending in a loop would push human history out
  of the 50-snapshot cap.

## Trade-offs
- Client names are self-asserted at dynamic registration; a client can call itself anything,
  including another product's name. Sanitizing stops layout and bidi spoofing, not
  impersonation. The user approved that client on the consent screen, which shows the same name.
- The throttle means a burst of agent appends shows as one "AI edit" entry; the change feed
  still lists every change.
- Replace by an agent still creates one "Before AI edit" snapshot per call (existing policy);
  many replaces in a row can still churn the cap.
- Pages created by `create_page` / `import_folder` / `create_from_template` are attributed to
  the user only (no `via` on new pages); the change feed sees them as created by the user.

## How others solve it
- GitHub shows "<user> with <app>" for actions taken through an app token and keeps
  `performed_via_github_app` on issues and comments.
- Google Docs version history names the user; Apps Script edits appear as the user. Notion
  shows integration-made edits under the integration's name.
- Linear and Slack show "via <app>" next to the human actor, the model chosen here.

## Consequences
- Every MCP write through the content and comment routes is labelled; old rows have null
  `via_client` and render as before.
- New REST write paths used by MCP tools should wrap document writes in `withEditActor` and pass
  `user.via` where they store authored rows.

## References
- apps/server/src/oauth.ts:82 (sanitizeClientName), :214 (getBearerUser sets via)
- apps/server/src/snapshotStore.ts:37 (createSnapshot via), :51 (hasRecentAgentSnapshot)
- apps/server/src/routes/pageContent.ts:65, :70, :74
- apps/server/src/routes/snapshots.ts:76, :90
- apps/server/src/routes/comments.ts:54, :148, :172
- apps/server/src/context/attribution.ts:19, :23
- packages/shared/src/index.ts:414, :610
- apps/web/src/components/HistoryModal.tsx:37, apps/web/src/components/comments/CommentsPanel.tsx:127
- apps/server/src/oauthScopes.test.ts
