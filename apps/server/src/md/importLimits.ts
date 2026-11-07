// Import caps (docs/adr/0961-*). Every value can be raised or lowered through the environment;
// the defaults are the historical hard-coded caps, so an unconfigured server behaves as before.
//
//   IMPORT_MAX_UPLOAD_MB    25    one uploaded .md / .zip (POST /workspaces/:id/import)
//   IMPORT_MAX_UNPACKED_MB  50    real decompressed bytes of one import (zip entries, folder parts)
//   IMPORT_MAX_ENTRY_MB     25    one decompressed file inside an archive
//   IMPORT_MAX_FILES        300   files in one archive / folder upload (nested Notion parts included)
//   IMPORT_MAX_PAGES        5000  pages one import may create (folders, docs, canvases, rows)
//
// Memory: a zip is held compressed in memory while its entries are decompressed one at a time
// through readZipEntryCapped, so the peak is roughly upload size + one entry (+ the nested part
// archives of a Notion export, which are bounded by IMPORT_MAX_UPLOAD_MB as well).

const MB = 1024 * 1024

function positiveInt(name: string, fallback: number): number {
  const n = Number(process.env[name])
  return Number.isInteger(n) && n > 0 ? n : fallback
}

export interface ImportLimits {
  maxUploadBytes: number
  maxUnpackedBytes: number
  maxEntryBytes: number
  maxFiles: number
  maxPages: number
}

export function readImportLimits(): ImportLimits {
  return {
    maxUploadBytes: positiveInt('IMPORT_MAX_UPLOAD_MB', 25) * MB,
    maxUnpackedBytes: positiveInt('IMPORT_MAX_UNPACKED_MB', 50) * MB,
    maxEntryBytes: positiveInt('IMPORT_MAX_ENTRY_MB', 25) * MB,
    maxFiles: positiveInt('IMPORT_MAX_FILES', 300),
    maxPages: positiveInt('IMPORT_MAX_PAGES', 5000),
  }
}

/** Read once at module load, like the other env-driven settings. */
export const importLimits: ImportLimits = readImportLimits()

/** "25MB" style label used in error messages (unchanged text at the default values). */
export function mbLabel(bytes: number): string {
  return `${Math.round(bytes / MB)}MB`
}
