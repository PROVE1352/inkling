# 0903. Server-generated content: recipient/creator locale, DEFAULT_LOCALE and TZ

- Status: Accepted
- Date: 2026-11-07

## Decision
The server localizes only what it writes for people (`apps/server/src/i18n.ts`):
- Emails (password reset code, temporary password, signup invite, email verification, backup
  failure) have English and Korean bodies. The language is the recipient's `users.locale`, else
  `DEFAULT_LOCALE`. An invite has no recipient account yet, so it uses `DEFAULT_LOCALE`. Times
  in emails are formatted with `Intl` in the server time zone and name the zone.
- Built-in page templates (meeting notes, brainstorm, kickoff, standup, KPT) exist in both
  languages with the same structure and variables. The gallery and "new page from template" use
  the creator's locale: `users.locale`, else the request's `Accept-Language` (the web client sends
  the language it is showing), else `DEFAULT_LOCALE`. The same rule names pages and options the
  server creates on someone's behalf (the Tasks document, default select options).
- `DEFAULT_LOCALE` defaults to `en`. Compose passes `TZ=${TZ:-UTC}`; UTC is the neutral default
  for a public image. Server-side "today" (due dates, reminders, daily-note detection, template
  `{{date}}`) follows `TZ`, so a deployment in Korea sets `TZ=Asia/Seoul` and usually
  `DEFAULT_LOCALE=ko`.

## Trade-offs
Content already created keeps the language it was created in; switching language never rewrites
documents.
