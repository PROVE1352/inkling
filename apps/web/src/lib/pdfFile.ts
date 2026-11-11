// Which file blocks get a PDF preview (docs/adr/2480-*). The editor's part: kept apart from
// lib/pdfPreview.ts, which only the lazy preview chunk imports, so the editor chunk carries just this.

/** Uploaded files are served at /files/<uuid> (apps/server/src/routes/files.ts). */
const FILE_PATH = /^\/files\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i

/**
 * The id of an uploaded file of this server, or null. Only these get a preview: an external address
 * would need CORS and `connect-src` beyond 'self', and its bytes are not the workspace's.
 */
export function fileIdOf(url: string | undefined | null, origin: string): string | null {
  if (!url) return null
  let u: URL
  try {
    u = new URL(url, origin)
  } catch {
    return null
  }
  if (u.origin !== origin || u.search || u.hash) return null
  const m = FILE_PATH.exec(u.pathname)
  return m ? m[1].toLowerCase() : null
}

/**
 * What the block's file name says: 'pdf' for a .pdf name, 'other' for another extension, 'unknown' when
 * the name has none (then the server's mime decides, see isPdfMime).
 */
export function pdfByName(name: string | undefined | null): 'pdf' | 'other' | 'unknown' {
  const base = (name ?? '').trim().split(/[\\/]/).pop() ?? ''
  const dot = base.lastIndexOf('.')
  if (dot <= 0 || dot === base.length - 1) return 'unknown'
  const ext = base.slice(dot + 1).toLowerCase()
  if (!/^[a-z0-9]{1,8}$/.test(ext)) return 'unknown'
  return ext === 'pdf' ? 'pdf' : 'other'
}
