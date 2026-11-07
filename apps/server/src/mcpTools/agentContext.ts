import { z } from 'zod'
import { agentContextFor } from '../routes/editLock'
import type { AgentContextDTO } from '../routes/editLock'
import { runAsAgent } from '../agentAccess'
import type { AgentScope } from '../agentAccess'
import { getBearerUser } from '../oauth'
import { runInRange } from '../tokenRange'
import type { RangeScope } from '../tokenRange'
import { ToolError } from './core'
import type { ToolCtx } from './core'
import { cleanText, editPhrase } from './trust'
import { INJECTION_RULES } from '@inkling/shared'
import { suspiciousNote } from '../context/injectionScan'
import { LARGE_PAGE_HINT } from '../context/largePage'

const idsSchema = z.array(z.uuid())

// The /mcp handler builds ctx.user from the token (getBearerUser), so grant and client are set;
// a ctx built without them (tests) resolves them from the token once.
const scopes = new WeakMap<ToolCtx, Promise<{ agent: AgentScope; range: RangeScope | null } | null>>()
function agentScopeOf(ctx: ToolCtx): Promise<{ agent: AgentScope; range: RangeScope | null } | null> {
  let p = scopes.get(ctx)
  if (!p) {
    p = (async () => {
      const u = ctx.user.grantId && ctx.user.clientId && ctx.user.range !== undefined ? ctx.user : await getBearerUser(ctx.token)
      if (!u?.grantId || !u.clientId) return null
      return {
        agent: { userId: u.id, grantId: u.grantId, clientId: u.clientId, clientName: u.via ?? null },
        // the connection range (docs/adr/1200-*), entered here exactly as requireUser does
        range: u.range ?? null,
      }
    })()
    scopes.set(ctx, p)
  }
  return p
}

/**
 * Per-page facts every page-level tool output starts with (docs/adr/0975-*, 0976-*): which agent
 * instructions apply ("applies:" line, titles only), what this agent may do ("can:"), and who last
 * edited the page (provenance attributes of the untrusted_content wrapper).
 *
 * Same function as GET /api/pages/agent-context, called in process (docs/adr/1070-*): the tool's
 * REST call before it already authenticated the token and checked access, so the second inject
 * (token lookup, request pipeline) is not repeated. The agent scope is entered here exactly as
 * requireUser does for an injected request, so blocks and agent lock rules apply unchanged.
 */
export async function loadAgentContext(ctx: ToolCtx, ids: string[], opts: { read?: boolean } = {}): Promise<AgentContextDTO> {
  const uniq = [...new Set(ids)].slice(0, 50)
  if (!uniq.length) return { pages: [], applies: [] }
  if (!idsSchema.safeParse(uniq).success) throw new ToolError('Request failed (VALIDATION): page ids must be UUIDs')
  // read: page content is being handed to the agent (taint record, docs/adr/0977-*).
  const run = () => agentContextFor(ctx.user.id, uniq, { read: opts.read })
  const scope = await agentScopeOf(ctx)
  if (!scope) throw new ToolError('Request failed (HTTP 401): the access token is no longer valid; reconnect the Inkling connector')
  const { range } = scope
  return runAsAgent(scope.agent, range ? () => runInRange(range, run) : run)
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
    large: p?.large ?? false,
  }
}

/** The large-page hint line for `id`, or null (docs/adr/1043-*). */
export function largeLine(c: AgentContextDTO, id: string): string | null {
  return pageFacts(c, id).large ? LARGE_PAGE_HINT : null
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
