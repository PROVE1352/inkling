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
import { AppError, conflict } from '../errors'
import { pages, userOnboarding, workspaceMembers, workspaces } from '../db/schema'
import type { Locale } from '../i18n'
import { compileSpec } from '../templates/builtins'
import { instantiateTree } from '../templates/structure'
import { wallClock } from '../templates/variables'
import { sampleSpec, sampleTitle } from './sample'
import { seedSampleSuggestions } from './exampleSuggestions'

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
  /** When autoSample became 'pending' (a crash in between must not leave it "being made" for good). */
  autoSampleAt?: string
  /** Sample pages being made, by workspace id (start time): a second click waits for the first. */
  creating?: Record<string, string>
  /**
   * When this person's agent was first seen connected: the first authenticated /mcp request through
   * one of their OAuth grants or agent connection tokens (onboarding/agent.ts), or, for connections
   * made before 0.24, a grant that has been used. Set once (docs/adr/2390-*).
   */
  agentAt?: string
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ITEM_SET = new Set<string>(ONBOARDING_ITEMS)
const EVENT_SET = new Set<string>(ONBOARDING_CLIENT_EVENTS)

/** ONBOARDING=off (or 0/false/no) turns the whole thing off for this server. Read per call (tests switch it). */
export function onboardingEnabled(): boolean {
  const v = (process.env.ONBOARDING ?? '').trim().toLowerCase()
  return !(v === 'off' || v === '0' || v === 'false' || v === 'no')
}

/**
 * ONBOARDING_EXISTING_USERS=once: accounts from before onboarding (migration 0060's `legacy` rows and
 * rows first made while ONBOARDING=off) also get the intro once, on their next app load. Only the
 * intro: their checklist stays off (Settings turns it on) and no sample page is made for them.
 * Read per call (tests switch it). Turning it off later changes nothing for those who saw it.
 */
