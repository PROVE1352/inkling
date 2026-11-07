/** Export: mime → file extension (simple map; '' when unknown). */
const MIME_TO_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'application/pdf': '.pdf',
}

export function extForMime(mime: string): string {
  return MIME_TO_EXT[mime] ?? ''
}

/** Import: extension → mime (application/octet-stream when unknown). */
const EXT_TO_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  // .svg is an active (scriptable) type, so it is deliberately unmapped → octet-stream fallback (S1)
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.txt': 'text/plain',
}

export function mimeForExt(ext: string): string {
  return EXT_TO_MIME[ext.toLowerCase()] ?? 'application/octet-stream'
}

// Reserved characters stripped from file names (/ \ : * ? " < > |). Spaces and hyphens are kept.
const RESERVED_CHARS = /[/\\:*?"<>|]/g
// Control characters (U+0000–U+001F).
const CONTROL_CHARS = new RegExp('[\\u0000-\\u001f]', 'g')

/** Sanitize a file name/title: strip reserved and control characters, trim; 'Untitled' when empty. */
export function sanitizeName(title: string): string {
  const cleaned = title.replace(RESERVED_CHARS, '').replace(CONTROL_CHARS, '').trim()
  return cleaned.length > 0 ? cleaned : 'Untitled'
}
