# 2390. The sample page for every sign-up; "agent connected" on its first request; Activity in the default sidebar once connected

- Status: Accepted
- Date: 2026-11-25
- Amends: ADR 2381 ("members by button": every new account now gets the sample by itself), ADR 2380 (the `ai`
  item's fact and its browser event), ADR 1641 (the default menus for a person with a connected agent)

## Context
A check of the first five minutes (0.23) found that new people leave without seeing what the AI agent side does.
Only the first admin of a server got the sample page, with its two example suggestions (ADR 2388), by itself;
everyone else had to find the button. The checklist's "Connect an AI agent" ticked when the MCP address was
copied, or when an OAuth grant or a personal API token merely existed, so it said "done" before anything had
connected and nothing marked the moment an agent really did. And the way from a working connection to what the
agents do (the Team agents board, reached from the Activity screen) was hidden: Activity is not a default menu.

## Decision
- **Sample for every sign-up.** `maybeAutoSample` (`onboarding/state.ts`) makes the sample in the workspace an
  account got with its sign-up: one it owns and made itself in the account's own transaction (`POST
  /auth/register` and the first OpenID Connect sign-in insert the user and the workspace together, so the two
  `created_at` values are that transaction's `now()`; a two-second window allows for a split into two statements).
  The first admin rule stays for an admin without such a workspace. Same moment as before: the account's first
  `GET /api/me/onboarding`, claimed once (`autoSample`), so the sign-up request is unchanged. A team workspace the
  person joined never gets it; the button still makes one there. Unchanged: `ONBOARDING=off` and `{off}` rows,
  legacy rows (also with `ONBOARDING_EXISTING_USERS=once`), rows whose first read was before 0.24 (`autoSample`
  already set) get none. A workspace limit refuses it quietly (`autoSample: 'failed'`, nothing logged), any other
  failure is logged and recorded the same way; the read answers as usual. When the button got there first
  (`SAMPLE_IN_PROGRESS`), the automatic attempt counts as made: one sample.
- **Agent connected = its first authenticated `/mcp` request.** The `/mcp` handler, after the bearer check and the
  method and profile checks, calls `noteAgentConnected(user.id)` (`onboarding/agent.ts`): one conditional
  `UPDATE … WHERE state->'agentAt' IS NULL` that sets `agentAt` and ticks `done.ai`, then the person is
  remembered in memory and later requests run nothing. After a restart the first request runs the update (no row
  matches, nothing is written) and a row check. A person without a row (never opened the app) gets one made the way
  the first read makes it, so the row still means a new account. Off while `ONBOARDING=off`. Errors are logged and
  never fail the request.
- **Connections made before 0.24**: on a read, an OAuth grant or agent connection token of the person's with
  `last_used_at` set (only the bearer check writes it, and only `/mcp` and its internal calls reach that) records
  `agentAt` too. Such a person is connected on the first answer they see, so the app never sees it change.
- **`OnboardingDTO.agentConnected`**, top level (closed cards, legacy accounts and guests have no items to read it
  from); `false` while onboarding is off. `serverFacts` no longer reads `ai`; `ai` is no longer a browser event
  (`PATCH { event: 'ai' }` is 400), and the web app no longer sends it on copy.
- **The notice.** The web app tells the person once, when an answer of this page load said `false` and a later one
  says `true` (`agentJustConnected`, `onboarding/agentNotice.ts`): a toast in the app shell with the first question
  to ask and a button to the Team agents board. The app shell learns it from the existing refetch on focus. The
  connections screen is outside the shell (no toasts): while it is open and nothing has connected, it asks again
  every 5 s, and shows the same line under its steps with a link to the board; whichever shows it first, the other
  does not repeat it.
- **Activity in the default sidebar once connected.** There is no Team agents menu; the Activity screen links to
  the board. With `agentConnected` and nothing stored for the sidebar, `activity` is no longer in the default hidden
  list (`sidebarDefaultHidden`, `onboarding/sidebarDefault.ts`). The sidebar, its right-click "hide" and Settings ›
  Sidebar read the same default, so hiding another menu does not take Activity with it. A stored arrangement keeps
  its meaning; with no agent nothing changes.

## Alternatives considered
- **Make the sample in the sign-up request** (a sign-up hook). The hook runs inside the account's transaction,
  where `instantiateTree` cannot take its own tree lock and transaction, and a failure would undo the sign-up.
  After the commit it would still add the sample's time (60–110 ms locally) to the sign-up answer, and the OpenID
  Connect path has no hooks. The first read already does this for the first admin.
- **Mark new accounts at sign-up** instead of matching the workspace's `created_at`. Two insert sites to touch in
  files other work is changing; the transaction's `now()` already says which workspace came with the account.
- **Derive "connected" on every read from `last_used_at` only, with no `/mcp` call.** It needs no write in the
  request path, but the fact would appear only when the person next opens the app and would go away with a revoked
  grant; the record is sticky and made where the connection happens. The derivation stays for connections made
  before 0.24.
- **A new "Team agents" sidebar menu.** A new menu id shows for everyone who arranged the sidebar before (a stored
  arrangement shows every menu it does not hide) and changes the menu count the sidebar's height rules were measured
  with (ADR 1643, 2384). Activity is an existing menu and its screen leads to the board.
- **A banner or a new box for the notice.** The first-minutes check advises against bars and boxes; the toast and
  one line on the connections screen are the existing forms.

## Trade-offs
- The first onboarding read of a new account takes the sample's time (8 → 60–110 ms locally); the sign-up answer is
  unchanged (median of 20 local sign-ups 26 ms before and after).
- The toast draws one line and cuts the sentence; the question is whole on the connections screen
  (KNOWN-ISSUES).
- A connection made before 0.24 whose grant was never used is not "connected" until its next request, which then
  shows the notice if the app is open.

## Consequences
- Tests: `onboarding/onboardingSignup.db.test.ts` (sign-ups get the sample and two example suggestions, not in a
  joined team workspace, not with `ONBOARDING=off`, not for legacy or already-read rows, a page limit leaves the
  sign-up working, the read and the button at once make one), `onboarding/agentConnected.db.test.ts` (token and
  OAuth, a token alone or a copy does not count, later requests and a restart write nothing, connected before 0.24,
  no row yet, off), adjusted `onboarding.db.test.ts` and `onboardingFirstAdmin.db.test.ts`;
  `apps/web/src/onboarding/agentConnected.test.ts` (the notice rule, the sidebar default with and without an agent
  and with a stored arrangement).