export function existingUsersOnce(): boolean {
  const v = (process.env.ONBOARDING_EXISTING_USERS ?? '').trim().toLowerCase()
  return v === 'once' || v === '1' || v === 'true' || v === 'on' || v === 'yes'
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
  if (typeof r.autoSampleAt === 'string') out.autoSampleAt = r.autoSampleAt
  if (r.creating && typeof r.creating === 'object') {
    const creating: Record<string, string> = {}
    for (const [ws, v] of Object.entries(r.creating as Record<string, unknown>)) if (UUID_RE.test(ws) && typeof v === 'string') creating[ws] = v
    out.creating = creating
  }
  if (typeof r.agentAt === 'string') out.agentAt = r.agentAt
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

/**
 * What the server knows the person did, for the items not yet done. Sample pages do not count.
 * `ai` is not read here: it is ticked with `agentAt`, when an agent of theirs is seen connected
 * (docs/adr/2390-*), not when a grant or a token merely exists.
 */
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

/** How long a "sample being made" mark counts; an older one is left over from a crash. */
const SAMPLE_MARK_MS = 60_000
const freshMark = (at: string | undefined, now: number): boolean => !!at && now - Date.parse(at) < SAMPLE_MARK_MS

/**
 * A sample page is being made for this person (by the button, or the first admin's automatic one).
 * Its pages exist before the state lists their ids, so facts read now would count the sample's own
 * page, database and link as the person's.
 */
export function sampleInProgress(s: OnboardingState, now = Date.now()): boolean {
  if (s.autoSample === 'pending' && freshMark(s.autoSampleAt, now)) return true
  return Object.values(s.creating ?? {}).some((at) => freshMark(at, now))
}

/**
 * Applies facts read with `sampleIdsUsed` left out to the state as it is now (under the row lock).
 * null = nothing to store: a sample started or finished since the facts were read (its pages may be
 * in them), or nothing new; the next read looks again.
 */
export function applySeenFacts(s: OnboardingState, seen: Set<OnboardingItemId>, sampleIdsUsed: string[], at: string, now = Date.now()): OnboardingState | null {
  if (seen.size === 0 || sampleInProgress(s, now)) return null
  const used = new Set(sampleIdsUsed)
  if (allSampleIds(s).some((id) => !used.has(id))) return null
  const done = { ...(s.done ?? {}) }
  let changed = false
  for (const id of seen) {
    if (done[id]) continue
    done[id] = at
    changed = true
  }
  return changed ? { ...s, done } : null
}

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
    if (freshMark(s.creating?.[args.workspaceId], Date.now())) {
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
  // Example suggestions (docs/adr/2388-*) only after the record: the sample stands without them, and
  // a failure here must not make it look like the sample was never made.
  try {
    await seedSampleSuggestions(args.userId, ids[0], args.locale)
  } catch (err) {
    console.error('[inkling] onboarding: example suggestions failed', err)
  }
  return { pageId: ids[0], created: true }
}

/**
 * The workspace a new account got with its sign-up: one it owns and made itself in the same
 * transaction as the account (POST /auth/register and the first OpenID Connect sign-in insert the
 * user and the workspace together, so both `created_at` defaults are that transaction's `now()`; the
 * two-second window only absorbs a split into two statements). Accounts made without one (delegated
 * sign-in, the test harness) have none, and a workspace someone makes by hand later never counts.
 */
async function signupWorkspace(userId: string): Promise<{ id: string; role: 'owner' } | null> {
  const rows = (await db.execute(sql`
    SELECT w.id FROM users u
      JOIN workspaces w ON w.created_by = u.id AND w.deleted_at IS NULL
                       AND w.created_at >= u.created_at AND w.created_at <= u.created_at + interval '2 seconds'
      JOIN workspace_members m ON m.workspace_id = w.id AND m.user_id = u.id AND m.role = 'owner'
     WHERE u.id = ${userId}
     ORDER BY w.created_at ASC, w.id ASC
     LIMIT 1
  `)) as unknown as { id: string }[]
  return rows[0] ? { id: rows[0].id, role: 'owner' } : null
}

/** A workspace limit (pages, storage) refused the sample: expected, nothing to log as an error. */
const isLimitRefusal = (err: unknown): boolean => err instanceof AppError && err.code.startsWith('LIMIT_')

/**
 * A new account gets the sample once, the first time the app asks for their onboarding (not in the
 * sign-up request, which stays as it was): every account in the workspace it got with its sign-up
 * (docs/adr/2390-*), and the first admin of a new server in their first workspace (docs/adr/2381-*;
 * "first admin" = an admin with no older account on the server). Never again after that, whatever
 * happens to the page. A failure (a workspace limit, the database) is recorded as 'failed' and the
 * read goes on; the empty home screen's button can still make one.
 */
async function maybeAutoSample(user: { id: string; name: string; isAdmin: boolean }, locale: () => Promise<Locale>): Promise<void> {
  // Claim the one attempt atomically: of two first reads at once only one goes on.
  const claimed = (await db.execute(sql`
    UPDATE user_onboarding SET state = state || ${JSON.stringify({ autoSample: 'pending', autoSampleAt: new Date().toISOString() })}::jsonb, updated_at = now()
     WHERE user_id = ${user.id} AND state->'autoSample' IS NULL
    RETURNING user_id
  `)) as unknown as unknown[]
  if (claimed.length === 0) return
  let outcome: OnboardingState['autoSample'] = 'none'
  try {
    let target: { id: string; role: 'owner' | 'admin' | 'member' } | null = await signupWorkspace(user.id)
    if (!target && user.isAdmin) {
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
        target = first ?? null
      }
    }
    if (target) {
      await createSample({ userId: user.id, userName: user.name, workspaceId: target.id, role: target.role, locale: await locale(), auto: true })
      outcome = 'created'
    }
  } catch (err) {
    if (err instanceof AppError && err.code === 'SAMPLE_IN_PROGRESS') {
      // The button got there first (createSample's per-workspace mark): its sample is the one, and a
      // second is never made. Recorded as made; if the button's attempt fails, the button stays.
      outcome = 'created'
    } else {
      if (!isLimitRefusal(err)) console.error('[inkling] onboarding: sample page failed', err)
      outcome = 'failed'
    }
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
  agentConnected: false,
}

/** The state with the agent seen connected at `at` (and the checklist's `ai` ticked); null = it already was. */
export function withAgentConnected(s: OnboardingState, at: string): OnboardingState | null {
  if (s.agentAt) return null
  return { ...s, agentAt: at, done: { ...(s.done ?? {}), ai: s.done?.ai ?? at } }
}

/**
 * Connections made before 0.24 (or a first request whose record failed): one of the person's OAuth
 * grants or agent connection tokens has been used. `last_used_at` is written only by the bearer check
 * (`getBearerUser`), which only /mcp and its internal calls reach.
 */
async function agentUsedBefore(userId: string): Promise<boolean> {
  const rows = (await db.execute(sql`
    SELECT EXISTS (SELECT 1 FROM oauth_grants g WHERE g.user_id = ${userId} AND g.last_used_at IS NOT NULL) AS "used"
  `)) as unknown as { used: boolean }[]
  return rows[0]?.used === true
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
  if (!state.agentAt && (await agentUsedBefore(user.id))) {
    const at = new Date().toISOString()
    state = await updateState(user.id, (s) => withAgentConnected(s, at))
  }
  const agentConnected = !!state.agentAt
  const audience = await audienceOf(user.id, user.isAdmin)
  const samples = await liveSamples(state)
  if (audience === 'guest') {
    return { enabled: true, audience, intro: false, checklist: { show: false, collapsed: false, dismissed: true, complete: false, items: [] }, samples, agentConnected }
  }
  const items = itemsFor(audience)
  const dismissed = state.dismissed ?? !!(state.legacy || state.off)
  const pending = items.filter((id) => !state.done?.[id])
  // Facts are only worth the queries while the card can show, and are not read while a sample page
  // is being made (its pages are not yet listed as the sample's).
  if (!dismissed && pending.length > 0 && !sampleInProgress(state)) {
    const idsUsed = allSampleIds(state)
    const seen = await serverFacts(user.id, idsUsed, pending)
    if (seen.size > 0) {
      const at = new Date().toISOString()
      state = await updateState(user.id, (s) => applySeenFacts(s, seen, idsUsed, at))
    }
  }
  const dtoItems = items.map((id) => ({ id, done: !!state.done?.[id] }))
  const complete = dtoItems.every((i) => i.done || ONBOARDING_OPTIONAL_ITEMS.includes(i.id))
  return {
    enabled: true,
    audience,
    // New accounts always; accounts from before the feature only while the operator asks for it
    // (ONBOARDING_EXISTING_USERS=once). Either way once: introSeenAt is kept for good.
    intro: !state.introSeenAt && (!(state.legacy || state.off) || existingUsersOnce()),
    checklist: {
      show: !dismissed && (!complete || !!state.reopened),
      // folded by default in the sidebar (the empty workspace screen always shows it whole)
      collapsed: state.collapsed ?? true,
      dismissed,
      complete,
      items: dtoItems,
    },
    samples,
    agentConnected,
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
