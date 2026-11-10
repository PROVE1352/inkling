# 1842. Verified and stale marks in agent output

- Status: Accepted
- Date: 2026-11-10

## Context
An agent answering from notes should weigh a page someone vouches for differently from one whose
verification lapsed, at almost no token cost.

## Decision
- `read_page` (full, outline and section reads) prints one line only for pages that have a
  verification: `- verified: until 2026-12-10` or `- stale: verification lapsed 2026-11-01`, plus
  `, 3 sections changed since` when the change feed has some. Full reads put it after the review
  lines and before the claims line (clock-dependent lines last, docs/adr/0937-*, 1543-*).
- `find_context` adds to the fragment header `; verified`, `; verified, changed since` (changedMuch)
  or `; stale: verification lapsed`. Pages without a verification print nothing.
- Dates only, server-local, never relative; the state flips at most once a day per page.
- Cost (`estimateTokens`): `- verified: until …` 8 tokens, the stale form with a change count 17;
  `; verified` 3, `; stale: verification lapsed` 7. Pages without a verification: 0. Measured end to
  end in verifyStatus.db.test.ts on a fresh page: read_page +13 and find_context +7, which includes
  the review date that verifying also sets (`- reviewedAt:` / `reviewed …`, docs/adr/1840-*).

## Alternatives considered
- **Hide stale pages from find_context**: the content may still be right; the agent decides.
- **A separate tool** (`list_verified`): one more call for the common case; the marks ride on the
  reads agents already make.
