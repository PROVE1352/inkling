import path from 'node:path'
import { agentUploadEnv } from './agentUploads'

/**
 * Uploads through a connection (MCP upload_file, personal API tokens; docs/adr/2044-*, 2045-*).
 *
 * The web upload trusts the browser's Content-Type against an allow list. A connection's upload is
 * typed by the server instead: the file name's extension says what it claims to be, and the bytes
 * must agree (magic numbers for images and PDF, strict UTF-8 without NUL for text). Anything else —
 * SVG, HTML, scripts, archives, executables, audio/video — is refused. Stored files are served as
 * before (rasters inline, everything else as an attachment with nosniff and a sandbox CSP).
 */

/**
 * One file through a connection (AGENT_UPLOAD_MAX_MB, default 5, at most 8: the MCP request body is
 * 12 MB and base64 adds a third, JSON a little more; docs/adr/2065-*).
 */
export const AGENT_UPLOAD_MAX_BYTES = agentUploadEnv.maxBytes
/** Bytes a person's connections may upload per rolling 24 hours (AGENT_UPLOAD_DAILY_MB, default 200; null = no budget). */
export const AGENT_UPLOAD_DAILY_BYTES = agentUploadEnv.dailyBytes

const BINARY: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
}

const TEXT: Record<string, string> = {
  '.txt': 'text/plain',
  '.log': 'text/plain',
  '.tsv': 'text/plain',
  '.csv': 'text/csv',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.json': 'application/json',
}

export const AGENT_UPLOAD_EXTENSIONS = [...Object.keys(BINARY), ...Object.keys(TEXT)]

/** MIME type from the first bytes (the types connections may upload), or null. */
export function magicMime(b: Buffer): string | null {
  if (b.length > 8 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a) return 'image/png'
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.length > 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString('latin1'))) return 'image/gif'
  if (b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp'
  if (b.length > 5 && b.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf'
  return null
}

const utf8 = new TextDecoder('utf-8', { fatal: true })

/** Valid UTF-8 without NUL (a BOM is fine). */
export function isPlainText(b: Buffer): boolean {
  if (b.includes(0)) return false
  try {
    utf8.decode(b)
    return true
  } catch {
    return false
  }
}

/**
 * The stored type of a connection's upload named `name` with content `bytes`, or why it is refused.
 * The extension decides what it claims; the content must match it.
 */
export function agentUploadMime(name: string, bytes: Buffer): { mime: string } | { error: string } {
  const ext = path.extname(name).toLowerCase()
  const allowed = `allowed: ${AGENT_UPLOAD_EXTENSIONS.join(' ')}`
  if (BINARY[ext]) {
    const m = magicMime(bytes)
    if (m !== BINARY[ext]) return { error: `the content is not a ${ext.slice(1).toUpperCase()} file (name and bytes disagree)` }
    return { mime: m }
  }
  if (TEXT[ext]) {
    if (!isPlainText(bytes)) return { error: `a ${ext} file must be UTF-8 text without NUL bytes` }
    return { mime: TEXT[ext] }
  }
  return { error: `files named ${ext || '(no extension)'} cannot be uploaded through a connection (${allowed}; SVG, HTML and scripts are refused)` }
}
