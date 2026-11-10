# 1822. Public answers: made as the publisher, via "public form", with abuse limits

- Status: Accepted
- Date: 2026-11-10

## Context
A row needs an author and goes through `createRow` (placement, edit lock, row cap, webhooks, task
assignments, change feed, catch_up). A visitor has no account. The route is open to the internet.

## Decision
- A public answer is `createRow` as the member who turned the link on (`published_by`), with
  `via = "public form"`: the feed and catch_up say "Alice via public form", the row's `created_via`
  is set. Their current role and edit rights decide: when they cannot add rows to the collection any
  more, the form is closed (the same 404). No row template is applied (the row is what was typed).
- Only the asked properties are written: other keys, person and relation values, formulas and
  properties the form does not ask for are ignored. Answers are converted and checked by
  `formSubmissionProps`; problems answer 400 `FORM_INVALID` with `fields: { id: 'required' | 'invalid' }`.
- Limits: route rate limit 10 answers per minute per IP (60 reads), a per-form cap of 300 answers per
  hour in memory, a 32 KiB body limit (413), a strict body schema, 5,000 characters per text answer.
- Honeypot: a hidden `website` field; a filled one gets `{ ok: true }` and nothing is written.
- The answer never carries the row, its id or anything about other rows; `Cache-Control: no-store`
  and `X-Robots-Tag: noindex`. Cross-site POSTs are refused by the origin check (ADR 1062),
  so a form cannot be posted from another site.

## Alternatives considered
- A system "form" user: a row by nobody the workspace knows, and nothing would stop a form after its
  publisher left or lost access.
- CAPTCHA (hCaptcha, Turnstile): a third party on a self-hosted app, and a script on the page.
- Proof of work in the browser: costs every honest visitor, a bot pays it easily.

## Consequences
- The per-form cap is per process (several server processes multiply it).
- Code that reads any non-null `via` as "an agent" (provenance badge, activity AI filter, agent
  digest) counts form rows as agent edits until it learns the `public form` value (KNOWN-ISSUES).
- For the publisher, form rows are their own changes in catch_up (ADR 1653); others see
  "<publisher> via public form".
- Tests: `forms.db.test.ts` (leaks, limits, honeypot, closing cases, change feed, rate limit through
  `@fastify/rate-limit` as configured in index.ts).
