/**
 * Data / instruction boundary for MCP tool output (docs/adr/0976-*).
 *
 * Text that members wrote (page bodies, titles, cells, diffs) reaches agents wrapped in
 * `<untrusted_content …>…</untrusted_content>` so an agent can tell data from instructions; only
 * agent instruction pages (locked + designated) are wrapped in `<instructions …>`. This is a
 * mitigation, not a permission boundary: a model may still follow text inside the markers. The real
 * boundaries are the edit lock, OAuth scopes and per-workspace agent blocks.
 *
 * Everything here is pure and deterministic (same input, same bytes), so tool output stays
 * prompt-cache friendly (docs/adr/0937-*).
 */

/** Removed outright: bidi embeddings/overrides/isolates and the Unicode tag block. */
// eslint-disable-next-line no-misleading-character-class
const STRIP = /[\u202A-\u202E\u2066-\u2069\u061C]|\uDB40[\uDC00-\uDC7F]/g

/**
 * Made visible as `\uXXXX`: zero-width and other invisible format characters that can hide text
 * or split words. U+200D (zero-width joiner) and U+FE0F are kept: emoji sequences need them.
 */
const SHOW = /[\u200B\u200C\u200E\u200F\u2060-\u2064\u180E\uFEFF\u00AD]/g

const hex = (c: string) => `\\u${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`

/** Strip/visualise invisible characters. Returns the text and how many characters were affected. */
export function sanitizeInvisible(s: string): { text: string; hidden: number } {
  let hidden = 0
  const text = s
    .replace(STRIP, () => {
      hidden++
      return ''
    })
    .replace(SHOW, (m) => {
      hidden++
      return hex(m)
    })
  return { text, hidden }
}

/** Neutralises our own markers inside content: `<untrusted_content`, `</instructions` … get a fullwidth `＜`. */
const MARKER = /<(\/?)(untrusted_content|instructions)/gi

export function escapeMarkers(s: string): string {
  return s.replace(MARKER, '＜$1$2')
}

/** Sanitised, marker-escaped text (no wrapper). Use for short user strings such as titles. */
export function cleanText(s: string): string {
  return escapeMarkers(sanitizeInvisible(s).text)
}

/** Attribute value: one line, sanitised, quotes and angle brackets replaced. */
export function attr(s: string): string {
  return sanitizeInvisible(s)
    .text.replace(/[\r\n\t]+/g, ' ')
    .replace(/"/g, "'")
    .replace(/</g, '‹')
    .replace(/>/g, '›')
    .trim()
}

export interface WrapAttrs {
  /** page | pages | find_context | rows | changes */
  source: string
  id?: string
  /** Last known editor ("Alice", "Alice via Claude"). */
  lastEdit?: string | null
  createdBy?: string | null
}

function attrString(a: WrapAttrs, hidden: number): string {
  const parts = [`source="${attr(a.source)}"`]
  if (a.id) parts.push(`id="${attr(a.id)}"`)
  if (a.createdBy) parts.push(`created_by="${attr(a.createdBy)}"`)
  if (a.lastEdit) parts.push(`last_edit="${attr(a.lastEdit)}"`)
  if (hidden) parts.push(`hidden_chars="${hidden}"`)
  return parts.join(' ')
}

/** Wrap member-written text as data. */
export function wrapUntrusted(body: string, a: WrapAttrs): string {
  const { text, hidden } = sanitizeInvisible(body)
  return `<untrusted_content ${attrString(a, hidden)}>\n${escapeMarkers(text)}\n</untrusted_content>`
}

/** Wrap the body of a designated, locked instruction page. */
export function wrapInstructions(body: string, a: { id: string; title: string; mode: string; applyTo?: string[] }): string {
  const { text, hidden } = sanitizeInvisible(body)
  const parts = [`page="${attr(a.id)}"`, `title="${attr(a.title || 'Untitled')}"`, `mode="${a.mode}"`]
  if (a.applyTo?.length) parts.push(`applies_to="${attr(a.applyTo.join(', '))}"`)
  if (hidden) parts.push(`hidden_chars="${hidden}"`)
  return `<instructions ${parts.join(' ')}>\n${escapeMarkers(text)}\n</instructions>`
}

/**
 * "Alice", "Alice via Claude", "via Claude" — the provenance phrase; null when the last logged
 * change has no recorded actor (live typing, imports), so nothing is claimed that is not known.
 */
export function editPhrase(e: { name: string | null; via: string | null } | null | undefined): string | null {
  if (!e) return null
  if (e.name && e.via) return `${e.name} via ${e.via}`
  if (e.name) return e.name
  if (e.via) return `via ${e.via}`
  return null
}
