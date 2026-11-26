# 2578. Per-person cap on section claims; the upload budget is checked again when the file is stored

- Status: Accepted
- Date: 2026-11-26

## Context
A connection may hold 20 live section claims (docs/adr/1535-*, 1536-*), and a claim stops other agents'
writes to that section. One account may have up to 50 API tokens and many OAuth grants, so one member
could keep a thousand sections claimed and block every other agent (C-mcp L3). The daily budget of
uploads through connections (docs/adr/2045-*, 2065-*) was checked before the body was read and never
again, so parallel uploads all passed it (C-mcp I2).

## Decision
- `claimSection` also counts the live claims of the person over all their connections and refuses at
  `MAX_CLAIMS_PER_PERSON` (60, limits.ts; no setting) with 429 `TOO_MANY_CLAIMS`. Extending a claim the
  connection already holds is not counted as a new one.
- `recheckDailyUploadBudget(tx, userId)` takes a transaction-scoped advisory lock per person and counts
  the budget again inside the transaction that inserts the files row, so parallel uploads pass the budget
  by one upload at most. The early check stays.

## Consequences
- Extending the same claim over and over is still possible (one section per claim); a cap on extensions
  is left for later.
- The two checks are count-then-insert: two parallel claims can end one above the cap.
- The upload recheck applies where it is called: `POST /files` through a connection. A zip imported
  through a connection asks the budget again before each attachment (0.25.4 merge): its attachments are
  stored one by one outside a transaction, so there is no lock to take; once the budget is passed the
  remaining attachments are skipped and reported, and the pages still import.
