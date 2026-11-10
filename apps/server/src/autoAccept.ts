import { sql } from 'drizzle-orm'
import { DEFAULT_AUTO_ACCEPT_RULES } from '@inkling/shared'
import type { AgentEditLevel, AutoAcceptRules, SuggestionPreviewDTO } from '@inkling/shared'
import { pageAccess } from './aclVersion'
import { outsideAgent } from './agentAccess'
import { demotionFor, taintReviewReason } from './agentTaint'
import type { AuthUser } from './auth'
import { patchSectionAs } from './context/sectionWrite'
import { db } from './db/index'
import { assertPageEditable, lockAgentPolicies } from './editLock'
import { normalizeLocale } from './i18n'
import type { Locale } from './i18n'
import { env } from './env'
import { notify } from './notify/engine'
import { findLivePage } from './pageDto'
import { dropSuggestionBases } from './suggestionMerge'

/**
 * Agent edit policy and auto-accept rules (docs/adr/1544-*, 1545-*).
 *
 * Levels: direct (agents write, the default), auto (agent edits become suggestions that rules accept
 * without a person), review (every agent edit waits for a person = the "suggestions only" lock).
 * The workspace default lives in agent_edit_policies (page_id NULL); a lock node overrides it for its
 * subtree with its agents preset (direct / auto / suggest), and an 'auto' node's rules live in
 * agent_edit_policies under its page id. The nearest node with an agents rule wins (editLock
 * chainAgentPolicy); no node → the workspace default.
 *
 * Auto-accept: a suggestion is accepted by the rule only when ALL hold: the section is still at the
 * suggestion's base version (always, no exception; checked again atomically by the patch itself),
 * its mode is allowed (whole-page edits never are), the connection is allowed, and the change fits
 * the size limit. With a grace period it waits (auto_at) and the sweeper accepts it later unless a
 * person decided first or the section changed (then a person decides). Accepting goes through the
 * normal section patch as the author's person (write gate, edit lock, snapshots), outside the agent
 * scope; the row records the rule and, as decider, the person who set the rule.
 */

export interface EffectivePolicy {
  level: AgentEditLevel
  rules: AutoAcceptRules
  /** 'workspace' or 'page:<id>' (the node whose rules apply). */
  label: string
  setter: string | null
  /** Where the level comes from: the workspace default or a lock node. */
  source: 'workspace' | 'lock'
}

interface PolicyRow {
  id: string
  pageId: string | null
  level: AgentEditLevel
  modes: unknown
  connections: unknown
  maxLines: number | null
  maxChars: number | null
  graceMinutes: number
  updatedBy: string | null
  updatedAt: string | null
}

const POLICY_COLS = sql`id, page_id AS "pageId", level, modes, connections, max_lines AS "maxLines", max_chars AS "maxChars",
  grace_minutes AS "graceMinutes", updated_by AS "updatedBy", updated_at AS "updatedAt"`

export function rulesOf(r: PolicyRow | undefined | null): AutoAcceptRules {
  if (!r) return { ...DEFAULT_AUTO_ACCEPT_RULES }
  return {
    modes: Array.isArray(r.modes) ? (r.modes as AutoAcceptRules['modes']) : DEFAULT_AUTO_ACCEPT_RULES.modes,
    connections: Array.isArray(r.connections) ? (r.connections as string[]) : [],
    maxLines: r.maxLines,
    maxChars: r.maxChars,
    graceMinutes: r.graceMinutes,
  }
}

export async function workspacePolicyRow(workspaceId: string): Promise<PolicyRow | null> {
  const rows = (await db.execute(sql`SELECT ${POLICY_COLS} FROM agent_edit_policies WHERE workspace_id = ${workspaceId} AND page_id IS NULL`)) as unknown as PolicyRow[]
  return rows[0] ?? null
}

export async function pagePolicyRow(pageId: string): Promise<PolicyRow | null> {
  const rows = (await db.execute(sql`SELECT ${POLICY_COLS} FROM agent_edit_policies WHERE page_id = ${pageId}`)) as unknown as PolicyRow[]
  return rows[0] ?? null
}

