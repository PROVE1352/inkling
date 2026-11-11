# 2519. Terms and consent from LEGAL_DIR: read once, versioned by hash, gated on every way in

- Status: Accepted
- Date: 2026-11-12

## Context
A public demo server must show its terms and privacy policy to people who are not signed in, take each
consent item separately at sign-up and record it, and stop accounts that have not agreed to the current
text (accounts made by other paths, or everyone after the text changed) on every way in: the browser,
personal API tokens, MCP, the collaboration socket. The texts are the operator's, not ours, and the same
code runs on servers that have none (the release server among them).

## Decision
- **The folder** (`LEGAL_DIR`): `terms.{ko,en}.md`, `privacy.{ko,en}.md` (those present) and `signup.json`
  (`notice`, `items[]` of `id`, `required`, `label`, optional `doc`, `details`). Read once when the app is
  built (`legal/bundle.ts`). A shape error refuses to boot with the file and the reason: unknown keys, an
  empty label, a duplicate id, a `doc` whose file is missing. Other files in the folder are ignored and
  listed in the boot log; template placeholders left in a file are a boot warning.
- **Version** = the first 12 hex characters of sha256 over the recognised files in name order, each as
  `name NUL content NUL`. A README or `.DS_Store` next to them does not change it. The server reads the
  folder only at start, so a new version comes with a restart, which also closes every open collaboration
  connection: no live connection needs a separate re-check.
- **Routes** under `/api/legal` (all exempt from request gates): `GET /legal` (notice and items in the asked
  language, `?locale=` or Accept-Language), `GET /legal/:doc` (served from the loaded bundle, never from a
  path built out of the request; a language the folder lacks falls back to the other), `POST
  /legal/consent` (signed-in, browser sessions only: an API token or agent must not agree for a person,
  and the exempt prefix would otherwise let them).
- **Sign-up**: a `before` hook checks `consents` and `legalVersion` (same version, only known items,
  every required item; otherwise 400 `CONSENT_REQUIRED` with the current `version`), the `on` hook writes
  one `user_consents` row per ticked item in the account's transaction. The setup-code first admin gets
  the same check: the operator agrees to the terms like everyone else.
- **Gate**: one request gate refuses a person without rows for every required item of the current
  version with 403 `CONSENT_REQUIRED`, whose message says what to do and where (an agent relays it).
  Automation runs (`user.automation`) pass: they are the server acting on a rule set up earlier, and a
  refusal would count as a failure and switch the rule off. `/auth/me` carries `consentRequired: true`,
  `/auth/mode` carries `legal: { version, docs }`.
- **Cost**: "agreed" is cached per version and person (bounded LRU, 10 minutes); "not agreed" is not cached,
  so a consent written by any path counts on the next request. It cannot turn stale: a new version is a
  new key, and consent rows go only with the account.
- **Without LEGAL_DIR** nothing is registered (no routes, hook, gate or field). `registerLegal` reconciles
  with the current setting on every call, so tests can switch the folder on and off in one process.

## Consequences
- The texts are trusted as Markdown, never as HTML (ADR 2520).
- Changing the terms means editing the folder and restarting; everyone, the operator included, agrees again.
- `PATCH /api/auth/me/locale` stays gated: the consent screen changes the language in the browser only and
  saves it right after the consent.
