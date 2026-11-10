/**
 * Form views (docs/adr/1820-*, 1821-*, 1822-*).
 *
 * Members (session or token):
 *   GET    /collection-views/:id/form-link   link status (the token is shown to members, like a page share)
 *   POST   /collection-views/:id/form-link   turn the public link on (owners and admins; idempotent)
 *   DELETE /collection-views/:id/form-link   turn it off (owners, admins and anyone who can edit the collection)
 * Members fill a form in the app through POST /pages/:id/collection/rows (rowTemplates.ts createRow).
 *
 * Anyone with the link (no session):
 *   GET  /public/forms/:token   the questions: title, help texts, the asked properties' names, types
 *                               and options. Never a row, a count, a person or a linked row.
 *   POST /public/forms/:token   one answer → one row through createRow (the same path as "New row":
 *                               change feed, catch_up, webhooks, assignments), made as the member who
 *                               published the link, via "public form". The answer is { ok: true }.
 *
 * Abuse limits on POST: a per-IP route limit, a per-form hourly cap, a body size cap, the strict
 * schema (only `values` and the honeypot), and a honeypot field whose filled-in submissions are
 * answered like a success and dropped. No external CAPTCHA (self-hosted, no third party).
 *
 * A link answers 404 (as a token that never existed) when the view is gone or no longer a form, the
 * collection is trashed or private, the workspace is deleted or has public links turned off, or the
 * publishing member left or can no longer edit the collection. Nothing in that answer says which.
 */
import { randomBytes } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import {
  FORM_HONEYPOT_FIELD,
  FORM_LIMITS,
  formFields,
  formSettingsSchema,
  formSubmissionProps,
  publicFormSubmitSchema,
} from '@inkling/shared'
import type { CollectionField, FormLinkDTO, FormSettings, PublicFormDTO, PublicFormFieldDTO, WorkspaceRole } from '@inkling/shared'
import { getUser, requireUser } from '../auth'
import { db } from '../db/index'
import { collectionFormLinks, collections, collectionViews, pages, users, workspaceMembers, workspaces } from '../db/schema'
import { AppError, badRequest, forbidden, notFound } from '../errors'
import { recordFailure } from '../guard'
import { idParam, requireMembership } from '../helpers'
import { assertPageEditable } from '../editLock'
import { findVisiblePage } from '../pageDto'
import { createRow } from '../rowTemplates'
import { hashShareToken, protectSecret, tryRevealSecret } from '../secretsAtRest'
import { lockSharePolicy } from '../shareSettings'
import { isManagerRole, recordAudit } from '../workspaceAdmin'
import { liveWorkspace } from '../workspaceLive'
import { requestLocale } from '../i18n'

/** Visitors' reads: as gentle as the other public routes. */
const FORM_READ_LIMIT = { rateLimit: { max: 60, timeWindow: '1 minute' } }
/** Visitors' answers per IP. */
export const FORM_SUBMIT_PER_MINUTE = 10
/** Answers one form takes per hour, whatever their source (a distributed flood fills nothing more). */
export const FORM_SUBMIT_PER_FORM_HOUR = 300
/** `via` of rows made through a public form (change feed, catch_up: "Alice via public form"). */
export const PUBLIC_FORM_VIA = 'public form'

const tokenParam = z.object({ token: z.string().min(1).max(128) })

const formClosed = () => notFound()

function tokenAad(viewId: string): string {
  return `form:${viewId}`
}

// ---------------------------------------------------------------------------
// per-form hourly cap (in memory, per process)
// ---------------------------------------------------------------------------

const perForm = new Map<string, number[]>()

/** Record one answer for a form; false when the form took its hourly share already. */
export function takeFormSlot(viewId: string, now = Date.now()): boolean {
  const since = now - 3_600_000
  const list = (perForm.get(viewId) ?? []).filter((t) => t > since)
  if (list.length >= FORM_SUBMIT_PER_FORM_HOUR) {
    perForm.set(viewId, list)
    return false
  }
  list.push(now)
  perForm.delete(viewId)
  perForm.set(viewId, list)
  // bounded: the oldest forms are forgotten first
  while (perForm.size > 5000) {
    const k = perForm.keys().next().value
    if (k === undefined) break
    perForm.delete(k)
  }
  return true
}

/** Tests: forget the per-form counters. */
export function resetFormSlots(): void {
  perForm.clear()
}

// ---------------------------------------------------------------------------
// lookups
// ---------------------------------------------------------------------------

interface OpenForm {
  viewId: string
  viewName: string
  settings: FormSettings | undefined
  collection: Awaited<ReturnType<typeof findVisiblePage>> & object
  fields: CollectionField[]
  publisher: { id: string; name: string; role: WorkspaceRole }
}

/**
 * The form behind a public token, when it still takes answers (see the header for every case that
 * closes it). Throws the 404 every closed or unknown link gets.
 */
