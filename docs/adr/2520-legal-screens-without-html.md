# 2520. Legal screens: Markdown without HTML, the consent screen around every route, the instance label

- Status: Accepted
- Date: 2026-11-12

## Context
The documents and the sign-up details are Markdown written by an operator. The consent screen must replace
whatever screen a signed-in person opened (the app, the OAuth approval, the clipper, invites), and the
instance label must be visible on every screen, on phones as well, so nobody mistakes the demo for another
server.

## Decision
- **Markdown** (`components/legal/markdownParse.ts`, `LegalMarkdown.tsx`): a small parser builds a tree
  (headings, paragraphs, lists, pipe tables, quotes, code; bold, italic, code, links, bare addresses) and
  React draws it. There is no `innerHTML` anywhere, so `<script>` or `<img onerror>` in a file is shown as
  text. Links keep only `http`, `https` and `mailto` targets. Tables scroll in their own box; Korean words are
  not split. The parser is pure and tested in node; the browser check confirms no element is made.
- **Consent screen**: `ConsentGate` wraps the routes in `App.tsx`. It watches the cached `/auth/me` (no
  request of its own) and, when it says `consentRequired`, shows `ConsentScreen` instead of any screen except
  the signed-out ones, `/terms`, `/privacy` and public links. A `CONSENT_REQUIRED` answer to any request made
  through `api()` (`api.ts` fires an event; uploads and a few direct `fetch` calls do not) reloads `/auth/me`, so a version change shows the screen without a reload.
- **Sign-up**: `SignupConsent` shows the notice and the boxes, none ticked and no "agree to all", and reports
  `ready` only when every required box is ticked; a version change while the form is open clears the ticks.
- **Instance label**: one component, three placements: the sidebar head, a thin strip above the page on
  phones (and on wide screens while the sidebar is collapsed, found with `:has` on the sidebar shell), and
  under the title of the sign-in, sign-up, consent and document screens. Theme tokens only: ink on
  accent-soft with an accent border.

## Consequences
- A document cannot carry images, colours or raw HTML; operators write plain Markdown.
- Deleting the account from the consent screen needs piece B's deletion component in the slot
  (`AccountDeletionSlot.tsx`), wired at merge.
