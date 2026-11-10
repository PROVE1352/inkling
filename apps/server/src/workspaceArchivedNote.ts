import { cleanText } from './mcpTools/trust'

/** An archived workspace a default-scope answer left out (docs/adr/2303-*). */
export interface ArchivedWorkspace {
  id: string
  name: string
}

/** Names printed in the note; the rest are counted. */
export const ARCHIVED_NOTE_NAMES = 5
const NAME_MAX = 40

/**
 * The closing line of a default-scope answer that left archived workspaces out (docs/adr/2304-*):
 * deterministic (name order, fixed caps), our own text with cleaned names (as ADR 2186's errors).
 * null when nothing was left out, so answers of people without archived workspaces are unchanged.
 */
export function archivedNote(archived: ArchivedWorkspace[] | undefined, kind: 'search' | 'catch_up' = 'search'): string | null {
  if (!archived?.length) return null
  // by name, then id: the same order whichever path computed the list
  const sorted = [...archived].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const named = sorted.slice(0, ARCHIVED_NOTE_NAMES).map((w) => {
    const name = cleanText(w.name).replace(/\s+/g, ' ').replace(/"/g, "'").trim()
    const short = [...name].length > NAME_MAX ? `${[...name].slice(0, NAME_MAX - 1).join('')}…` : name
    return `${w.id.slice(0, 8)} "${short}"`
  })
  const rest = archived.length - named.length
  const n = archived.length
  const list = `${n} archived workspace${n === 1 ? '' : 's'} (${named.join(', ')}${rest > 0 ? `, ${rest} more` : ''})`
  if (kind === 'catch_up') {
    return `Not included: changes, comments and due tasks of ${list}; items for you from them are. Pass workspaceId=<id or name> for one.`
  }
  return `Not searched: ${list}; pass workspaceId=<id or name> to include one.`
}
