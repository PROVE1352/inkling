import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { CLAIM_TTL_DEFAULT_S, CLAIM_TTL_MAX_S, SUGGESTION_STATUS_FILTERS } from '@inkling/shared'
import type { PageSuggestionsDTO, SectionClaimDTO, SuggestionDTO } from '@inkling/shared'
import { claimLine } from '../leases'
import { ruleText } from '../autoAccept'
import { call, text, ToolError, uuid, wrap, wrapWrite } from './core'
import type { ToolCtx } from './core'
import { attr, cleanText, wrapUntrusted } from './trust'

/**
 * Working next to people (docs/adr/1530-* .. 1536-*): suggestions and section claims.
 *
 *   list_suggestions(pageId?)        a page's suggestions and claims, or this person's own suggestions
 *   withdraw_suggestion(id)          take back an open suggestion of yours
 *   claim_section(pageId, section)   "working on this section until …" for this connection
 *   release_section(pageId, section)
 *
 * Accepting or rejecting is for people only (web app, personal API token); there is no tool for it.
 * Output is one fixed-format line per item with absolute minute timestamps (docs/adr/0937-*);
 * suggestion text and names are member/agent text and go through the untrusted wrapper (ADR 0976).
 */

const minute = (iso: string) => `${iso.slice(0, 16)}Z`
/** Characters of a suggestion's Markdown shown by list_suggestions(pageId). */
const SHOW_CHARS = 2_000

const where = (s: SuggestionDTO) => (s.anchor ? `§${attr(s.anchor)}` : 'whole page')

/** The answer of a write that was kept as a suggestion (patch_section, update_page). */
export function suggestionMadeText(s: SuggestionDTO): string {
  // auto-accepted at once (docs/adr/1545-*)
  if (s.status === 'accepted' && s.rule) {
    const now = s.applied ? `§${attr(s.applied.anchor)} is now v=${s.applied.version}.` : 'the section was removed.'
    return `Done (${s.mode}): auto-accepted under ${ruleText(s.rule)} (suggestion ${s.id}); ${now}`
  }
  if (s.status === 'open' && s.autoAt) {
    return [
      `Not written yet: suggestion ${s.id} for ${where(s)} will be auto-accepted at ${minute(s.autoAt)} unless a person rejects it ` +
        '(or the section changes first, then a person decides).',
      'The result arrives in inbox as approval_result; list_suggestions(pageId) shows it; withdraw_suggestion(id) takes it back.',
    ].join('\n')
  }
  const why =
    s.origin === 'asked'
      ? 'you asked for a suggestion (suggest=true)'
      : s.origin === 'policy'
        ? "the workspace's agent edit policy applies"
        : s.reviewReason
          ? "this page's lock accepts agent edits only by its auto-accept rules"
          : 'this page is locked to "agents: suggestions only"'
  return [
    `Not written: kept as suggestion ${s.id} for ${where(s)} of page ${s.pageId} (${s.mode}), because ${why}.`,
    ...(s.reviewReason ? [`needs review: ${s.reviewReason}`] : []),
    'A person with edit access accepts or rejects it in the web app; the result arrives in inbox as approval_result.',
    'list_suggestions(pageId) shows it; withdraw_suggestion(id) takes it back; a new suggestion from this connection for the same section replaces it.',
  ].join('\n')
}

/** The answer of patch_sections when its edits were kept as suggestions. */
export function suggestionsMadeText(list: SuggestionDTO[]): string {
  if (list.length === 1) return suggestionMadeText(list[0])
  const s = list[0]
  const why =
    s.origin === 'lock' ? 'this page is locked to "agents: suggestions only"' : s.origin === 'policy' ? "the workspace's agent edit policy applies" : 'you asked for suggestions (suggest=true)'
  const state = (x: SuggestionDTO) =>
    x.status === 'accepted' && x.rule
      ? `auto-accepted under ${ruleText(x.rule)}`
      : x.autoAt
        ? `auto-accepted at ${minute(x.autoAt)} unless rejected`
        : x.reviewReason
          ? `needs review: ${x.reviewReason}`
          : 'waits for a person'
  return [
    `Not written: kept as ${list.length} suggestions on page ${s.pageId}, because ${why}:`,
    ...list.map((x) => `- ${x.id} for ${where(x)} (${x.mode}): ${state(x)}`),
    'A person with edit access accepts or rejects each in the web app; results arrive in inbox as approval_result.',
    'list_suggestions(pageId) shows them; withdraw_suggestion(id) takes one back; a new suggestion from this connection for a section replaces its open one.',
  ].join('\n')
}

function suggestionLine(s: SuggestionDTO): string {
  const by = `${cleanText(s.author.name)}${s.via ? ` (via ${attr(s.via)})` : ''}`
  const decider =
    s.status === 'withdrawn'
      ? 'withdrawn'
      : s.status === 'superseded'
        ? `replaced by ${s.supersededBy ?? 'a newer suggestion'}`
        : s.rule
          ? `by rule (${attr(s.rule)})`
          : `by ${cleanText(s.decidedBy?.name ?? 'someone')}`
  const pending = s.status === 'open' ? (s.autoAt ? ` | auto-accept at ${minute(s.autoAt)}` : s.reviewReason ? ` | needs review: ${attr(s.reviewReason)}` : '') : ''
  const decided = s.decidedAt ? ` | ${decider} ${minute(s.decidedAt)}` : pending
  // accepted_partial (docs/adr/1622-*): the agent learns that only some of its hunks went in.
  const status = s.partial ? `${s.status} (${s.partial.applied} of ${s.partial.total} changes applied)` : s.status
  return `${s.id} | ${status} | page ${s.pageId} ${where(s)} | ${s.mode} | ${by} | ${minute(s.createdAt)}${decided}`
}

