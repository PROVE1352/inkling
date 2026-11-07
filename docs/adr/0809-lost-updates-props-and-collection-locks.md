# 0809. Lost updates: page properties, row props, collection schema lock order

- Status: Accepted
- Date: 2026-11-07
- Audit: A-M4, A-M5, A-M12

## Decision
- `PATCH /pages/:id` reads the page `FOR UPDATE` inside its transaction; fullWidth/date/done edits apply to the locked value (test: 3 concurrent edits keep all 3 properties).
- `PATCH /pages/:id/props` locks the row, computes relation diffs from the locked value and writes `(props || $set) - $del` (test: 8 concurrent single-cell edits all survive).
- `PUT /collection/fields` locks this collection and every old/new relation target in one `… WHERE page_id = ANY($ids) ORDER BY page_id FOR UPDATE`, and the transaction is retried up to twice on 40P01 (`retryOnDeadlock`).
