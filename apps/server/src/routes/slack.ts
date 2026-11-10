import { and, eq, sql } from 'drizzle-orm'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { SlackLinkDTO, SlackLinkPreviewDTO, SlackSettingsResponse, SlackTestResultDTO } from '@inkling/shared'
import { slackLinkCodeSchema, slackSettingsSchema } from '@inkling/shared'
import { getUser, requireUser } from '../auth'
import type { AuthUser } from '../auth'
import { db } from '../db/index'
import { slackIntegrations, slackLinkCodes, slackUserLinks, users, workspaces } from '../db/schema'
import { AppError, forbidden, notFound } from '../errors'
import { idParam, requireMembership } from '../helpers'
import { slackApi } from '../slack/api'
import type { AuthTest, ConversationInfo } from '../slack/api'
import { botTokenOf, eventsOf, invalidateSlackCache, loadIntegration, setupInfo, signingSecretOf, storeSlackSecret, toIntegrationDTO, tokenHint } from '../slack/config'
import { acceptSlackRequest, handleEventCallback, handleSlashCommand, hashLinkCode } from '../slack/inbound'
import { slackText } from '../slack/messages'
import { recordSlackError } from '../slack/notify'
import { signatureHeaders } from '../slack/signature'
import { resolveLocale } from '../i18n'
import { liveWorkspace } from '../workspaceLive'
import { recordAudit } from '../workspaceAdmin'

/**
 * Slack app of a workspace (docs/adr/1800-* .. 1806-*).
 *
 * Settings (session cookie, workspace owners, like webhooks — C-L12):
 *   GET    /workspaces/:id/slack                 setup values + the stored connection (no secrets)
 *   PUT    /workspaces/:id/slack                 save token / secret / channel / kinds (auth.test first)
 *   DELETE /workspaces/:id/slack                 disconnect (links go with it)
 *   POST   /workspaces/:id/slack/test            post a test message to the channel
 *   GET    /workspaces/:id/slack/links           linked Slack accounts
 *   DELETE /workspaces/:id/slack/links/:userId   remove one link
 * Linking (the person, signed in):
 *   POST   /slack/link/preview {code}            what a one-time code links
 *   POST   /slack/link/confirm {code}            link the Slack account to the signed-in member
 * From Slack (signed, no session; raw body kept for the signature):
 *   POST   /slack/w/:workspaceId/commands        /inkling (ephemeral answer)
 *   POST   /slack/w/:workspaceId/events          Events API (url_verification, link_shared, uninstall)
 *
 * Secrets: the token and the signing secret are accepted only in the PUT body, stored protected
 * (sealed with APP_SECRET_KEY when set) and never returned or logged; Slack errors are passed on as
 * Slack's error code only.
 */

const SLACK_BODY_LIMIT = 64 * 1024

async function requireSlackAdmin(workspaceId: string, user: AuthUser): Promise<void> {
  const role = await requireMembership(workspaceId, user.id)
  if (role !== 'owner') throw forbidden('Only workspace owners can manage the Slack app')
}

function requestOrigin(req: FastifyRequest): string {
  return `${req.protocol}://${req.host}`
}

const userParams = z.object({ id: z.uuid(), userId: z.uuid() })
const wsParams = z.object({ workspaceId: z.uuid() })

