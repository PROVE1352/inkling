# 1103. A "large page" notice for people and a list for workspace managers

- Status: Accepted
- Date: 2026-11-07

## Context
ADR 1043 told agents when a page is large. People were not told: the production "experiment log"
grew to 4.5 MB because an append loop kept writing into one page, and nobody looking at it in the
app saw that it had become slow to open, save, index and version. Workspace owners had no way to
find such pages either; the only signal was the database size.

## Decision
- **Same threshold as the agent hint** (ADR 1043): stored Yjs state ≥ 1 MiB **in V1 bytes** or
  indexed body ≥ 50,000 estimated tokens. The constants move to `@inkling/shared`
  (`LARGE_PAGE_STATE_BYTES`, `LARGE_PAGE_TOKENS`) so server and web cannot drift. Because rows are
  now stored as V2 (ADR 1101), the byte test uses `octet_length(state) × 1.46` for V2 rows
  (`stateBytesV1Sql`, measured V1/V2 ratio of the production copy): a page must not stop being
  "large" when its row is rewritten. The agent-context query (ADR 1043) uses the same expression.
- **`GET /api/pages/:id/size`** → `{ stateBytes, tokens, large }` (`PageSizeDTO`). Two scalar
  subqueries on columns (TOAST header, integer sum), no decode. Same visibility guard as every page
  route. `large` is false for non-document pages.
- **Notice above the document** (`LargePageNotice`, under the title next to the other notices): one
  quiet line, "Large page: splitting it into subpages makes it faster to open and edit." The sizes
  are in its tooltip, not in the line. A close button hides it for that page on this device
  (localStorage list of up to 200 page ids; storage failures just show it again). The query is
  cached for 5 minutes and is not sent at all once dismissed.
- **Workspace settings → Large pages** (owners and admins, like the audit log): pages over either
  threshold, largest first (≤ 100), with size, tokens, last edit and what their version history
  stores (bytes and row count — with ADR 1100 the stored bytes, not the document size per version).
  `GET /api/workspaces/:id/large-pages` (`LargePagesDTO`); members get 403. Private pages of other
  members are not listed (`visibleTo`), as everywhere else. Candidates are filtered on the stored
  size and a per-page token sum before the history is summed for the result rows only.
- Korean UI terms follow the existing ones: 큰 페이지, 하위 페이지, 버전 히스토리.

## Alternatives considered
- **Put `large` in the page DTO.** Every page list and tree response would carry two extra
  subqueries per row for a line shown on one screen. A separate cached request per open page is
  cheaper and keeps the shared page routes untouched.
- **Warn with numbers or a colour.** The goal is a nudge, not an alarm: the page still works. The
  numbers are in the tooltip and the settings list.
- **Block or throttle appends to large pages.** Same reasoning as ADR 1043: it breaks working
  loops; the write path got cheaper instead (ADRs 1042, 1100–1102).

## Consequences
- One more small request when a document opens (none after the notice is dismissed).
- The list reads `page_chunks` token sums of the whole workspace on each open of the tab (owners
  and admins only; one aggregate query).

## References
- apps/server/src/routes/largePages.ts, apps/server/src/context/largePage.ts (`stateBytesV1Sql`),
  apps/server/src/routes/editLock.ts (agent-context `large`)
- packages/shared/src/largePages.ts
- apps/web/src/components/LargePageNotice.tsx, apps/web/src/components/LargePagesPanel.tsx,
  apps/web/src/largePagesApi.ts, apps/web/src/pages/WorkspaceSettings.tsx (tab), apps/web/src/i18n/{en,ko}/large-pages.ts
- apps/server/src/snapshotChain.db.test.ts ("large page facts")
- ADR 1043 (agent hint), ADR 1101 (V2 storage)