/** Policies for several pages: lock nodes first, else their workspace's default (fresh reads, no cache). */
export async function effectivePolicies(pages: { id: string; workspaceId: string }[]): Promise<Map<string, EffectivePolicy>> {
  const out = new Map<string, EffectivePolicy>()
  if (!pages.length) return out
  const locks = await lockAgentPolicies(db, pages.map((p) => p.id))
  const nodeIds = [...new Set([...locks.values()].filter((l) => l?.level === 'auto').map((l) => l!.nodeId))]
  const wsIds = [...new Set(pages.map((p) => p.workspaceId))]
  const rows = (await db.execute(sql`
    SELECT ${POLICY_COLS}, workspace_id AS "workspaceId" FROM agent_edit_policies
     WHERE (page_id IS NULL AND workspace_id IN (SELECT jsonb_array_elements_text(${JSON.stringify(wsIds)}::jsonb)::uuid))
        OR page_id IN (SELECT jsonb_array_elements_text(${JSON.stringify(nodeIds)}::jsonb)::uuid)
  `)) as unknown as (PolicyRow & { workspaceId: string })[]
  const wsRow = new Map(rows.filter((r) => !r.pageId).map((r) => [r.workspaceId, r]))
  const nodeRow = new Map(rows.filter((r) => r.pageId).map((r) => [r.pageId!, r]))
  for (const p of pages) {
    const l = locks.get(p.id)
    if (l) {
      const r = l.level === 'auto' ? nodeRow.get(l.nodeId) : undefined
      out.set(p.id, { level: l.level, rules: rulesOf(r), label: `page:${l.nodeId}`, setter: r?.updatedBy ?? null, source: 'lock' })
    } else {
      const r = wsRow.get(p.workspaceId)
      out.set(p.id, { level: r?.level ?? 'direct', rules: rulesOf(r), label: 'workspace', setter: r?.updatedBy ?? null, source: 'workspace' })
    }
  }
  return out
}

export async function effectivePolicy(page: { id: string; workspaceId: string }): Promise<EffectivePolicy> {
  return (await effectivePolicies([page])).get(page.id)!
}

/** "the workspace rule" / "the rule of page <id>" (agent text, inbox excerpts). */
export function ruleText(label: string): string {
  return label === 'workspace' ? 'the workspace rule' : `the rule of page ${label.replace(/^page:/, '')}`
}

// ---------------------------------------------------------------------------
// rules
// ---------------------------------------------------------------------------

export interface Candidate {
  mode: string
  connection: string
  preview: SuggestionPreviewDTO
}

/** Why `c` needs a person under `rules`, or null when the rule accepts it. Deterministic order. */
export function reviewReasonFor(c: Candidate, rules: AutoAcceptRules): string | null {
  if (c.mode === 'page_replace' || c.mode === 'page_append') return 'whole-page edits always need a person'
  if (!(rules.modes as string[]).includes(c.mode)) return `mode ${c.mode} is not auto-accepted here`
  if (rules.connections.length && !rules.connections.includes(c.connection)) return 'this connection is not on the auto-accept list'
  if (!c.preview.found) return 'the section no longer exists'
  if (c.preview.changed) return 'the section changed since the version the agent read'
  if (rules.maxLines !== null || rules.maxChars !== null) {
    if (!c.preview.ops) return 'the change is too large to measure'
    const changed = c.preview.ops.filter((o) => o.t !== '=')
    const lines = changed.length
    const chars = changed.reduce((n, o) => n + o.s.length, 0)
    if (rules.maxLines !== null && lines > rules.maxLines) return `the change is larger than the rule allows (${lines} lines > ${rules.maxLines})`
    if (rules.maxChars !== null && chars > rules.maxChars) return `the change is larger than the rule allows (${chars} characters > ${rules.maxChars})`
  }
  return null
}

// ---------------------------------------------------------------------------
// applying
// ---------------------------------------------------------------------------

interface ApplyRow {
  id: string
  workspaceId: string
  pageId: string
  anchor: string
  mode: string
  markdown: string
  baseVersion: string | null
  authorId: string
  via: string | null
}

async function authorUser(id: string): Promise<(AuthUser & { locale: Locale }) | null> {
  const rows = (await db.execute(sql`SELECT id, email, name, is_admin AS "isAdmin", locale FROM users WHERE id = ${id}`)) as unknown as {
    id: string
    email: string
    name: string
    isAdmin: boolean
    locale: string | null
  }[]
  const u = rows[0]
  return u ? { id: u.id, email: u.email, name: u.name, isAdmin: u.isAdmin, locale: normalizeLocale(u.locale) ?? env.defaultLocale } : null
}

export type ApplyResult = { ok: true; anchor: string | null; version: string | null } | { ok: false; reason: string }

/**
 * Accepts `row` by `label`'s rule: claims it (open → accepted, decider = the rule's setter), then
 * patches the section as the author's person, outside any agent scope, with the base version (the
 * "unchanged since the agent read it" rule, checked atomically by the patch). On any failure the row
 * goes back to open with the reason, for a person.
 */
