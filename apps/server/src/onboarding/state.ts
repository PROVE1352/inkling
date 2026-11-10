import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import {
  ONBOARDING_CLIENT_EVENTS,
  ONBOARDING_ITEMS,
  ONBOARDING_ITEMS_BY_AUDIENCE,
  ONBOARDING_OPTIONAL_ITEMS,
} from '@inkling/shared'
import type {
  OnboardingAudience,
  OnboardingClientEvent,
  OnboardingDTO,
  OnboardingItemId,
  UpdateOnboardingInput,
} from '@inkling/shared'
import { db } from '../db/index'
import { conflict } from '../errors'
import { pages, userOnboarding, workspaceMembers, workspaces } from '../db/schema'
import type { Locale } from '../i18n'
import { compileSpec } from '../templates/builtins'
import { instantiateTree } from '../templates/structure'
import { wallClock } from '../templates/variables'
import { sampleSpec, sampleTitle } from './sample'

/**
 * Onboarding state per person (docs/adr/2380-*).
 *
 * The row is created the first time the web app asks (GET /api/me/onboarding). No row before that
 * means the account was made after migration 0060, which gave every older account `{legacy: true}`:
 * that is the whole "new account" test, so an upgrade never shows the intro or the checklist to
 * people who already use the app.
 *
 * Checklist items are derived from what the server already stores (pages, databases, links,
 * comments, shares, agent connections) whenever the card is still open, and from a few browser-only
 * events. An item stays done once it was seen done (`done` is sticky), so deleting a page does not
 * take a tick back. The sample pages' own ids are left out of every fact, or the sample would tick
 * "page", "link" and "database" by itself.
 */

export interface SampleRecord {
  /** Root page id. */
  root: string
  /** Every page the sample made (root, children, database rows). */
  ids: string[]
  at: string
  auto?: boolean
}

