import type { FastifyInstance, FastifyRequest } from 'fastify'
import { createSamplePageSchema, updateOnboardingSchema } from '@inkling/shared'
import type { OnboardingDTO, SamplePageResultDTO } from '@inkling/shared'
import { getUser, requireUser } from '../auth'
import { AppError, forbidden } from '../errors'
import { requireMembership } from '../helpers'
import { requestLocale } from '../i18n'
import { applyUpdate, createSample, loadOnboarding, onboardingEnabled } from './state'

/**
 * Onboarding (docs/adr/2380-*, 2381-*):
 *
 *   GET   /api/me/onboarding          → OnboardingDTO (makes the person's row on the first call)
 *   PATCH /api/me/onboarding          { introSeen?, collapsed?, dismissed?, event? } → OnboardingDTO
 *   POST  /api/me/onboarding/sample   { workspaceId } → SamplePageResultDTO (the sample in the caller's
 *                                     private pages of that workspace; members only, not guests)
 *
 * Browser sessions only, like /me/sidebar (docs/adr/1020-*): how the web app greets a person is
 * nothing an agent reads or changes, so a bearer token gets 403. ONBOARDING=off: GET and PATCH answer
 * `enabled: false` and change nothing visible; POST is 404.
 */
async function requireSessionUser(req: FastifyRequest): Promise<void> {
  await requireUser(req)
  if (req.authVia !== 'cookie') throw forbidden('Onboarding is only available in the web app')
}

export async function registerOnboardingRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/me/onboarding',
    { preHandler: requireSessionUser, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (req): Promise<OnboardingDTO> => {
      const user = getUser(req)
      return loadOnboarding(user, () => requestLocale(req, user.id))
    },
  )

  app.patch(
    '/me/onboarding',
    { preHandler: requireSessionUser, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req): Promise<OnboardingDTO> => {
      const user = getUser(req)
      return applyUpdate(user, updateOnboardingSchema.parse(req.body))
    },
  )

  app.post(
    '/me/onboarding/sample',
    { preHandler: requireSessionUser, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req): Promise<SamplePageResultDTO> => {
      if (!onboardingEnabled()) throw new AppError(404, 'ONBOARDING_OFF', 'Onboarding is turned off on this server')
      const user = getUser(req)
      const body = createSamplePageSchema.parse(req.body)
      // Members only: a guest has no private pages of their own in someone else's workspace.
      const role = await requireMembership(body.workspaceId, user.id)
      const locale = await requestLocale(req, user.id)
      const r = await createSample({ userId: user.id, userName: user.name, workspaceId: body.workspaceId, role, locale })
      return { pageId: r.pageId, workspaceId: body.workspaceId, created: r.created }
    },
  )
}
