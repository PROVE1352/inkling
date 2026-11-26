import { z } from 'zod'
import { agentContextFor } from '../routes/editLock'
import type { AgentContextDTO } from '../routes/editLock'
import { runAsAgent } from '../agentAccess'
import type { AgentScope } from '../agentAccess'
import { getBearerUser } from '../oauth'
import { runInRange } from '../tokenRange'
import type { RangeScope } from '../tokenRange'
import { ToolError } from './core'
import { instructionWorkspaces } from '../agentInstructions'
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
export async function loadAgentContext(
  ctx: ToolCtx,
  ids: string[],
  /** anchors: only these sections were handed over (read_page section=…), so only their flags count */
  opts: { read?: boolean; anchors?: { pageId: string; anchor: string }[] } = {},
): Promise<AgentContextDTO> {
  const uniq = [...new Set(ids)].slice(0, 50)
  if (!uniq.length) return { pages: [], applies: [] }
  if (!idsSchema.safeParse(uniq).success) throw new ToolError('Request failed (VALIDATION): page ids must be UUIDs')
  // read: page content is being handed to the agent (taint record, docs/adr/0977-*).
  const run = () => agentContextFor(ctx.user.id, uniq, { read: opts.read, anchors: opts.anchors })
  const scope = await agentScopeOf(ctx)
  if (!scope) throw new ToolError('Request failed (HTTP 401): the access token is no longer valid; reconnect the Inkling connector')
  const { range } = scope
  const ac: AgentContextWithWorkspaces = await runAsAgent(scope.agent, range ? () => runInRange(range, run) : run)
  // the applies line names each instruction's workspace (C-mcp M1; titles alone can be copied)
  if (ac.applies.length) ac.appliesWs = await instructionWorkspaces(ac.applies.map((a) => a.pageId))
  return ac
}

/** The agent context with the workspaces of its instruction pages (loadAgentContext fills it). */
export type AgentContextWithWorkspaces = AgentContextDTO & { appliesWs?: Map<string, { id: string; name: string }> }

/**
 * `applies: {Workspace} A; {Workspace} B (…)` or null when nothing applies. Deterministic order
 * (server). Without the workspaces (a context not from loadAgentContext) the titles alone.
 */
export function appliesLine(c: AgentContextWithWorkspaces): string | null {
  if (!c.applies.length) return null
  if (c.appliesWs) return appliesLineByWorkspace(c, c.appliesWs)
  return `applies: ${c.applies.map((a) => cleanText(a.title || 'Untitled').replace(/\s+/g, ' ')).join('; ')} (read them with get_instructions)`
}

/** Longest workspace name printed in a result line (cut with "…"). */
const WS_NAME_MAX = 40

/** `{Name} ` label of a workspace: the member-written name cleaned on one line, no braces, cut (docs/adr/2185-*). */
export function wsLabel(name: string, fallback: string): string {
  const n = cleanText(name).replace(/[{}]/g, '').trim()
  const short = [...n].length > WS_NAME_MAX ? `${[...n].slice(0, WS_NAME_MAX - 1).join('')}…` : n
  return `{${short || fallback}} `
}

/**
 * The `applies:` line with workspaces (C-mcp M1): each instruction title carries its workspace
 * (`{Name} Title`), and the line says rules stay in their workspace. find_context (an answer may span
 * workspaces) and, since the merge of 0.25.4, every other tool's applies line (appliesLine).
 * `ws`: instruction page id → workspace (instructionWorkspaces). Null when nothing applies.
 */
export function appliesLineByWorkspace(ac: AgentContextDTO, ws: Map<string, { id: string; name: string }>): string | null {
  if (!ac.applies.length) return null
  // a workspace may take another's name: two workspaces with one label get their short ids too
  const idsByLabel = new Map<string, Set<string>>()
  for (const a of ac.applies) {
    const w = ws.get(a.pageId)
    if (!w) continue
    const l = wsLabel(w.name, w.id.slice(0, 8))
    idsByLabel.set(l, (idsByLabel.get(l) ?? new Set()).add(w.id))
  }
  const one = (a: AgentContextDTO['applies'][number]) => {
    const w = ws.get(a.pageId)
    if (!w) return cleanText(a.title || 'Untitled')
    const l = wsLabel(w.name, w.id.slice(0, 8))
    const label = (idsByLabel.get(l)?.size ?? 0) > 1 ? `${l.slice(0, -2)} ${w.id.slice(0, 8)}} ` : l
    return `${label}${cleanText(a.title || 'Untitled')}`
  }
  return `applies: ${ac.applies.map(one).join('; ')} (read them with get_instructions; a workspace's rules apply only to its own pages)`
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

/**
 * Runs a direct database read as this connection: inside its agent scope and connection range,
 * exactly as requireUser enters them for an injected request, so `visibleTo`, `agentAllowedSql`
 * and `memberWorkspaceIds` narrow the same way (docs/adr/1541-*: short id resolution).
 */
export async function runAsConnection<T>(ctx: ToolCtx, fn: () => Promise<T>): Promise<T> {
  const scope = await agentScopeOf(ctx)
  if (!scope) throw new ToolError('Request failed (HTTP 401): the access token is no longer valid; reconnect the Inkling connector')
  const { range } = scope
  return runAsAgent(scope.agent, range ? () => runInRange(range, fn) : fn)
}