export interface OnboardingState {
  legacy?: boolean
  /** The row was made while ONBOARDING=off: treated as an existing account if it is turned on later. */
  off?: boolean
  introSeenAt?: string
  dismissed?: boolean
  /** Turned back on in Settings: shown even when every item is done. */
  reopened?: boolean
  collapsed?: boolean
  done?: Partial<Record<OnboardingItemId, string>>
  /** By workspace id. */
  samples?: Record<string, SampleRecord>
  /** The first admin's automatic sample: being made, made, failed, or not this account. Set once. */
  autoSample?: 'pending' | 'created' | 'failed' | 'none'
  /** Sample pages being made, by workspace id (start time): a second click waits for the first. */
  creating?: Record<string, string>
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ITEM_SET = new Set<string>(ONBOARDING_ITEMS)
const EVENT_SET = new Set<string>(ONBOARDING_CLIENT_EVENTS)

/** ONBOARDING=off (or 0/false/no) turns the whole thing off for this server. Read per call (tests switch it). */
export function onboardingEnabled(): boolean {
  const v = (process.env.ONBOARDING ?? '').trim().toLowerCase()
  return !(v === 'off' || v === '0' || v === 'false' || v === 'no')
}

/** Reads a stored jsonb defensively (a hand-edited row must not break the app). */
export function parseState(raw: unknown): OnboardingState {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const r = raw as Record<string, unknown>
  const out: OnboardingState = {}
  if (r.legacy === true) out.legacy = true
  if (r.off === true) out.off = true
  if (typeof r.introSeenAt === 'string') out.introSeenAt = r.introSeenAt
  if (typeof r.dismissed === 'boolean') out.dismissed = r.dismissed
  if (r.reopened === true) out.reopened = true
  if (typeof r.collapsed === 'boolean') out.collapsed = r.collapsed
  if (r.done && typeof r.done === 'object') {
    const done: Partial<Record<OnboardingItemId, string>> = {}
    for (const [k, v] of Object.entries(r.done as Record<string, unknown>)) {
      if (ITEM_SET.has(k) && typeof v === 'string') done[k as OnboardingItemId] = v
    }
    out.done = done
  }
  if (r.samples && typeof r.samples === 'object') {
    const samples: Record<string, SampleRecord> = {}
    for (const [ws, v] of Object.entries(r.samples as Record<string, unknown>)) {
      const s = v as Partial<SampleRecord> | null
      if (!UUID_RE.test(ws) || !s || typeof s.root !== 'string' || !UUID_RE.test(s.root)) continue
      const ids = Array.isArray(s.ids) ? s.ids.filter((x): x is string => typeof x === 'string' && UUID_RE.test(x)) : []
      samples[ws] = { root: s.root, ids: ids.includes(s.root) ? ids : [s.root, ...ids], at: typeof s.at === 'string' ? s.at : '', ...(s.auto ? { auto: true } : {}) }
    }
    out.samples = samples
  }
  if (r.autoSample === 'pending' || r.autoSample === 'created' || r.autoSample === 'failed' || r.autoSample === 'none') out.autoSample = r.autoSample
  if (r.creating && typeof r.creating === 'object') {
    const creating: Record<string, string> = {}
    for (const [ws, v] of Object.entries(r.creating as Record<string, unknown>)) if (UUID_RE.test(ws) && typeof v === 'string') creating[ws] = v
    out.creating = creating
  }
  return out
}

/** The row, made on first call. `fresh` = this call made it (the account's first onboarding read). */
export async function claimState(userId: string): Promise<{ state: OnboardingState; fresh: boolean }> {
  const initial: OnboardingState = onboardingEnabled() ? {} : { off: true }
  const made = await db
    .insert(userOnboarding)
    .values({ userId, state: initial })
    .onConflictDoNothing()
    .returning({ state: userOnboarding.state })
  if (made.length > 0) return { state: parseState(made[0].state), fresh: true }
  const [row] = await db.select({ state: userOnboarding.state }).from(userOnboarding).where(eq(userOnboarding.userId, userId)).limit(1)
  return { state: parseState(row?.state), fresh: false }
}

/**
 * Read-modify-write under a row lock, so two tabs (an event and a dismiss at once) do not lose a
 * field. The row exists by then (claimState ran first in every route).
 */
export async function updateState(userId: string, fn: (s: OnboardingState) => OnboardingState | null): Promise<OnboardingState> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ state: userOnboarding.state })
      .from(userOnboarding)
      .where(eq(userOnboarding.userId, userId))
      .for('update')
      .limit(1)
    const cur = parseState(row?.state)
    const next = fn(cur)
    if (!next) return cur
    if (row) await tx.update(userOnboarding).set({ state: next, updatedAt: new Date() }).where(eq(userOnboarding.userId, userId))
    else await tx.insert(userOnboarding).values({ userId, state: next }).onConflictDoNothing()
    return next
  })
}

// ---------------------------------------------------------------------------
// audience and facts
// ---------------------------------------------------------------------------

/**
 * owner: owns every workspace they are in, or is a server admin; member: joined someone's workspace
 * (any role but owner);
 * guest: no team workspace, but pages shared with them in someone else's workspace (docs/adr/1250-*).
 */
export async function audienceOf(userId: string, isAdmin: boolean): Promise<OnboardingAudience> {
  const rows = (await db.execute(sql`
    SELECT
      EXISTS (
        SELECT 1 FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id
         WHERE m.user_id = ${userId} AND w.deleted_at IS NULL AND m.role <> 'owner'
      ) AS "team",
      EXISTS (
        SELECT 1 FROM page_grants g JOIN pages p ON p.id = g.page_id
         WHERE g.user_id = ${userId}
           AND NOT EXISTS (SELECT 1 FROM workspace_members m WHERE m.workspace_id = p.workspace_id AND m.user_id = ${userId})
      ) AS "guest"
  `)) as unknown as { team: boolean; guest: boolean }[]
  const { team, guest } = rows[0] ?? { team: false, guest: false }
  if (isAdmin) return 'owner'
  if (team) return 'member'
  return guest ? 'guest' : 'owner'
}

const uuidArray = (ids: string[]): string => `{${ids.filter((x) => UUID_RE.test(x)).join(',')}}`

