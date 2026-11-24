# 2388. Example suggestions on the sample page: written directly, marked by `connection = 'example'`, quiet

- Status: Accepted
- Date: 2026-11-24

## Context
Reviewing an agent's suggested edit (ADR 1530–1534, 1621–1622) is the step people most need to see
once, and the one they cannot try before an agent is connected. The intro draws it (ADR 2382), but the
sample page (ADR 2381) had nothing to review. A suggestion made on the sample must look exactly like a
real one in the existing review dialog, must not look as if an AI wrote it, and must not send the
person (or an agent they connect later) anything.

`createSuggestions` queues an `approval_request` to the page owner in its transaction, even when the
owner is the author (ADR 1534), and deciding queues an `approval_result` to the author without a
connection, so it shows in every inbox of that person, including an agent connected later. Webhooks
carry no suggestion events (`P/embeds.ts`), and the AI digest counts only `page_changes` rows with an
agent `via_client`; neither is touched by a suggestion row or by a person accepting it.

## Decision
- **Two suggestions, seeded when a sample is made** (`onboarding/exampleSuggestions.ts`): a `replace` of
  "4. Diagrams" that adds one paragraph before the section's last block (the Mermaid code block) and one
  after it, so the review shows two changes and one can be taken alone (`accepted_partial`); and an
  `append` of a tip callout to "5. AI agents", accepted or rejected whole. The `replace` text is built
  from the section as it is when seeded (not a fixed string), so it keeps its two changes when the
  sample text changes. "4. Diagrams" rather than "1. Blocks" because the sample asks people to type in
  "1." and a person's edits to a section within 10 minutes merge into one change-log row (`context/changeLog.ts`), which a revert would undo together.
- **Named and worded as examples**: `via` is "Example agent" / "예시 에이전트", so the review shows
  "<name> via Example agent"; the tip says it is an example that came with the sample and that no AI
  wrote it. The sample's top tip points at the two ✎ marks. No change to `SuggestionDTO` or the web.
- **Written directly** (`seedExampleSuggestions` in `suggestions.ts`): resolved by the same `prepare`
  as any suggestion (section, base version, heading block id, the stored base for per-hunk acceptance),
  inserted in one transaction with `origin = 'asked'` and `connection = 'example'`. No approval request,
  no quota check (two rows of a few hundred bytes), no lock or write gate (a private page the person made
  a moment ago). `auto_at`, `rule` and `review_reason` stay NULL, so the auto-accept sweep never takes them.
- **`connection = 'example'` is the marker.** Real rows carry `grant:<id>`, `token:<id>` or `''`
  (`connectionKey`), so it never collides. `resultEvent` gives such a row no recipient, so accepting
  (whole or in part) and rejecting notify nobody. `mySuggestions` (`GET /suggestions`, MCP
  `list_suggestions()` without a page) and the Team agents board leave them out; a page's own list
  (`GET /pages/:id/suggestions`, `list_suggestions(pageId)`) shows them, since that is where they are reviewed.
- **When**: after the sample's record is saved (`makeSample`), for the button and the first admin's
  automatic sample alike. A failure is logged and the sample stands without them. An existing sample is
  never seeded; a new sample made after deleting the old one gets its own two.
- Accepting one writes as the person (`via_client` NULL), like any accept: the change log and section
  marks show the person, not the example agent.

## Alternatives considered
- **`createSuggestions(…, { quiet: true })`.** A browser session gets `connectionKey = ''`, so the row
  would carry no marker and the result notification would need yet another argument to be dropped.
- **A system "Example agent" user as author.** A user row on every server, a member of every
  workspace with a sample, and the review would no longer show the person's own name as with a real
  agent's suggestion.
- **A `SuggestionDTO.example` flag shown in the web.** Touches the shared type, the panel and the MCP
  output; the agent name and the text already say it is an example.
- **Seeding before the record is saved.** A failure would make the first admin's automatic attempt
  record `failed` while the page exists and is not counted as the sample.

## Trade-offs
- An agent connected later with the same account can see and withdraw the example rows through
  `list_suggestions(pageId)` / `withdraw_suggestion(id)`; they are the person's own rows.
- Nothing closes open suggestions after a while; the two rows wait until decided or until the sample is
  deleted, like any suggestion.
- The `replace` paragraphs are placed around the section's last block; if a future sample leaves the
  section with no body block, both land together as one change.

## Consequences
- `onboarding/exampleSuggestions.db.test.ts`: two open rows per new sample in the person's language with
  `connection = 'example'` and a heading block id; no outbox `notify` row and no notification when made,
  partly accepted, rejected or accepted whole; two separate changes, one applied alone; not in
  `GET /suggestions` or Team agents, in the page's list; an existing sample is not seeded again; a seed
  failure leaves the sample recorded; the automatic sample is seeded too.
