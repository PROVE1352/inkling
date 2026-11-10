# 2380. Onboarding state per person, for new accounts only; the checklist ticks itself from stored facts

- Status: Accepted
- Date: 2026-11-11

## Context
A new account lands on an empty workspace and "Select a page or make a new one". Someone who
started the trial with `deploy/local.sh` and the `/setup` link, or who was invited into a team
workspace, should see within half a minute what Inkling is and what to try first. People who already
use the app must not be stopped by any of it after an upgrade. The state must follow the person
across devices, and agents have no business with it.

## Decision
- **Table** `user_onboarding(user_id pk → users on delete cascade, state jsonb, created_at,
  updated_at)` (migration 0060, `db/schema-onboarding.ts`). The row is made by the first
  `GET /api/me/onboarding`. Migration 0060 inserts `{"legacy": true}` for every account that exists
  when it runs, so **"no row before the first read" is the whole test for a new account**: the intro
  plays by itself only then, and the checklist starts on. Legacy accounts get neither unless they ask
  (Settings › About: "Watch the intro again", "Getting started checklist" switch).
- **Routes** (`onboarding/routes.ts`), browser sessions only like `/me/sidebar` (ADR 1020): a bearer
  token gets 403, no cookie 401. `GET /api/me/onboarding` → `OnboardingDTO`; `PATCH` with any of
  `introSeen`, `collapsed`, `dismissed`, `event` (strict schema: unknown fields are 400);
  `POST /api/me/onboarding/sample` (ADR 2381). Rate limits 120/60/10 per minute. Nothing takes a user
  id: a person only ever reads and writes their own row.
- **Audience**, computed per read (`audienceOf`): `owner` (owns every workspace they are in, or is a
  server admin), `member` (a member, any role but owner, of someone's workspace), `guest` (page_grants
  rows in a workspace they are not a member of, and no team workspace, ADR 1250). Guests get
  `intro: false` and no checklist. Items: owner `page, slash, link, database, share, ai, install`;
  member `explore, page, slash, link, comment, ai, install`. `install` is optional (shown where the
  browser can keep offline copies; not needed to finish).
- **Facts from the server** for items not done yet, one statement (`serverFacts`): pages the person
  made (`pages.created_by`, index `pages_created_by_idx`), collections, `page_links` from their pages,
  comments, `oauth_grants`/`api_tokens` (agent connections and tokens), sharing (`share.published` or
  `member.added` audit events by them, `page_grants`/`page_invites` they made, another member in a
  workspace they own). Only while the card can show (not dismissed, items pending).
- **Browser-only events** through `PATCH { event }`: `slash` (the slash menu's item loader ran),
  `link` (inserted from the `[[` menu), `ai` (MCP address copied), `explore` (a page opened in a
  workspace they do not own), `install` (installed app or offline copies on). The client sends each at
  most once per page load and only while the open checklist still waits for it.
- **Sticky**: an item stays done once seen (`state.done[id] = time`); a trashed page does not untick.
  All items done → the card goes away; turning it back on in Settings shows it even when complete.
- **The sample pages never count**: their page ids are recorded (ADR 2381) and left out of every fact.
- **`ONBOARDING=off`** (`.env.example`, `compose.yaml`; read per call): GET/PATCH answer
  `enabled: false` and change nothing visible, POST is 404, no sample is made. A row first made while
  off is `{"off": true}` and counts as an existing account if the operator turns it on later.

## Alternatives considered
- **Compare `users.created_at` with a constant "feature date".** Depends on the server clock and on
  when each instance upgrades; an instance upgraded months later would still treat accounts made in
  between as new. The migration marks exactly the accounts that existed at upgrade time.
- **A column on `users` or a key in `sidebar_prefs`.** `users` is a shared, busy table definition and
  `sidebar_prefs` has a strict schema whose PUT replaces the whole value; a table of its own is one
  line in `schema.ts` and cascades with the account.
- **Mark new accounts in the sign-up handlers.** Three insert sites (register, delegated mirror,
  OpenID Connect) and the test harness would each need the marker; the backfill needs none of them.
- **Count client events for everything.** The server already knows pages, databases, shares and
  connections, across devices and agents; events are kept to what it cannot see.

## Trade-offs
- The first GET writes (the row, the first admin's sample). It is idempotent: `INSERT … ON CONFLICT
  DO NOTHING`, the sample claim is an atomic `UPDATE … WHERE state->'autoSample' IS NULL`.
- Facts cost one statement of EXISTS subqueries per read while the card is open; the query is
  refetched on window focus and after 30 s.

## Consequences
- New accounts see the intro once and the checklist until done or dismissed, on every device.
- Upgraded accounts see nothing new unless they turn it on.
- Tests: `onboarding/onboarding.db.test.ts`, `onboarding/onboardingFirstAdmin.db.test.ts`.