/** What the server knows the person did, for the items not yet done. Sample pages do not count. */
export async function serverFacts(userId: string, sampleIds: string[], want: OnboardingItemId[]): Promise<Set<OnboardingItemId>> {
  const out = new Set<OnboardingItemId>()
  if (want.length === 0) return out
  const ids = uuidArray(sampleIds)
  const w = new Set(want)
  const rows = (await db.execute(sql`
    SELECT
      ${w.has('page') ? sql`EXISTS (
        SELECT 1 FROM pages p WHERE p.created_by = ${userId} AND p.deleted_at IS NULL AND NOT (p.id = ANY(${ids}::uuid[]))
      )` : sql`false`} AS "page",
      ${w.has('database') ? sql`EXISTS (
        SELECT 1 FROM pages p WHERE p.created_by = ${userId} AND p.kind = 'collection' AND p.deleted_at IS NULL
           AND NOT (p.id = ANY(${ids}::uuid[]))
      )` : sql`false`} AS "database",
      ${w.has('link') ? sql`EXISTS (
        SELECT 1 FROM page_links l JOIN pages p ON p.id = l.source_page_id
         WHERE p.created_by = ${userId} AND p.deleted_at IS NULL AND NOT (p.id = ANY(${ids}::uuid[]))
      )` : sql`false`} AS "link",
      ${w.has('comment') ? sql`EXISTS (SELECT 1 FROM comments c WHERE c.author_id = ${userId})` : sql`false`} AS "comment",
      ${w.has('ai') ? sql`(
        EXISTS (SELECT 1 FROM oauth_grants g WHERE g.user_id = ${userId})
        OR EXISTS (SELECT 1 FROM api_tokens t WHERE t.user_id = ${userId})
      )` : sql`false`} AS "ai",
      ${w.has('share') ? sql`(
        EXISTS (SELECT 1 FROM workspace_audit_events e WHERE e.actor_id = ${userId}
                  AND e.action IN ('share.published', 'member.added'))
        OR EXISTS (SELECT 1 FROM page_grants g WHERE g.created_by = ${userId})
        OR EXISTS (SELECT 1 FROM page_invites i WHERE i.invited_by = ${userId})
        OR EXISTS (
          SELECT 1 FROM workspace_members mine
            JOIN workspaces ws ON ws.id = mine.workspace_id AND ws.deleted_at IS NULL
            JOIN workspace_members m ON m.workspace_id = mine.workspace_id AND m.user_id <> ${userId}
           WHERE mine.user_id = ${userId} AND mine.role = 'owner'
        )
      )` : sql`false`} AS "share"
  `)) as unknown as Record<string, boolean>[]
  const r = rows[0] ?? {}
  for (const id of want) if (r[id] === true) out.add(id)
  return out
}

/** Live sample roots by workspace (trashed or purged ones, or ones in a deleted workspace, are gone). */
async function liveSamples(state: OnboardingState): Promise<Record<string, string>> {
  const entries = Object.entries(state.samples ?? {})
  if (entries.length === 0) return {}
  const rows = (await db.execute(sql`
    SELECT p.id, p.workspace_id AS "workspaceId" FROM pages p JOIN workspaces w ON w.id = p.workspace_id
     WHERE p.id = ANY(${uuidArray(entries.map(([, s]) => s.root))}::uuid[]) AND p.deleted_at IS NULL AND w.deleted_at IS NULL
  `)) as unknown as { id: string; workspaceId: string }[]
  const live = new Set(rows.map((r) => `${r.workspaceId}:${r.id}`))
  const out: Record<string, string> = {}
  for (const [ws, s] of entries) if (live.has(`${ws}:${s.root}`)) out[ws] = s.root
  return out
}

function itemsFor(audience: OnboardingAudience): OnboardingItemId[] {
  return [...ONBOARDING_ITEMS_BY_AUDIENCE[audience]]
}

const allSampleIds = (s: OnboardingState): string[] => Object.values(s.samples ?? {}).flatMap((x) => x.ids)

// ---------------------------------------------------------------------------
// sample pages
// ---------------------------------------------------------------------------

