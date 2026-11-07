import type { AgentContextDTO } from '../routes/editLock'
import { call } from './core'
import type { ToolCtx } from './core'
import { cleanText, editPhrase } from './trust'
import { INJECTION_RULES } from '@inkling/shared'
import { suspiciousNote } from '../context/injectionScan'

/**
 * Per-page facts every page-level tool output starts with (docs/adr/0975-*, 0976-*): which agent
 * instructions apply ("applies:" line, titles only), what this agent may do ("can:"), and who last
 * edited the page (provenance attributes of the untrusted_content wrapper). One REST call.
 */
export async function loadAgentContext(ctx: ToolCtx, ids: string[], opts: { read?: boolean } = {}): Promise<AgentContextDTO> {
  const uniq = [...new Set(ids)].slice(0, 50)
  if (!uniq.length) return { pages: [], applies: [] }
  const query: Record<string, string> = { ids: uniq.join(',') }
  // read=1: page content is being handed to the agent (taint record, docs/adr/0977-*).
  if (opts.read) query.read = '1'
  return (await call(ctx, 'GET', '/api/pages/agent-context', { query })).json() as AgentContextDTO
}

/** `applies: A; B (get_instructions)` or null when nothing applies. Deterministic order (server). */
export function appliesLine(c: AgentContextDTO): string | null {
  if (!c.applies.length) return null
  return `applies: ${c.applies.map((a) => cleanText(a.title || 'Untitled').replace(/\s+/g, ' ')).join('; ')} (read them with get_instructions)`
}

/** Prepends the applies line (if any) as the first line of `text`. */
export function withApplies(c: AgentContextDTO, text: string): string {
  const line = appliesLine(c)
  return line ? `${line}\n${text}` : text
}

export function pageFacts(c: AgentContextDTO, id: string) {
  const p = c.pages.find((x) => x.id === id)
  return {
    can: p?.can ?? 'read',
    createdBy: p?.createdBy ?? null,
    lastEdit: editPhrase(p?.lastEdit ?? null),
    suspicious: p?.suspicious ?? [],
  }
}

/** Rules flagged on any of `anchors` (all sections when omitted), canonical order. */
export function flaggedRules(c: AgentContextDTO, id: string, anchors?: string[]): string[] {
  const set = new Set<string>()
  for (const f of pageFacts(c, id).suspicious) if (!anchors || anchors.includes(f.anchor)) for (const r of f.rules) set.add(r)
  return INJECTION_RULES.filter((r) => set.has(r))
}

/** `suspicious: injection-like (rules) in §a, §b` for a whole page, or null. */
export function pageSuspiciousLine(c: AgentContextDTO, id: string): string | null {
  const flagged = pageFacts(c, id).suspicious
  if (!flagged.length) return null
  return `${suspiciousNote(flaggedRules(c, id))} in ${flagged.map((f) => `§${f.anchor}`).join(', ')}`
}
