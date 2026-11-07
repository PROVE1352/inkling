import { z } from 'zod'

// ---------------------------------------------------------------------------
// Collection extensions: relations/rollups, batch row APIs, spreadsheet import,
// Google Sheets read sync (experimental), iCal subscription.
// ---------------------------------------------------------------------------

/** Spreadsheet import limits (enforced in the browser; the server enforces the row caps). */
export const IMPORT_MAX_BYTES = 20 * 1024 * 1024
export const IMPORT_MAX_ROWS = 50_000
export const IMPORT_MAX_COLS = 200
/** Max rows per batch request (client chunks larger imports). */
export const BATCH_MAX_ROWS = 1000
/** Hard cap of live rows in one collection accepted by the batch insert API. */
export const COLLECTION_MAX_ROWS = 100_000

/** Minimal reference to a linked row — only rows visible to the viewer are ever included. */
export interface RowRefDTO {
  id: string
  title: string
  icon: string | null
  /** collection page that owns the row */
  parentId: string | null
}

const propsRecord = z.record(z.string().max(40), z.unknown())

export const batchCreateRowsSchema = z.object({
  rows: z
    .array(
      z.object({
        title: z.string().max(500).optional(),
        props: propsRecord.optional(),
      }),
    )
    .min(1)
    .max(BATCH_MAX_ROWS),
})
export type BatchCreateRowsInput = z.infer<typeof batchCreateRowsSchema>

export const batchUpdateRowsSchema = z.object({
  rows: z
    .array(
      z.object({
        id: z.uuid(),
        title: z.string().max(500).optional(),
        /** merged like PATCH /pages/:id/props (null deletes a key) */
        props: propsRecord.optional(),
      }),
    )
    .min(1)
    .max(BATCH_MAX_ROWS),
})
export type BatchUpdateRowsInput = z.infer<typeof batchUpdateRowsSchema>

/** Options for the relation cell picker. */
export interface RowOptionsDTO {
  rows: RowRefDTO[]
  /** true when more rows matched than were returned */
  more: boolean
}

// ---------------------------------------------------------------------------
// Google Sheets read sync (experimental flag: sheets-sync)
// ---------------------------------------------------------------------------

export const SHEETS_SYNC_MIN_INTERVAL = 5
export const SHEETS_SYNC_DEFAULT_INTERVAL = 15

export const sheetSyncSchema = z.object({
  /** "Publish to the web" CSV URL — must start with https://docs.google.com/spreadsheets/ */
  url: z
    .string()
    .trim()
    .max(2000)
    .refine((u) => u.startsWith('https://docs.google.com/spreadsheets/'), {
      message: 'Only https://docs.google.com/spreadsheets/ URLs are allowed',
    }),
  /** sheet column header used as the upsert key ('' = row title column) */
  keyColumn: z.string().trim().min(1).max(200),
  /** sheet column header that becomes the row title (default: key column) */
  titleColumn: z.string().trim().max(200).optional(),
  intervalMinutes: z.number().int().min(SHEETS_SYNC_MIN_INTERVAL).max(24 * 60).optional(),
  enabled: z.boolean().optional(),
})
export type SheetSyncInput = z.infer<typeof sheetSyncSchema>

export interface SheetSyncDTO {
  pageId: string
  url: string
  keyColumn: string
  titleColumn: string | null
  intervalMinutes: number
  enabled: boolean
  lastSyncedAt: string | null
  lastStatus: 'ok' | 'error' | 'running' | null
  lastError: string | null
  lastStats: { inserted: number; updated: number; unchanged: number } | null
}

// ---------------------------------------------------------------------------
// iCal subscription
// ---------------------------------------------------------------------------

export interface IcalStatusDTO {
  /** a feed token exists (the token itself is only shown once, at creation) */
  active: boolean
  createdAt: string | null
  lastUsedAt: string | null
}

export interface IcalIssueDTO extends IcalStatusDTO {
  /** absolute feed URL containing the secret token — shown once */
  url: string
}