/**
 * Make the sample page tree in `workspaceId`, in the person's private pages, and record it.
 * One live sample per person and workspace: an existing live one is returned instead.
 */
export async function createSample(args: {
  userId: string
  userName: string
  workspaceId: string
  role: 'owner' | 'admin' | 'member'
  locale: Locale
  auto?: boolean
}): Promise<{ pageId: string; created: boolean }> {
  const { state } = await claimState(args.userId)
  const existing = (await liveSamples(state))[args.workspaceId]
  if (existing) return { pageId: existing, created: false }
  // One maker at a time per person and workspace (a double click, two tabs); a stale mark (a crash
  // in between) expires after a minute.
  const startedAt = new Date().toISOString()
  let busy = false
  await updateState(args.userId, (s) => {
    const prev = s.creating?.[args.workspaceId]
    if (prev && Date.now() - Date.parse(prev) < 60_000) {
      busy = true
      return null
    }
    return { ...s, creating: { ...(s.creating ?? {}), [args.workspaceId]: startedAt } }
  })
  if (busy) throw conflict('SAMPLE_IN_PROGRESS', 'The sample page is being made; try again in a moment')
  const release = (s: OnboardingState): OnboardingState => {
    const creating = { ...(s.creating ?? {}) }
    delete creating[args.workspaceId]
    return { ...s, creating }
  }
  try {
    return await makeSample(args)
  } finally {
    await updateState(args.userId, release)
  }
}

async function makeSample(args: {
  userId: string
  userName: string
  workspaceId: string
  role: 'owner' | 'admin' | 'member'
  locale: Locale
  auto?: boolean
}): Promise<{ pageId: string; created: boolean }> {

  const root = await compileSpec(sampleSpec(args.locale))
  const [ws] = await db.select({ name: workspaces.name }).from(workspaces).where(eq(workspaces.id, args.workspaceId)).limit(1)
  const result = await instantiateTree({
    root,
    workspaceId: args.workspaceId,
    parentId: null,
    scope: 'private',
    role: args.role,
    userId: args.userId,
    ctx: { title: sampleTitle(args.locale), author: args.userName, workspace: ws?.name ?? '', locale: args.locale, now: wallClock(new Date()), inputs: {} },
    rootTitle: sampleTitle(args.locale),
  })
  const ids = result.pages.map((p) => p.id)
  const record: SampleRecord = { root: ids[0], ids, at: new Date().toISOString(), ...(args.auto ? { auto: true } : {}) }
  await updateState(args.userId, (s) => ({ ...s, samples: { ...(s.samples ?? {}), [args.workspaceId]: record } }))
  return { pageId: ids[0], created: true }
}

/**
 * The first admin of a new server gets the sample in their first workspace once, the first time the
 * app asks for their onboarding (docs/adr/2381-*). "First admin" = an admin with no older account
 * on the server. Never again after that, whatever happens to the page.
 */
async function maybeAutoSample(user: { id: string; name: string; isAdmin: boolean }, locale: () => Promise<Locale>): Promise<void> {
  // Claim the one attempt atomically: of two first reads at once only one goes on.
  const claimed = (await db.execute(sql`
    UPDATE user_onboarding SET state = state || '{"autoSample": "pending"}'::jsonb, updated_at = now()
     WHERE user_id = ${user.id} AND state->'autoSample' IS NULL
    RETURNING user_id
  `)) as unknown as unknown[]
  if (claimed.length === 0) return
  let outcome: OnboardingState['autoSample'] = 'none'
  try {
    if (user.isAdmin) {
      const older = (await db.execute(sql`
        SELECT EXISTS (
          SELECT 1 FROM users o, users me WHERE me.id = ${user.id} AND o.id <> me.id AND o.created_at <= me.created_at
        ) AS "older"
      `)) as unknown as { older: boolean }[]
      if (!older[0]?.older) {
        const [first] = await db
          .select({ id: workspaces.id, role: workspaceMembers.role })
          .from(workspaceMembers)
          .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
          .where(and(eq(workspaceMembers.userId, user.id), isNull(workspaces.deletedAt)))
          .orderBy(asc(workspaces.createdAt))
          .limit(1)
        if (first) {
          await createSample({ userId: user.id, userName: user.name, workspaceId: first.id, role: first.role, locale: await locale(), auto: true })
          outcome = 'created'
        }
      }
    }
  } catch (err) {
    console.error('[inkling] onboarding: sample page failed', err)
    outcome = 'failed'
  }
  await updateState(user.id, (s) => ({ ...s, autoSample: outcome }))
}

