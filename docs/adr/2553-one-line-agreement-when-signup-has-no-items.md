# 2553. One-line agreement under the sign-up button when signup.json has no items

- Status: Accepted (amends 2519)
- Date: 2026-11-24

## Context
Some operators want what many services abroad do: no tick boxes, only "By signing up, you agree to the
Terms of Service and the Privacy Policy." with links to the documents. The server already accepted
`"items": []` (no required item, so `hasConsented` is always true and no consent screen appears), but the
sign-up form still drew an empty "Agreements" heading and gave no way to reach the documents.

## Decision
- When `items` is empty and the folder has at least one document (`/auth/mode` `legal.docs`), the sign-up
  form (and the setup-code form) shows one line in small grey text right under the button. Each document
  name links to its page (`/terms`, `/privacy`) in a new tab, so the form keeps what was typed. With one
  document the sentence names only that one; with none there is no line. The notice is shown as before.
- No new setting: `items: []` is the choice. A folder with items keeps the tick boxes and no line.
- No consent rows are written for the line. The sign-up still sends `legalVersion`, which the server checks
  as before; a changed document does not ask anyone again, since there is no required item.
- The sentence is cut into text keys around the links (`legal.signupAgreeBefore`, `…And`, `…After`), the way
  other sentences with inline elements are translated.

## Consequences
- An operator using the line has no per-person record of agreement. Whether that is enough is the
  operator's call under their own law (docs/DEMO.md, "These files are not legal advice").