export async function registerSlackRoutes(app: FastifyInstance): Promise<void> {
  // ---- settings ------------------------------------------------------------
  app.get('/workspaces/:id/slack', { preHandler: requireUser }, async (req): Promise<SlackSettingsResponse> => {
    const user = getUser(req)
    const workspaceId = idParam(req.params)
    await requireSlackAdmin(workspaceId, user)
    const row = await loadIntegration(workspaceId)
    return { integration: row ? toIntegrationDTO(row) : null, setup: setupInfo(workspaceId, requestOrigin(req)) }
  })

  app.put('/workspaces/:id/slack', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const workspaceId = idParam(req.params)
    await requireSlackAdmin(workspaceId, user)
    const body = slackSettingsSchema.parse(req.body ?? {})
    const prev = await loadIntegration(workspaceId)
    if (!prev && (!body.botToken || !body.signingSecret)) {
      throw new AppError(400, 'SLACK_SECRETS_REQUIRED', 'The bot token and the signing secret are required')
    }
    // The token in use: the new one, else the stored one (it must still be readable).
    const token = body.botToken ?? (prev ? botTokenOf(prev) : null)
    if (!token) throw new AppError(400, 'SLACK_SECRETS_REQUIRED', 'The stored bot token cannot be decrypted (APP_SECRET_KEY missing or changed): enter it again')
    if (!body.signingSecret && prev) {
      // keep the stored secret, but only if it can still be used to verify requests
      if (signingSecretOf(prev) === null) throw new AppError(400, 'SLACK_SECRETS_REQUIRED', 'The stored signing secret cannot be decrypted: enter it again')
    }
    const auth = await slackApi<AuthTest>('auth.test', token, {})
    if (!auth.ok) throw new AppError(400, 'SLACK_AUTH_FAILED', 'Slack did not accept the bot token', undefined, { slackError: auth.error })
    const teamId = auth.data.team_id
    if (!teamId || !/^[TE][A-Z0-9]{2,30}$/.test(teamId)) throw new AppError(400, 'SLACK_AUTH_FAILED', 'Slack did not name the team of the token', undefined, { slackError: 'no_team' })
    // Channel name for the settings page; needs channels:read / groups:read, so a refusal is not an error.
    const ch = await slackApi<ConversationInfo>('conversations.info', token, { channel: body.channelId }, { timeoutMs: 3_000 })
    const channelName = ch.ok && typeof ch.data.channel?.name === 'string' ? ch.data.channel.name.slice(0, 80) : null
    const teamChanged = !!prev && prev.teamId !== teamId
    const values = {
      botToken: body.botToken ? storeSlackSecret('slack-bot-token', body.botToken, workspaceId) : prev!.botToken,
      botTokenHint: body.botToken ? tokenHint(body.botToken) : prev!.botTokenHint,
      signingSecret: body.signingSecret ? storeSlackSecret('slack-signing-secret', body.signingSecret, workspaceId) : prev!.signingSecret,
      teamId,
      teamName: typeof auth.data.team === 'string' ? auth.data.team.slice(0, 120) : null,
      botUserId: typeof auth.data.user_id === 'string' && /^[UW][A-Z0-9]{2,30}$/.test(auth.data.user_id) ? auth.data.user_id : null,
      channelId: body.channelId,
      channelName,
      events: body.events,
      enabled: body.enabled ? ('1' as const) : ('0' as const),
      // a save is the admin's "try again": paused posts resume
      blockedReason: null,
      updatedAt: new Date(),
    }
    const row = await db.transaction(async (tx) => {
      const [r] = await tx
        .insert(slackIntegrations)
        .values({ workspaceId, createdBy: user.id, ...values })
        .onConflictDoUpdate({ target: slackIntegrations.workspaceId, set: values })
        .returning()
      // Links belong to a Slack team: another team's links mean nothing any more.
      if (teamChanged) await tx.delete(slackUserLinks).where(eq(slackUserLinks.workspaceId, workspaceId))
      await recordAudit(tx, {
        workspaceId,
        actor: { id: user.id, name: user.name, via: user.via ?? null },
        action: 'settings.updated',
        target: { type: 'slack', id: workspaceId, label: 'Slack' },
        before: prev ? { channelId: prev.channelId, events: eventsOf(prev.events), enabled: prev.enabled === '1', teamId: prev.teamId } : null,
        // never the token or the secret, only whether they changed
        after: { channelId: body.channelId, events: body.events, enabled: body.enabled, teamId, botTokenChanged: !!body.botToken, signingSecretChanged: !!body.signingSecret },
      })
      return r
    })
    invalidateSlackCache(workspaceId)
    return { integration: toIntegrationDTO(row) }
  })

  app.delete('/workspaces/:id/slack', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const workspaceId = idParam(req.params)
    await requireSlackAdmin(workspaceId, user)
    await db.transaction(async (tx) => {
      const gone = await tx.delete(slackIntegrations).where(eq(slackIntegrations.workspaceId, workspaceId)).returning({ id: slackIntegrations.workspaceId })
      await tx.delete(slackUserLinks).where(eq(slackUserLinks.workspaceId, workspaceId))
      await tx.delete(slackLinkCodes).where(eq(slackLinkCodes.workspaceId, workspaceId))
      // queued posts and unfurls would only be skipped at delivery: drop them now
      await tx.execute(sql`DELETE FROM outbox WHERE topic = 'slack' AND state = 'pending' AND workspace_id = ${workspaceId}`)
      if (gone.length) {
        await recordAudit(tx, {
          workspaceId,
          actor: { id: user.id, name: user.name, via: user.via ?? null },
          action: 'settings.updated',
          target: { type: 'slack', id: workspaceId, label: 'Slack' },
          before: { connected: true },
          after: { connected: false },
        })
      }
    })
    invalidateSlackCache(workspaceId)
    return { ok: true }
  })

  app.post('/workspaces/:id/slack/test', { preHandler: requireUser }, async (req): Promise<SlackTestResultDTO> => {
    const user = getUser(req)
    const workspaceId = idParam(req.params)
    await requireSlackAdmin(workspaceId, user)
    const row = await loadIntegration(workspaceId)
    if (!row) throw notFound()
    const token = botTokenOf(row)
    if (!token) {
      await recordSlackError(workspaceId, 'secret_unreadable', true)
      return { ok: false, error: 'secret_unreadable' }
    }
    const [ws] = await db.select({ name: workspaces.name }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)
    const t = slackText(resolveLocale(null))
    const res = await slackApi('chat.postMessage', token, {
      channel: row.channelId,
      text: t.test((ws?.name ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')),
      unfurl_links: false,
      unfurl_media: false,
    })
    if (res.ok) {
      await db
        .update(slackIntegrations)
        .set({ blockedReason: null, lastSuccessAt: new Date() })
        .where(eq(slackIntegrations.workspaceId, workspaceId))
      invalidateSlackCache(workspaceId)
      return { ok: true, error: null }
    }
    await recordSlackError(workspaceId, res.error, false)
    return { ok: false, error: res.error }
  })

  app.get('/workspaces/:id/slack/links', { preHandler: requireUser }, async (req): Promise<{ links: SlackLinkDTO[] }> => {
    const user = getUser(req)
    const workspaceId = idParam(req.params)
    await requireSlackAdmin(workspaceId, user)
    const rows = await db
      .select({ userId: slackUserLinks.userId, name: users.name, slackUserId: slackUserLinks.slackUserId, method: slackUserLinks.method, createdAt: slackUserLinks.createdAt })
      .from(slackUserLinks)
      .innerJoin(users, eq(users.id, slackUserLinks.userId))
      .where(eq(slackUserLinks.workspaceId, workspaceId))
      .orderBy(users.name)
    return { links: rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })) }
  })

  app.delete('/workspaces/:id/slack/links/:userId', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const { id: workspaceId, userId } = userParams.parse(req.params)
    await requireSlackAdmin(workspaceId, user)
    await db.delete(slackUserLinks).where(and(eq(slackUserLinks.workspaceId, workspaceId), eq(slackUserLinks.userId, userId)))
    return { ok: true }
  })

  // ---- linking (the person) ------------------------------------------------
  async function liveCode(code: string) {
    const [c] = await db
      .select({ workspaceId: slackLinkCodes.workspaceId, teamId: slackLinkCodes.teamId, slackUserId: slackLinkCodes.slackUserId, expiresAt: slackLinkCodes.expiresAt })
      .from(slackLinkCodes)
      .where(and(eq(slackLinkCodes.codeHash, hashLinkCode(code)), sql`${slackLinkCodes.expiresAt} > now()`, liveWorkspace(slackLinkCodes.workspaceId)))
      .limit(1)
    if (!c) throw notFound()
    const integ = await loadIntegration(c.workspaceId)
    // the code's team must still be the team of the connection
    if (!integ || integ.teamId !== c.teamId) throw notFound()
    return { ...c, integ }
  }

  app.post('/slack/link/preview', { preHandler: requireUser }, async (req): Promise<SlackLinkPreviewDTO> => {
    const user = getUser(req)
    const { code } = slackLinkCodeSchema.parse(req.body ?? {})
    const c = await liveCode(code)
    await requireMembership(c.workspaceId, user.id)
    const [ws] = await db.select({ name: workspaces.name }).from(workspaces).where(eq(workspaces.id, c.workspaceId)).limit(1)
    return { workspaceId: c.workspaceId, workspaceName: ws?.name ?? '', teamName: c.integ.teamName, slackUserId: c.slackUserId, expiresAt: c.expiresAt.toISOString() }
  })

  app.post('/slack/link/confirm', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const { code } = slackLinkCodeSchema.parse(req.body ?? {})
    const c = await liveCode(code)
    await requireMembership(c.workspaceId, user.id)
    await db.transaction(async (tx) => {
      // single use: the code is gone whether or not the rest succeeds
      const used = await tx.delete(slackLinkCodes).where(eq(slackLinkCodes.codeHash, hashLinkCode(code))).returning({ h: slackLinkCodes.codeHash })
      if (!used.length) throw notFound()
      // one Slack account per member and one member per Slack account, per workspace
      await tx
        .delete(slackUserLinks)
        .where(
          and(
            eq(slackUserLinks.workspaceId, c.workspaceId),
            sql`(${slackUserLinks.userId} = ${user.id} OR (${slackUserLinks.teamId} = ${c.teamId} AND ${slackUserLinks.slackUserId} = ${c.slackUserId}))`,
          ),
        )
      await tx.insert(slackUserLinks).values({ workspaceId: c.workspaceId, teamId: c.teamId, slackUserId: c.slackUserId, userId: user.id, method: 'link' })
    })
    return { ok: true, workspaceId: c.workspaceId }
  })

  // ---- from Slack ----------------------------------------------------------
  await app.register(async (s) => {
    // Raw bodies: the signature covers the exact bytes Slack sent (both content types Slack uses).
    s.removeAllContentTypeParsers()
    s.addContentTypeParser(['application/x-www-form-urlencoded', 'application/json'], { parseAs: 'string', bodyLimit: SLACK_BODY_LIMIT }, (_req, body, done) => {
      done(null, body)
    })

    s.post('/slack/w/:workspaceId/commands', { bodyLimit: SLACK_BODY_LIMIT }, async (req, reply) => {
      const p = wsParams.safeParse(req.params)
      if (!p.success) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Not found' } })
      const raw = typeof req.body === 'string' ? req.body : ''
      const form = Object.fromEntries(new URLSearchParams(raw)) as Record<string, string>
      const { timestamp, signature } = signatureHeaders(req.headers)
      // Slack's periodic certificate check is signed but names no team.
      const sslCheck = form.ssl_check === '1'
      const team = sslCheck ? (await loadIntegration(p.data.workspaceId))?.teamId : form.team_id
      const ok = await acceptSlackRequest(p.data.workspaceId, timestamp, signature, raw, team)
      if (!ok.ok) return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid Slack request' } })
      if (sslCheck) return reply.send({ ok: true })
      return reply.send(await handleSlashCommand(ok.integ, form, requestOrigin(req)))
    })

    s.post('/slack/w/:workspaceId/events', { bodyLimit: SLACK_BODY_LIMIT }, async (req, reply) => {
      const p = wsParams.safeParse(req.params)
      if (!p.success) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Not found' } })
      const raw = typeof req.body === 'string' ? req.body : ''
      let body: Record<string, unknown>
      try {
        body = JSON.parse(raw) as Record<string, unknown>
      } catch {
        return reply.code(400).send({ error: { code: 'BAD_REQUEST', message: 'Invalid request' } })
      }
      const { timestamp, signature } = signatureHeaders(req.headers)
      if (body.type === 'url_verification') {
        const challenge = typeof body.challenge === 'string' ? body.challenge.slice(0, 200) : ''
        const integ = await loadIntegration(p.data.workspaceId)
        if (!integ) {
          // Creating the app from the manifest verifies this URL before the operator has a token or a
          // secret to save: echo the caller's own challenge for a live workspace (nothing is revealed,
          // nothing is done). Once connected, the handshake must be signed.
          const [w] = await db.select({ id: workspaces.id }).from(workspaces).where(and(eq(workspaces.id, p.data.workspaceId), sql`${workspaces.deletedAt} is null`)).limit(1)
          if (!w) return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid Slack request' } })
          return reply.send({ challenge })
        }
        // Slack's handshake carries no team: check the signature only (still once per signature).
        const ok = await acceptSlackRequest(p.data.workspaceId, timestamp, signature, raw, integ.teamId)
        if (!ok.ok) return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid Slack request' } })
        return reply.send({ challenge })
      }
      const ok = await acceptSlackRequest(p.data.workspaceId, timestamp, signature, raw, typeof body.team_id === 'string' ? body.team_id : undefined)
      if (!ok.ok) return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid Slack request' } })
      if (body.type === 'event_callback') {
        try {
          await handleEventCallback(ok.integ, body, requestOrigin(req))
        } catch (err) {
          req.log.warn(`[slack] event failed: ${String(err instanceof Error ? err.message : err).slice(0, 200)}`)
        }
      }
      // Slack wants a 2xx within 3 s; unfurls are answered later through the outbox.
      return reply.send({ ok: true })
    })
  })
}

