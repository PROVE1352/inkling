// ---------------------------------------------------------------------------
// Large pages (docs/adr/1043-*, 1103-*)
// ---------------------------------------------------------------------------

/**
 * Stored Yjs state size (in V1 bytes) from which a page counts as large. Same value as the agent
 * hint (apps/server/src/context/largePage.ts).
 */
export const LARGE_PAGE_STATE_BYTES = 1024 * 1024
/** Indexed body size (estimated tokens) from which a page counts as large. */
export const LARGE_PAGE_TOKENS = 50_000

/** GET /api/pages/:id/size — what the "large page" notice above the document needs. */
export interface PageSizeDTO {
  /** Stored state size in V1 bytes (exact for V1 rows, estimated for V2 rows). 0 = no body yet. */
  stateBytes: number
  /** Estimated tokens of the indexed body (0 = not indexed yet). */
  tokens: number
  large: boolean
}

/** One row of GET /api/workspaces/:id/large-pages (owners and admins). */
export interface LargePageDTO {
  id: string
  title: string
  icon: string | null
  /** Stored state size in V1 bytes (see PageSizeDTO.stateBytes). */
  stateBytes: number
  tokens: number
  updatedAt: string
  /** Bytes stored by the page's version history (whole states and diffs). */
  snapshotBytes: number
  snapshotCount: number
}

export interface LargePagesDTO {
  pages: LargePageDTO[]
  /** Thresholds the list was built with, for the explanation line. */
  thresholds: { stateBytes: number; tokens: number }
}
