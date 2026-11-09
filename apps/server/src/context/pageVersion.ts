import { createHash } from 'node:crypto'

/**
 * Page version for the `known` argument of read_page / read_pages (docs/adr/1540-*).
 *
 * A short hash of what those tools show of a page: kind, title, properties and the Markdown body
 * (before any maxChars/budget cut, trimmed). No schema column: it is computed from the same state
 * the body is read from, so "unchanged" can only mean "the agent would get the same content".
 * `updatedAt` is not part of it (a save that changes nothing visible keeps the version).
 */

export interface AgentProperty {
  name: string
  type: string
  value: unknown
}

/** The page properties as read_page prints them (layout-only `fullWidth` left out). */
export function agentProperties(raw: unknown): AgentProperty[] {
  return (Array.isArray(raw) ? (raw as { id?: string; name: string; type: string; value?: unknown }[]) : [])
    .filter((p) => p && p.id !== 'fullWidth')
    .map((p) => ({ name: p.name, type: p.type, value: p.value ?? null }))
}

export function pageVersion(p: { kind: string; title: string; properties: AgentProperty[]; body: string }): string {
  return createHash('sha1')
    .update(p.kind)
    .update('\u0000')
    .update(p.title)
    .update('\u0000')
    .update(p.properties.length ? JSON.stringify(p.properties) : '')
    .update('\u0000')
    .update(p.body.trim())
    .digest('hex')
    .slice(0, 12)
}