export async function applyByRule(row: ApplyRow, currentAnchor: string, label: string, setter: string | null): Promise<ApplyResult> {
  const claimed = (await db.execute(sql`
    UPDATE section_suggestions SET status = 'accepted', decided_by = ${setter}, decided_at = now(), rule = ${label}, auto_at = NULL, review_reason = NULL
     WHERE id = ${row.id} AND status = 'open' RETURNING id
  `)) as unknown as unknown[]
  if (!claimed.length) return { ok: false, reason: 'already decided' }
  let reason: string
  try {
    const result = await outsideAgent(async (): Promise<ApplyResult> => {
      const author = await authorUser(row.authorId)
      const page = await findLivePage(row.pageId)
      if (!author || !page) return { ok: false, reason: 'the page or its author is gone' }
      const access = await pageAccess(db, page.id, author.id)
      if (!access) return { ok: false, reason: 'the author can no longer reach this page' }
      // The author's person must still be allowed to edit (the agent only ever suggested).
      await assertPageEditable(page.id, author.id, { role: access.role, acl: access.acl })
      const actor = { ...author, via: `${row.via ?? 'agent'} · auto-accepted`.slice(0, 100) }
      const r = await patchSectionAs(
        actor,
        page,
        access,
        { ref: currentAnchor, markdown: row.markdown, mode: row.mode as never, ...(row.baseVersion ? { baseVersion: row.baseVersion } : {}) },
        async () => author.locale,
      )
      if (r.status === 409) return { ok: false, reason: 'the section changed before it could be applied' }
      return { ok: true, anchor: r.body.section?.anchor ?? null, version: r.body.section?.version ?? null }
    })
    if (result.ok) {
      await dropSuggestionBases(db, [row.id])
      return result
    }
    reason = result.reason
  } catch (err) {
    reason = `it could not be applied (${err instanceof Error ? err.message.slice(0, 200) : 'error'})`
  }
  await db.execute(sql`
    UPDATE section_suggestions SET status = 'open', decided_by = NULL, decided_at = NULL, rule = NULL, review_reason = ${reason}
     WHERE id = ${row.id} AND status = 'accepted'
  `)
  return { ok: false, reason }
}

// ---------------------------------------------------------------------------
// grace period sweeper
// ---------------------------------------------------------------------------

/**
 * Accepts suggestions whose grace period ended. Multi-process safe: each row is taken by clearing
 * its `auto_at` in one UPDATE (only one process gets it), then checked again (rule still in force,
 * section unchanged, rules still pass) and applied; otherwise it stays open for a person with the
 * reason. Returns the number accepted.
 */
export async function runAutoAccepts(limit = 20): Promise<number> {
  const { previewOf, loadRowForRules } = await import('./suggestions')
  const due = (await db.execute(sql`
    SELECT id FROM section_suggestions WHERE status = 'open' AND auto_at IS NOT NULL AND auto_at <= now() ORDER BY auto_at, id LIMIT ${limit}
  `)) as unknown as { id: string }[]
  let accepted = 0
  for (const { id } of due) {
    const taken = (await db.execute(sql`
      UPDATE section_suggestions SET auto_at = NULL
       WHERE id = ${id} AND status = 'open' AND auto_at IS NOT NULL AND auto_at <= now() RETURNING id
    `)) as unknown as unknown[]
    if (!taken.length) continue
    const row = await loadRowForRules(id)
    if (!row || row.status !== 'open') continue
    const hold = async (reason: string) => {
      await db.execute(sql`UPDATE section_suggestions SET review_reason = ${reason}, rule = NULL WHERE id = ${id} AND status = 'open'`)
    }
    const policy = await effectivePolicy({ id: row.pageId, workspaceId: row.workspaceId })
    if (policy.level !== 'auto' || policy.label !== row.rule) {
      await hold('the auto-accept rule changed during the grace period')
      continue
    }
    // The connection read flagged content during the grace period (docs/adr/2041-*): a person decides.
    const taint = row.connection ? await demotionFor(row.connection, row.workspaceId) : null
    if (taint) {
      await hold(taintReviewReason(taint))
      continue
    }
    const preview = await previewOf(row, row.authorId)
    if (preview.found && preview.changed) {
      await hold('the section changed during the grace period')
      continue
    }
    const why = reviewReasonFor({ mode: row.mode, connection: row.connection, preview }, policy.rules)
    if (why) {
      await hold(why)
      continue
    }
    const r = await applyByRule(row, preview.currentAnchor ?? row.anchor, policy.label, policy.setter)
    if (!r.ok) continue
    accepted++
    notify({
      workspaceId: row.workspaceId,
      pageId: row.pageId,
      actorId: policy.setter && policy.setter !== row.authorId ? policy.setter : null,
      via: null,
      recipients: [{ userId: row.authorId, kind: 'approval_result', reason: 'direct' }],
      anchor: row.anchor || null,
      excerpt: `accepted: suggestion ${row.id} (${row.mode}${row.anchor ? ` §${row.anchor}` : ''}) by ${ruleText(policy.label)}`,
    })
  }
  return accepted
}

let timer: ReturnType<typeof setInterval> | null = null
/** Every 30 s while the server runs (a grace period is minutes long). */
export function startAutoAcceptTimer(log: (msg: string) => void): void {
  if (timer) return
  timer = setInterval(() => {
    runAutoAccepts().catch((err) => log(`[auto-accept] sweep failed: ${String(err)}`))
  }, 30_000)
  timer.unref?.()
}

export function stopAutoAcceptTimer(): void {
  if (timer) clearInterval(timer)
  timer = null
}