async function openFormByToken(req: FastifyRequest, token: string): Promise<OpenForm> {
  const [link] = await db
    .select({
      viewId: collectionFormLinks.viewId,
      publishedBy: collectionFormLinks.publishedBy,
      type: collectionViews.type,
      name: collectionViews.name,
      config: collectionViews.config,
      pageId: collectionViews.pageId,
    })
    .from(collectionFormLinks)
    .innerJoin(collectionViews, eq(collectionViews.id, collectionFormLinks.viewId))
    .where(eq(collectionFormLinks.tokenHash, hashShareToken(token)))
    .limit(1)
  if (!link) {
    // token guesses count as failures (repeated ones ban the IP for a while), as for page links
    await recordFailure(req, 'form-token')
    throw formClosed()
  }
  if (link.type !== 'form' || !link.publishedBy) throw formClosed()
  const [ws] = await db
    .select({ workspaceId: pages.workspaceId })
    .from(pages)
    .where(and(eq(pages.id, link.pageId), liveWorkspace(pages.workspaceId)))
    .limit(1)
  if (!ws) throw formClosed()
  // the publisher still a member who sees the (live, shared) collection
  const [member] = await db
    .select({ role: workspaceMembers.role, name: users.name })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(and(eq(workspaceMembers.workspaceId, ws.workspaceId), eq(workspaceMembers.userId, link.publishedBy)))
    .limit(1)
  if (!member) throw formClosed()
  const collection = await findVisiblePage(link.pageId, link.publishedBy)
  if (!collection || collection.kind !== 'collection' || collection.scope !== 'shared') throw formClosed()
  // public links turned off in the workspace close every form too
  const [wsRow] = await db.select({ off: workspaces.publicSharingDisabled }).from(workspaces).where(eq(workspaces.id, ws.workspaceId)).limit(1)
  if (!wsRow || wsRow.off) throw formClosed()
  const [def] = await db.select({ fields: collections.fields }).from(collections).where(eq(collections.pageId, link.pageId)).limit(1)
  const parsed = formSettingsSchema.safeParse((link.config as { form?: unknown } | null)?.form)
  return {
    viewId: link.viewId,
    viewName: link.name,
    settings: parsed.success ? parsed.data : undefined,
    collection,
    fields: (def?.fields ?? []) as CollectionField[],
    publisher: { id: link.publishedBy, name: member.name, role: member.role as WorkspaceRole },
  }
}

/** A form view the member can see (404 otherwise), with its collection. */
async function requireFormView(viewId: string, userId: string) {
  const [view] = await db
    .select({ id: collectionViews.id, pageId: collectionViews.pageId, type: collectionViews.type, name: collectionViews.name })
    .from(collectionViews)
    .where(eq(collectionViews.id, viewId))
    .limit(1)
  if (!view) throw notFound()
  const page = await findVisiblePage(view.pageId, userId)
  if (!page) throw notFound()
  const role = await requireMembership(page.workspaceId, userId)
  if (view.type !== 'form') throw badRequest('Only a form view has a public link')
  return { view, page, role }
}

async function generateFormToken(): Promise<string> {
  for (let i = 0; i < 5; i++) {
    const token = randomBytes(16).toString('base64url')
    const [clash] = await db
      .select({ v: collectionFormLinks.viewId })
      .from(collectionFormLinks)
      .where(eq(collectionFormLinks.tokenHash, hashShareToken(token)))
      .limit(1)
    if (!clash) return token
  }
  return randomBytes(16).toString('base64url')
}

/** The public form's questions (no row data of any kind). */
export function publicFormDTO(form: Pick<OpenForm, 'viewName' | 'settings' | 'fields'>): PublicFormDTO {
  const fields: PublicFormFieldDTO[] = formFields(form.settings, form.fields, { public: true }).map((q) => ({
    key: q.fieldId,
    name: q.field ? q.field.name : 'Title',
    type: q.field ? q.field.type : 'title',
    required: q.required,
    description: q.description,
    ...(q.field && (q.field.type === 'select' || q.field.type === 'multiSelect')
      ? { options: (q.field.options ?? []).map((o) => ({ id: o.id, name: o.name, color: o.color })) }
      : {}),
  }))
  return {
    title: form.settings?.title?.trim() || form.viewName,
    description: form.settings?.description ?? '',
    submitLabel: form.settings?.submitLabel?.trim() || null,
    successMessage: form.settings?.successMessage?.trim() || null,
    fields,
    honeypot: FORM_HONEYPOT_FIELD,
  }
}

