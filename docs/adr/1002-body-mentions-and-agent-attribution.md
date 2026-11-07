# 1002. Body @mentions: read from Yjs, attributed to a person or an agent

- Status: Accepted
- Date: 2026-11-07

## Context
The editor writes person mention chips, but the server's BlockNote schema has no `mention` inline,
so conversion drops them and `doc_mention` was never produced. Agents write Markdown and cannot
create chips; an agent's "@Alice" should not ping Alice the way a colleague's mention does
(agent edits are frequent and a mention in generated text is rarely a request).

## Decision
- `notify/mentionScan.ts` walks the Yjs XML fragment and collects `XmlElement('mention')` with
  `kind != page` by node name (structure-agnostic), with block id, top-level index (→ section anchor)
  and the line text. A byte pre-check skips documents without the word "mention".
- The document indexer adds a mention signature and reconciles `page_mentions(page_id, user_ids)`:
  ids not there before are new mentions. Rows for pages that existed before migration 0031 start with
  `user_ids = NULL` (baseline unknown): the first pass records silently, so an upgrade does not
  replay every old mention.
- Attribution: the in-flight REST/MCP writer (`withEditActor`) if any, else the person who typed in
  the page most recently (Hocuspocus `onChange` notes `context.userId` per page, two-minute window).
- A mention made through an agent connection (`via` set) is delivered `quiet` and waits for the
  digest; it never pings a webhook. Plain-text `@Display Name` that an agent adds (matched exactly
  against member names, word boundaries, longest name first) is treated the same way. People's plain
  text is not a mention: people use chips.
- Visibility is checked per recipient; private pages never notify anyone but their author.

## Alternatives considered
- Add `mention` to the server schema: conflicts with the editor-schema work in flight and changes every
  Markdown round trip.
- A client-side "I mentioned X" call: spoofable and lost when the tab closes.
- An explicit `notify: [userId]` argument for agents: deferred; the inbox (ADR 1003) is how agents
  reach people's work queue, and quiet mentions still land in the digest.

## Trade-offs
- With several people typing, the latest typist is credited.
- Agent-written `@Name` text matches display names, which members can share; quiet delivery limits
  the harm of a wrong match.

## How others solve it
- Discord `allowed_mentions` (bots mention nobody unless told to), Slack app mentions.

## References
- apps/server/src/notify/mentionScan.ts, notify/producers.ts (`syncDocMentions`, `notifyPageEdited`),
  docIndexer.ts, context/attribution.ts, collab.ts (`onChange`)
