import { sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { LARGE_PAGE_STATE_BYTES, LARGE_PAGE_TOKENS } from '@inkling/shared'

/**
 * "Large page" threshold and the one-line hint MCP tools add for such pages (docs/adr/1043-*).
 *
 * A page is large when its stored Yjs state reaches LARGE_PAGE_STATE_BYTES or its indexed body
 * reaches LARGE_PAGE_TOKENS estimated tokens (context/tokens.ts). Both come from columns that need
 * no decode: octet_length(page_docs.state) reads the TOAST header, page_chunks.token_estimate is an
 * integer column.
 */

// LARGE_PAGE_STATE_BYTES: stored state size (V1 bytes) from which a whole-document decode costs
// ≈ 30–45 ms of event loop (measured 4.5 MB → 130–210 ms). LARGE_PAGE_TOKENS: indexed body size above
// what any single budgeted read returns (read_pages ≤ 30k, find_context ≤ 12k tokens). Shared with the
// web notice (docs/adr/1103-*).
export { LARGE_PAGE_STATE_BYTES, LARGE_PAGE_TOKENS }

export const LARGE_PAGE_HINT =
  'large page: read it by section (read_page outline=true, then section=…) and add new entries to a child page instead of appending here'

/**
 * V1 bytes per V2 byte of a stored state (docs/adr/1101-*): the threshold was set on V1 states, and
 * a page must not stop being "large" when its row is rewritten as V2. Measured on the 4.5 MB
 * production copy (4,499,751 → 3,079,353 bytes = 0.684).
 */
export const V2_TO_V1_BYTES = 1.46

/**
 * SQL: the stored state size of page_docs row `d` in V1 bytes (exact for V1 rows, estimated for V2
 * rows). Reads the TOAST header and a column, never the state.
 */
export function stateBytesV1Sql(d: SQL = sql.raw('d')): SQL {
  return sql`(octet_length(${d}.state) * CASE WHEN ${d}.state_format = 2 THEN ${sql.raw(String(V2_TO_V1_BYTES))} ELSE 1 END)::bigint`
}

export function isLargePage(stateBytes: number | null | undefined, tokens: number | null | undefined): boolean {
  return (stateBytes ?? 0) >= LARGE_PAGE_STATE_BYTES || (tokens ?? 0) >= LARGE_PAGE_TOKENS
}