export async function registerFormRoutes(app: FastifyInstance): Promise<void> {
  // ---- members: the public link ------------------------------------------------
  app.get('/collection-views/:id/form-link', { preHandler: requireUser }, async (req): Promise<FormLinkDTO> => {
    const user = getUser(req)
    const { view, role } = await requireFormView(idParam(req.params), user.id)
    const [link] = await db.select().from(collectionFormLinks).where(eq(collectionFormLinks.viewId, view.id)).limit(1)
    const token = link ? tryRevealSecret('share-token', link.tokenEnc, tokenAad(view.id)) : null
    return { shared: !!token, token, canPublish: isManagerRole(role) }
  })

  app.post('/collection-views/:id/form-link', { preHandler: requireUser }, async (req): Promise<FormLinkDTO> => {
    const user = getUser(req)
    const { view, page, role } = await requireFormView(idParam(req.params), user.id)
    if (!isManagerRole(role)) throw forbidden('Only owners and admins can publish a form')
    if (page.scope === 'private') throw badRequest("A private collection's form can't be public")
    // the publisher's rights decide what the form may do (submissions are made as them)
    await assertPageEditable(page.id, user.id)
    const token = await db.transaction(async (tx) => {
      const policy = await lockSharePolicy(tx, page.workspaceId)
      const [cur] = await tx
        .select()
        .from(collectionFormLinks)
        .where(eq(collectionFormLinks.viewId, view.id))
        .for('update')
        .limit(1)
      const existing = cur ? tryRevealSecret('share-token', cur.tokenEnc, tokenAad(view.id)) : null
      if (existing) return existing
      if (policy.publicSharingDisabled) {
        throw new AppError(403, 'PUBLIC_SHARING_DISABLED', 'Public web links are turned off in this workspace')
      }
      const fresh = await generateFormToken()
      const values = {
        tokenHash: hashShareToken(fresh),
        tokenEnc: protectSecret('share-token', fresh, tokenAad(view.id)),
        publishedBy: user.id,
        createdAt: new Date(),
      }
      if (cur) await tx.update(collectionFormLinks).set(values).where(eq(collectionFormLinks.viewId, view.id))
      else await tx.insert(collectionFormLinks).values({ viewId: view.id, ...values })
      await recordAudit(tx, {
        workspaceId: page.workspaceId,
        actor: user,
        action: 'form.published',
        target: { type: 'page', id: page.id, label: `${page.title} / ${view.name}` },
      })
      return fresh
    })
    return { shared: true, token, canPublish: true }
  })

  app.delete('/collection-views/:id/form-link', { preHandler: requireUser }, async (req): Promise<FormLinkDTO> => {
    const user = getUser(req)
    const { view, page, role } = await requireFormView(idParam(req.params), user.id)
    // turning a link off is always safe: managers, and anyone who can edit the collection
    if (!isManagerRole(role)) await assertPageEditable(page.id, user.id)
    await db.transaction(async (tx) => {
      const gone = await tx.delete(collectionFormLinks).where(eq(collectionFormLinks.viewId, view.id)).returning({ v: collectionFormLinks.viewId })
      if (gone.length) {
        await recordAudit(tx, {
          workspaceId: page.workspaceId,
          actor: user,
          action: 'form.unpublished',
          target: { type: 'page', id: page.id, label: `${page.title} / ${view.name}` },
        })
      }
    })
    return { shared: false, token: null, canPublish: isManagerRole(role) }
  })

  // ---- visitors ------------------------------------------------------------------
  app.get('/public/forms/:token', { config: FORM_READ_LIMIT }, async (req, reply): Promise<PublicFormDTO> => {
    const { token } = tokenParam.parse(req.params)
    reply.header('Cache-Control', 'no-store')
    reply.header('X-Robots-Tag', 'noindex, nofollow')
    reply.header('Referrer-Policy', 'no-referrer')
    const form = await openFormByToken(req, token)
    return publicFormDTO(form)
  })

  app.post(
    '/public/forms/:token',
    {
      config: { rateLimit: { max: FORM_SUBMIT_PER_MINUTE, timeWindow: '1 minute' } },
      bodyLimit: FORM_LIMITS.bodyBytes,
    },
    async (req, reply) => {
      const { token } = tokenParam.parse(req.params)
      reply.header('Cache-Control', 'no-store')
      reply.header('X-Robots-Tag', 'noindex, nofollow')
      const parsed = publicFormSubmitSchema.safeParse(req.body ?? {})
      if (!parsed.success) throw new AppError(400, 'FORM_INVALID', 'The answer could not be read')
      const form = await openFormByToken(req, token)
      // honeypot: answered like a success, nothing is written (a bot learns nothing)
      if ((parsed.data[FORM_HONEYPOT_FIELD] ?? '').trim() !== '') return { ok: true }
      const conv = formSubmissionProps(form.settings, form.fields, parsed.data.values, { public: true })
      if (Object.keys(conv.problems).length) {
        throw new AppError(400, 'FORM_INVALID', 'Some answers are missing or not valid', undefined, { fields: conv.problems })
      }
      if (!takeFormSlot(form.viewId)) {
        throw new AppError(429, 'RATE_LIMITED', 'This form has received too many answers; try again later', undefined, undefined)
      }
      try {
        await createRow({
          collection: form.collection,
          user: { id: form.publisher.id, name: form.publisher.name, via: PUBLIC_FORM_VIA },
          role: form.publisher.role,
          // a public answer is exactly what the visitor typed: no row template
          template: null,
          title: conv.title,
          props: conv.props,
          locale: await requestLocale(req, null),
        })
      } catch (err) {
        // the publisher lost the right to add rows (lock, role): the form is closed, nothing more
        if (err instanceof AppError && (err.status === 403 || err.status === 404)) throw formClosed()
        throw err
      }
      return { ok: true }
    },
  )
}