// ---------------------------------------------------------------------------
// read and update
// ---------------------------------------------------------------------------

const DISABLED: OnboardingDTO = {
  enabled: false,
  audience: 'owner',
  intro: false,
  checklist: { show: false, collapsed: false, dismissed: true, complete: false, items: [] },
  samples: {},
}

export async function loadOnboarding(
  user: { id: string; name: string; isAdmin: boolean },
  locale: () => Promise<Locale>,
): Promise<OnboardingDTO> {
  const claimed = await claimState(user.id)
  if (!onboardingEnabled()) return DISABLED
  let state = claimed.state
  if (!state.autoSample && !state.legacy && !state.off) {
    // A new account's first read: the first admin's sample (at most once; autoSample records it).
    await maybeAutoSample(user, locale)
    state = (await claimState(user.id)).state
  }
  return toDTO(user, state)
}

async function toDTO(user: { id: string; isAdmin: boolean }, state0: OnboardingState): Promise<OnboardingDTO> {
  let state = state0
  const audience = await audienceOf(user.id, user.isAdmin)
  const samples = await liveSamples(state)
  if (audience === 'guest') {
    return { enabled: true, audience, intro: false, checklist: { show: false, collapsed: false, dismissed: true, complete: false, items: [] }, samples }
  }
  const items = itemsFor(audience)
  const dismissed = state.dismissed ?? !!(state.legacy || state.off)
  const pending = items.filter((id) => !state.done?.[id])
  // Facts are only worth the queries while the card can show.
  if (!dismissed && pending.length > 0) {
    const seen = await serverFacts(user.id, allSampleIds(state), pending)
    if (seen.size > 0) {
      const at = new Date().toISOString()
      state = await updateState(user.id, (s) => {
        const done = { ...(s.done ?? {}) }
        for (const id of seen) done[id] ??= at
        return { ...s, done }
      })
    }
  }
  const dtoItems = items.map((id) => ({ id, done: !!state.done?.[id] }))
  const complete = dtoItems.every((i) => i.done || ONBOARDING_OPTIONAL_ITEMS.includes(i.id))
  return {
    enabled: true,
    audience,
    intro: !state.legacy && !state.off && !state.introSeenAt,
    checklist: {
      show: !dismissed && (!complete || !!state.reopened),
      // folded by default in the sidebar (the empty workspace screen always shows it whole)
      collapsed: state.collapsed ?? true,
      dismissed,
      complete,
      items: dtoItems,
    },
    samples,
  }
}

/** PATCH: intro closed, card folded/dismissed/turned back on, or a browser-only event. */
export async function applyUpdate(
  user: { id: string; name: string; isAdmin: boolean },
  body: UpdateOnboardingInput,
): Promise<OnboardingDTO> {
  await claimState(user.id)
  if (!onboardingEnabled()) return DISABLED
  const at = new Date().toISOString()
  const state = await updateState(user.id, (s) => {
    const next: OnboardingState = { ...s }
    if (body.introSeen) next.introSeenAt ??= at
    if (body.collapsed !== undefined) next.collapsed = body.collapsed
    if (body.dismissed !== undefined) {
      next.dismissed = body.dismissed
      next.reopened = !body.dismissed
      if (!body.dismissed) next.collapsed = false
    }
    if (body.event && EVENT_SET.has(body.event)) {
      const ev: OnboardingClientEvent = body.event
      next.done = { ...(s.done ?? {}), [ev]: s.done?.[ev] ?? at }
    }
    return next
  })
  return toDTO(user, state)
}
