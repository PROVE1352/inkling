# 0305. Spreadsheet import/export in the browser; exceljs only via dynamic import; batch row APIs

- Status: Accepted
- Date: 2026-11-07

## Context
Users import CSV/XLSX into collections, export the current view, and copy/paste ranges between the
table and Google Sheets/Excel. The server should not parse untrusted XLSX (zip bombs, CPU) and the
initial web bundle must not grow by exceljs (~1 MB).

## Decision
- **Parsing in the browser**: CSV with an own RFC 4180 parser (`packages/shared/src/csv.ts`, quotes,
  embedded newlines, BOM, delimiter detection), XLSX with exceljs loaded only through `import('exceljs')`
  (`lib/spreadsheet.ts`; the only other reference is a type-only `typeof import`). Limits checked before
  any upload: 20 MB, 50 000 rows, 200 columns, each with its own message.
- **Type inference** (`inferColumnType`): checkbox, number (thousands separators, currency, %), date
  (ISO, `yyyy/mm/dd`, `yyyy.mm.dd`, US `m/d/yyyy`), select (≤ 20 distinct short values, at most half the
  count), else text. The preview lets the user rename, retype or skip each column and choose the title
  column; target = a new sibling collection or append to the current one.
- **Batch APIs**: `POST /pages/:id/collection/rows/batch` (≤ 1 000 rows/request, one transaction with an
  advisory lock, collection cap 100 000 rows, values type-checked against the fields, relation/rollup
  keys dropped, 16 MB body limit) and `PATCH …/rows/batch` (one `UPDATE … FROM jsonb_to_recordset`
  merging `(props || set) - del` in SQL, limited to visible children). The client chunks by 1 000 rows
  and ~4 MB.
- **Export** uses the current view (filters, sorts, visible columns, display text). CSV has a UTF-8 BOM
  and every cell passes `escapeFormula` (prefix `'` for `= + @`, tab/CR, and `-` unless the cell is a
  plain number) — CWE-1236. XLSX writes typed cells (numbers, booleans, dates); strings are text cells
  and are formula-escaped too because users re-save XLSX as CSV.
- **Clipboard**: copying a selected cell range writes TSV + an HTML `<table>`; paste prefers HTML tables
  (Sheets/Excel) and falls back to TSV, updates existing rows and creates overflow rows via the batch
  APIs, adding missing select options first.

## Alternatives considered
- **Server-side import endpoint**: one request, but the server would parse untrusted XLSX and need
  multipart limits; progress is harder to show.
- **SheetJS**: not installed; license changes in recent versions.

## Trade-offs
Imports are chunked, not atomic: a failure mid-way leaves the rows already inserted (the error shows
how far it got). Paste into relation/rollup/person-by-unknown-name cells is skipped.

## How others solve it
Notion imports CSV client-side into a new database; Airtable's paste creates rows/options the same
way; OWASP recommends the leading-quote escape for CSV injection.

## Consequences
Import of a 50k-row file sends ~50 batch requests.

## References
- packages/shared/src/csv.ts:47 (`parseCsv`), :121 (`escapeFormula`), :212 (`inferColumnType`), :251 (`coerceCellValue`)
- apps/web/src/lib/spreadsheet.ts:64 (`readSpreadsheet`), :147 (CSV), :152 (XLSX), :214 (clipboard)
- apps/server/src/routes/collectionsExt.ts:144 (batch POST), :191 (batch PATCH)
- apps/web/src/components/collection/ImportModal.tsx, apps/web/src/lib/collectionPaste.ts
