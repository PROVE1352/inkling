import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { acceptSuggestionSchema, CLAIM_TTL_DEFAULT_S, CLAIM_TTL_MAX_S, SUGGESTION_STATUS_FILTERS } from '@inkling/shared'
import type { PageSuggestionsDTO } from '@inkling/shared'
import { currentAgent } from '../agentAccess'
import { getUser, requireUser } from '../auth'
import { db } from '../db/index'
import { assertPageEditable, suggestionRight } from '../editLock'
import { badRequest, notFound } from '../errors'
import { idParam, requireMembership, requireMembershipAcl } from '../helpers'
import { requestLocale } from '../i18n'
import { claimSection, pageClaims, releaseSection, sectionForClaim } from '../leases'
import { findVisiblePage } from '../pageDto'
import {
  acceptSuggestion,
  mySuggestions,
  pageSuggestions,
  rejectSuggestion,
  suggestionFor,
  withdrawSuggestion,
} from '../suggestions'

/**
 * Suggested edits and section claims (docs/adr/1530-* .. 1536-*).
 *
 *   GET    /pages/:id/suggestions?preview=1&status=  a page's suggestions (+ diffs) and live claims; status = open
 *                                             (default) | decided | all | one status; all=1 = the web history
 *                                             (everything but superseded), docs/adr/1626-*
 *   GET    /suggestions?status=                      the caller's own suggestions, same status filter (default open)
 *   GET    /suggestions/:id?preview=1                one suggestion
 *   POST   /suggestions/:id/accept {confirmChanged, hunks, mergeKey}  people only (browser or API token), edit access;
 *                                             hunks = apply only these hunks of a replace (docs/adr/1621-*)
 *   POST   /suggestions/:id/reject                   people only, edit access
 *   POST   /suggestions/:id/withdraw                 the author (agents too)
 *   POST   /pages/:id/claims {section, ttlSeconds}   claim a section for this connection
 *   DELETE /pages/:id/claims?section=                release it
 *
 * Suggestions are created by POST /pages/:id/section (suggest=true, or under an "agents: suggestions
 * only" lock) and POST /pages/:id/content (under that lock). Reading needs what reading the page
 * needs (visible page, membership with 2FA and agent blocks, the connection's range); guests are
 * not shown suggestions.
 */

const idsSchema = z.object({ id: z.uuid() })
const claimSchema = z
  .object({
    section: z.string().trim().min(1).max(500),
    ttlSeconds: z.number().int().min(30).max(CLAIM_TTL_MAX_S).optional(),
  })
  .strict()
const releaseQuery = z.object({ section: z.string().trim().min(1).max(500) })

async function guardPage(id: string, userId: string) {
  const page = await findVisiblePage(id, userId)
  if (!page) throw notFound()
  await requireMembership(page.workspaceId, userId)
  return page
}

export async function registerSuggestionRoutes(app: FastifyInstance): Promise<void> {
  app.get('/pages/:id/suggestions', { preHandler: requireUser }, async (req): Promise<PageSuggestionsDTO> => {
    const user = getUser(req)
    const page = await guardPage(idParam(req.params), user.id)
    const q = z
      .object({ preview: z.enum(['0', '1']).optional(), all: z.enum(['0', '1']).optional(), status: z.enum(SUGGESTION_STATUS_FILTERS).optional() })
      .parse(req.query)
    let canDecide = false
    if (!currentAgent()) {
      try {
        await assertPageEditable(page.id, user.id)
        canDecide = true
      } catch {
        canDecide = false
      }
    }
    return {
      suggestions: await pageSuggestions(page.id, user.id, { preview: q.preview === '1', all: q.all === '1', status: q.status }),
      claims: await pageClaims(page.id, user),
      canDecide,
    }
  })

  app.get('/suggestions', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const q = z.object({ status: z.enum(SUGGESTION_STATUS_FILTERS).optional() }).parse(req.query)
    return { suggestions: await mySuggestions(user, q.status ?? 'open') }
  })

  app.get('/suggestions/:id', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const { id } = idsSchema.parse(req.params)
    const q = z.object({ preview: z.enum(['0', '1']).optional() }).parse(req.query)
    return { suggestion: await suggestionFor(id, user, q.preview === '1') }
  })

  app.post(
    '/suggestions/:id/accept',
    { preHandler: requireUser, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req) => {
      const user = getUser(req)
      const { id } = idsSchema.parse(req.params)
      const body = acceptSuggestionSchema.parse(req.body ?? {})
      return { suggestion: await acceptSuggestion(id, user, body, () => requestLocale(req, user.id)) }
    },
  )

  app.post('/suggestions/:id/reject', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const { id } = idsSchema.parse(req.params)
    return { suggestion: await rejectSuggestion(id, user) }
  })

  app.post('/suggestions/:id/withdraw', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const { id } = idsSchema.parse(req.params)
    return { suggestion: await withdrawSuggestion(id, user) }
  })

  app.post('/pages/:id/claims', { preHandler: requireUser, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    const user = getUser(req)
    const page = await guardPage(idParam(req.params), user.id)
    const body = claimSchema.parse(req.body)
    if (page.kind !== 'doc') throw badRequest('Only document pages have sections')
    // Claiming is for a connection that may change the section (edit, or leave suggestions).
    const { role, acl } = await requireMembershipAcl(page.workspaceId, user.id)
    if (!(await suggestionRight(db, page.id, user.id, role, acl))) await assertPageEditable(page.id, user.id, { role, acl })
    const section = await sectionForClaim(page.id, body.section)
    return { claim: await claimSection(user, page, section, body.ttlSeconds ?? CLAIM_TTL_DEFAULT_S) }
  })

  app.delete('/pages/:id/claims', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const page = await guardPage(idParam(req.params), user.id)
    const { section } = releaseQuery.parse(req.query)
    // Release by the anchor or heading as given, else by the section it resolves to now.
    let released = await releaseSection(user, page.id, section)
    if (!released) {
      const s = await sectionForClaim(page.id, section).catch(() => null)
      if (s) released = await releaseSection(user, page.id, s.anchor)
    }
    return { released }
  })
}
