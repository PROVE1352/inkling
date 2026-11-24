# 2554. A "Contact" link to the operator (INSTANCE_CONTACT)

- Status: Accepted
- Date: 2026-11-24

## Context
The operator's contact address was only inside the terms documents. A person using the app had no way on
screen to reach whoever runs the server, and a server without `LEGAL_DIR` had none at all.

## Decision
- `INSTANCE_CONTACT`, read with the other restricted-mode settings (`limits.ts`, `parseInstanceContact`):
  an email address (`you@example.org` or `mailto:you@example.org`) becomes `mailto:<address>`, an
  `https://` URL is kept as written. Any other scheme (`http:`, `javascript:`, …), a space or control
  character, a user name in the URL, or more than 300 characters refuses to boot (`LimitsConfigError`),
  as a bad `INSTANCE_NOTICE` does. The address part takes no `?`, `#`, `%`, `&` or `/`, so the href needs
  no escaping. Empty is unset.
- `/api/auth/mode` carries `instanceContact` (the finished href) only while it is set; a server without
  it answers as before. The boot line says "contact link", not the address.
- The web draws "Contact" / "문의하기" after the terms links in the same three places and the same look:
  under the sign-in, sign-up and consent screens, at the foot of the sidebar, and as a row in
  Settings › About. With no documents the link shows on its own. It draws nothing for an href that is not
  `mailto:` or `https:` (`contactLink.ts`), whatever the server sent. https opens in a new tab with
  `noopener noreferrer`; mailto opens in place.

## Consequences
- Like `INSTANCE_NOTICE`, a change needs a restart, and an open screen keeps the old link until reloaded.
- There is no form or message inbox: the link only points to the operator's own address or page.
