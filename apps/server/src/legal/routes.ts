import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { requireUser } from '../auth'
import { db } from '../db/index'
import { env } from '../env'
import { forbidden, notFound } from '../errors'
import { headerLocale, normalizeLocale } from '../i18n'
import { SESSION_ONLY_MESSAGE } from '../tokenPolicy'
import { pick, pickedLocale, type LegalBundle, type LegalLocale } from './bundle'
import { activeLegal, checkConsents, forgetConsent, recordConsents } from './consent'

/**
 * Public routes of LEGAL_DIR (docs/adr/2519-*), all under /api/legal (exempt from the request gates,
 * so a person who has not agreed yet can read the documents and agree):
 *   GET  /api/legal                  the notice and the tick boxes, in one language
 *   GET  /api/legal/:doc             terms or privacy as Markdown, with the version
 *   POST /api/legal/consent          the signed-in person agrees to the current version (browser only)
 * Registered only when LEGAL_DIR is set; without it these paths are 404 like any unknown route.
 */

export interface LegalItemDTO {
  id: string
  required: boolean
  label: string
  doc?: 'terms' | 'privacy'
  /** Markdown (a table of what is collected, for example). */
  details?: string
}

export interface LegalDTO {
  version: string
  notice: string | null
  items: LegalItemDTO[]
}

export interface LegalDocDTO {
  doc: 'terms' | 'privacy'
  version: string
  /** The language of `markdown` (the other one when the folder has only one). */
  locale: LegalLocale
  markdown: string
}

const localeQuery = z.object({ locale: z.string().max(16).optional() }).loose()
const docParams = z.object({ doc: z.enum(['terms', 'privacy']) })
const consentBody = z.object({
  consents: z.array(z.string().min(1).max(64)).max(32),
  legalVersion: z.string().min(1).max(64),
})

function localeOf(req: FastifyRequest): LegalLocale {
  const q = localeQuery.safeParse(req.query)
  return normalizeLocale(q.success ? q.data.locale : undefined) ?? headerLocale(req) ?? env.defaultLocale
}

export function legalDTO(b: LegalBundle, locale: LegalLocale): LegalDTO {
  return {
    version: b.version,
    notice: b.notice ? pick(b.notice, locale) : null,
    items: b.items.map((i) => ({
      id: i.id,
      required: i.required,
      label: pick(i.label, locale),
      ...(i.doc ? { doc: i.doc } : {}),
      ...(i.details ? { details: pick(i.details, locale) } : {}),
    })),
  }
}

const noStore = { 'Cache-Control': 'no-store' }

export async function registerLegalRoutes(api: FastifyInstance): Promise<void> {
  api.get('/legal', async (req, reply): Promise<LegalDTO> => {
    const b = activeLegal()
    if (!b) throw notFound()
    reply.headers(noStore)
    return legalDTO(b, localeOf(req))
  })

  api.get('/legal/:doc', async (req, reply): Promise<LegalDocDTO> => {
    const b = activeLegal()
    const parsed = docParams.safeParse(req.params)
    // Served from what was read at boot, never from a path built out of the request.
    const text = b && parsed.success ? b.docs[parsed.data.doc] : undefined
    if (!b || !parsed.success || !text) throw notFound('NOT_FOUND', 'No such document on this server')
    const locale = pickedLocale(text, localeOf(req))
    reply.headers(noStore)
    return { doc: parsed.data.doc, version: b.version, locale, markdown: pick(text, locale) }
  })

  api.post(
    '/legal/consent',
    { preHandler: requireUser, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req): Promise<{ ok: true; version: string }> => {
      const b = activeLegal()
      if (!b) throw notFound()
      // A person agrees in the browser: an API token or an agent connection cannot agree for them
      // (the whole /api/legal prefix is exempt from the gates, bearer requests included).
      if (req.authVia !== 'cookie') throw forbidden(SESSION_ONLY_MESSAGE)
      const body = consentBody.parse(req.body)
      const ids = checkConsents(b, body.consents, body.legalVersion)
      const userId = req.user!.id
      await db.transaction((tx) => recordConsents(tx, userId, ids, b.version, req.ip))
      forgetConsent(userId)
      return { ok: true, version: b.version }
    },
  )
}
