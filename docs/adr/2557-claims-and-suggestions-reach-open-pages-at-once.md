# 2557. Claims and suggestions reach an open page at once (a contentless notice on the collab document)

- Status: Accepted
- Date: 2026-11-25

## Context
A section claim (docs/adr/1535-*, 1536-*) and a suggested edit (1530-* .. 1534-*) reached a person who
already had the page open only through the web app's 15 s poll of `GET /pages/:id/suggestions` and the
refetch on window focus. The editor audit of 2026-11-25 (A2) measured 13.6 s from `claim_section` to the
badge next to the heading. Comments already refresh at once: the server sends a stateless `{t:'comments'}`
on the page's collab document and the editor invalidates its query.

## Decision
- Every function that changes a page's `section_leases` or `section_suggestions` rows sends
  `{"t":"suggestions"}` on that page's collab document (`suggestionNotice.ts` → `broadcastToPage`), after
  the change has committed: `claimSection`, `releaseSection` (only when a claim was released),
  `sweepExpiredLeases` (each page it cleared), `createSuggestions`, `seedExampleSuggestions`,
  `acceptSuggestion` and the hunk acceptance (also when a failed apply puts the row back to open),
  `rejectSuggestion`, `withdrawSuggestion`, and the auto-accept paths (`applyByRule`, the grace-period
  hold). MCP tools and REST routes all reach these functions, so the notice is sent from them, not
  from the callers. A failed send is logged and never fails the write.
- The payload is that object and nothing else: no suggestion text, section, connection or user name.
  The page is the document it travels on. The client answers by calling the same REST read it polls,
  whose access check decides what it gets; only connections that passed the document's
  `onAuthenticate` (collab.ts) receive the notice at all.
- The web app hears it without the editor's own handler: `openCollab` (collabSocket.ts) hands every
  stateless payload to a small registry keyed by document name (`lib/pageNotices.ts`), and
  `usePageSuggestions` watches its page there. Notices are coalesced per page (one read 200 ms after
  the last one), however many components show the page's suggestions.
- The 15 s poll and the focus refetch stay, for a closed socket.

## Consequences
- A claim, release or suggestion shows on an open page within about a second instead of up to 15 s.
- A claim that simply runs out is not a write: the badge goes at the next poll, or at the sweep's
  notice a minute later. Rows removed by cascades (page, workspace or user deleted) send nothing.
- Single instance only, like the comments notice: clients on another server process keep the poll.
- `openCollab` now always gives the provider a stateless handler. Before, an opener without one (the
  canvas, page embeds) passed `onStateless: undefined`, which replaced the provider's default and made
  every stateless message (the generation sent on connect, docs/adr/2201-*) throw in the provider's
  emit ("Cannot read properties of undefined (reading 'apply')").
- Older web builds ignore the unknown `t` (CollabEditor reacts only to the kinds it knows).