export function renderPageSuggestions(pageId: string, r: PageSuggestionsDTO): string {
  const out: string[] = []
  const open = r.suggestions.filter((s) => s.status === 'open')
  const others = r.suggestions.length - open.length
  out.push(`${open.length} open suggestion(s) on page ${pageId}${others ? `, ${others} not open` : ''}`)
  for (const s of r.suggestions) {
    out.push(suggestionLine(s))
    if (s.status === 'open' && s.markdown) {
      const md = s.markdown.length > SHOW_CHARS ? `${s.markdown.slice(0, SHOW_CHARS)}\n[… ${s.markdown.length - SHOW_CHARS} more chars]` : s.markdown
      out.push(wrapUntrusted(md, { source: 'suggestion', id: s.id }))
    }
  }
  if (r.claims.length) {
    out.push('Claims:')
    for (const c of r.claims) out.push(`- §${attr(c.anchor)} ${claimText(c)}`)
  }
  return out.join('\n')
}

const claimText = (c: SectionClaimDTO) => claimLine({ ...c, by: cleanText(c.by) })

export function registerCollabTools(server: McpServer, ctx: ToolCtx): void {
  server.registerTool(
    'list_suggestions',
    {
      title: 'List suggestions',
      description:
        'Suggested edits waiting for a person, and their outcome. With pageId: that page\'s suggestions (open ones with their ' +
        'Markdown) and its section claims. Without: your own suggestions (open, and decided in the last 7 days). One line per ' +
        'suggestion: id | status | page §section | mode | by (via) | time | decided by … at ….',
      inputSchema: {
        pageId: uuid().optional().describe('Page id (default: your own suggestions everywhere)'),
        status: z
          .enum(SUGGESTION_STATUS_FILTERS)
          .optional()
          .describe('open (default), decided (accepted, accepted_partial, rejected), all, or one status (withdrawn, superseded, …)'),
      },
      annotations: { readOnlyHint: true },
    },
    wrap(async ({ pageId, status }) => {
      // One status filter for both paths (docs/adr/1626-*).
      const query = { status: status ?? 'open' }
      if (pageId) {
        const res = await call(ctx, 'GET', `/api/pages/${pageId}/suggestions`, { query })
        return text(renderPageSuggestions(pageId, res.json() as PageSuggestionsDTO))
      }
      const { suggestions } = (await call(ctx, 'GET', '/api/suggestions', { query })).json() as { suggestions: SuggestionDTO[] }
      if (!suggestions.length) {
        return text(`No suggestions of yours with status ${query.status}.${query.status === 'all' ? '' : ' status: "all" lists every state.'}`)
      }
      return text([`${suggestions.length} suggestion(s) of yours, status ${query.status} (newest first):`, ...suggestions.map(suggestionLine)].join('\n'))
    }),
  )

  server.registerTool(
    'withdraw_suggestion',
    {
      title: 'Withdraw suggestion',
      description: 'Take back one of your open suggestions (people no longer see it). Use the id from list_suggestions or patch_section. A suggestion that is no longer open (replaced, decided, withdrawn) is answered with its state.',
      inputSchema: { suggestionId: uuid().describe('Suggestion id') },
    },
    wrapWrite(ctx, async ({ suggestionId }) => {
      const { suggestion } = (await call(ctx, 'POST', `/api/suggestions/${suggestionId}/withdraw`)).json() as { suggestion: SuggestionDTO }
      return text(`Withdrawn: suggestion ${suggestion.id} for ${where(suggestion)} of page ${suggestion.pageId}.`)
    }),
  )

  server.registerTool(
    'claim_section',
    {
      title: 'Claim section',
      description:
        'Tell other agents you are working on one section for a few minutes (default 5, max 30): their patch_section on it is ' +
        'refused until the claim ends or you release_section it. People are never blocked; the web app shows the claim. ' +
        'Claiming again extends it. read_page shows claims as "claimed by … until …".',
      inputSchema: {
        pageId: uuid().describe('Page id (kind=doc)'),
        section: z.string().trim().min(1).max(500).describe('Section anchor, heading text or heading block id'),
        minutes: z.number().int().min(1).max(CLAIM_TTL_MAX_S / 60).optional().describe(`How long (default ${CLAIM_TTL_DEFAULT_S / 60})`),
      },
    },
    wrapWrite(ctx, async ({ pageId, section, minutes }) => {
      const res = await call(ctx, 'POST', `/api/pages/${pageId}/claims`, {
        json: { section, ...(minutes ? { ttlSeconds: minutes * 60 } : {}) },
      })
      const { claim } = res.json() as { claim: SectionClaimDTO }
      return text(`Claimed §${attr(claim.anchor)} of page ${pageId} until ${minute(claim.expiresAt)}. release_section when you are done.`)
    }),
  )

  server.registerTool(
    'release_section',
    {
      title: 'Release section',
      description: 'End your claim on a section (claims also end by themselves).',
      inputSchema: {
        pageId: uuid().describe('Page id'),
        section: z.string().trim().min(1).max(500).describe('Section anchor or heading you claimed'),
      },
    },
    wrapWrite(ctx, async ({ pageId, section }) => {
      const res = await call(ctx, 'DELETE', `/api/pages/${pageId}/claims`, { query: { section } })
      const { released } = res.json() as { released: boolean }
      if (!released) throw new ToolError('This connection holds no claim on that section (it may have ended already)')
      return text(`Released §${attr(section)} of page ${pageId}.`)
    }),
  )
}
