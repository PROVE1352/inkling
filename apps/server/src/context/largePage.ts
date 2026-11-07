/**
 * "Large page" threshold and the one-line hint MCP tools add for such pages (docs/adr/1043-*).
 *
 * A page is large when its stored Yjs state reaches LARGE_PAGE_STATE_BYTES or its indexed body
 * reaches LARGE_PAGE_TOKENS estimated tokens (context/tokens.ts). Both come from columns that need
 * no decode: octet_length(page_docs.state) reads the TOAST header, page_chunks.token_estimate is an
 * integer column.
 */

/** Stored state size from which a whole-document decode costs ≈ 30–45 ms of event loop (measured 4.5 MB → 130–210 ms). */
export const LARGE_PAGE_STATE_BYTES = 1024 * 1024
/** Indexed body size above what any single budgeted read returns (read_pages ≤ 30k, find_context ≤ 12k tokens). */
export const LARGE_PAGE_TOKENS = 50_000

export const LARGE_PAGE_HINT =
  'large page: read it by section (read_page outline=true, then section=…) and add new entries to a child page instead of appending here'

export function isLargePage(stateBytes: number | null | undefined, tokens: number | null | undefined): boolean {
  return (stateBytes ?? 0) >= LARGE_PAGE_STATE_BYTES || (tokens ?? 0) >= LARGE_PAGE_TOKENS
}
