import { sql } from 'drizzle-orm'
import { MAX_OPEN_SUGGESTIONS_PER_PAGE } from '@inkling/shared'
import type { SuggestionDTO, SuggestionMode, SuggestionPreviewDTO, SuggestionStatus, SuggestionStatusFilter } from '@inkling/shared'
import { gateWrite } from './aclVersion'
import type { CheckedAccess } from './aclVersion'
import { currentAgent } from './agentAccess'
import { demotionIn, taintReviewReason } from './agentTaint'
import type { AuthUser } from './auth'
import { findSection, joinPath } from './context/chunker'
import { diffOps } from './context/diff'
import { resolveMovedSection } from './context/sectionMoves'
import { currentBlocks, readOutline, readSection } from './context/sectionSource'
import type { OutlineSection } from './context/sectionSource'
import { patchSectionAs } from './context/sectionWrite'
import { db } from './db/index'
import { assertPageEditable, suggestionRight } from './editLock'
import { AppError, badRequest, forbidden, notFound } from './errors'
import { requireMembershipAcl } from './helpers'
import type { Locale } from './i18n'
import { assertNotClaimed, connectionKey } from './leases'
import { applyByRule, effectivePolicy, reviewReasonFor } from './autoAccept'
import type { EffectivePolicy } from './autoAccept'
import { blocksToMarkdown, blocksToStateBuffer, markdownToBlocks, stripFrontmatter } from './md/convert'
import { buildTitleResolver } from './md/importer'
import { notify, notifyOutboxRow } from './notify/engine'
import { enqueue, outboxCommitted } from './outbox'
import { writePageContentAs } from './pageContentWrite'
import { dropSuggestionBases, mergedBlocks, parsePartial, recordPartial, storeSuggestionBase, SUGGESTION_BASE_STORE, suggestionMerge } from './suggestionMerge'
import { findVisiblePage } from './pageDto'
import type { PageRow } from './pageDto'

/**
 * Suggested edits (docs/adr/1530-* .. 1534-*).
 *
 * An agent's section patch or body update becomes a row in section_suggestions instead of a document
 * edit when the agent asks for it (patch_section suggest=true) or when the page's lock lets agents
 * only suggest (docs/adr/1532-*). The row keeps the agent's Markdown and the mode it meant; a person
 * who may edit the page accepts it (applied through the normal section patch / body write, as that
 * person, under the edit lock and write gate) or rejects it. Agents can list and withdraw their own,
 * never decide.
 *
 * Notifications (docs/adr/1534-*): approval_request to the page's document owner (else its creator)
 * when a suggestion is made, approval_result to the suggestion's author when it is decided; both
 * queued with the outbox (in the transaction of the row change where there is one).
 */

export type SectionWriteMode = 'replace' | 'append' | 'prepend' | 'insert_after' | 'delete'

/** Why a write became a suggestion: asked, the lock, the agent edit policy, or a suggest-only connection (docs/adr/2041-*). */
export type SuggestionOrigin = 'asked' | 'lock' | 'policy' | 'taint'

interface Row {
  id: string
  workspaceId: string
  pageId: string
  anchor: string
  blockId: string | null
  headingPath: string
  baseVersion: string | null
  markdown: string
  mode: SuggestionMode
  origin: SuggestionOrigin
  status: SuggestionStatus
  authorId: string
  authorName: string
  via: string | null
  connection: string
  decidedBy: string | null
  deciderName: string | null
  decidedAt: string | null
  rule: string | null
  reviewReason: string | null
  autoAt: string | null
  createdAt: string
  /** accepted_partial: the decision record kept in plugin_storage (docs/adr/1622-*). */
  partialValue: string | null
  /** superseded: the next suggestion of the same connection for the same section. */
  supersededBy: string | null
}

const SELECT = sql`
  SELECT s.id, s.workspace_id AS "workspaceId", s.page_id AS "pageId", s.anchor, s.block_id AS "blockId",
         s.heading_path AS "headingPath", s.base_version AS "baseVersion", s.markdown, s.mode, s.origin, s.status,
         s.author_id AS "authorId", a.name AS "authorName", s.via, s.connection, s.decided_by AS "decidedBy",
         d.name AS "deciderName", s.decided_at AS "decidedAt", s.rule, s.review_reason AS "reviewReason", s.auto_at AS "autoAt",
         s.created_at AS "createdAt", CASE WHEN s.status = 'accepted_partial' THEN ps.value END AS "partialValue",
         CASE WHEN s.status = 'superseded' THEN (
           SELECT n.id FROM section_suggestions n
            WHERE n.page_id = s.page_id AND n.anchor = s.anchor AND n.author_id = s.author_id AND n.connection = s.connection
              AND n.created_at > s.created_at
            ORDER BY n.created_at, n.id LIMIT 1) END AS "supersededBy"
    FROM section_suggestions s
    JOIN users a ON a.id = s.author_id
    LEFT JOIN users d ON d.id = s.decided_by
    LEFT JOIN plugin_storage ps ON ps.plugin_id = ${SUGGESTION_BASE_STORE} AND ps.user_id = s.author_id AND ps.key = s.id::text`

const iso = (v: string | Date | null): string | null => (v === null ? null : new Date(v).toISOString())

function toDto(r: Row): SuggestionDTO {
  return {
    id: r.id,
    pageId: r.pageId,
    workspaceId: r.workspaceId,
    anchor: r.anchor,
    headingPath: r.headingPath,
    blockId: r.blockId,
    mode: r.mode,
    origin: r.origin,
    status: r.status,
    markdown: r.markdown,
    baseVersion: r.baseVersion,
    author: { id: r.authorId, name: r.authorName },
    via: r.via,
    createdAt: iso(r.createdAt)!,
    decidedBy: r.decidedBy ? { id: r.decidedBy, name: r.deciderName ?? '' } : null,
    decidedAt: iso(r.decidedAt),
    rule: r.status === 'accepted' ? r.rule : null,
    reviewReason: r.reviewReason,
    autoAt: r.status === 'open' ? iso(r.autoAt) : null,
    ...(r.status === 'accepted_partial' ? { partial: parsePartial(r.partialValue) } : {}),
    ...(r.status === 'superseded' ? { supersededBy: r.supersededBy } : {}),
  }
}

/** The suggestion row the auto-accept sweeper works on (docs/adr/1545-*). */
export async function loadRowForRules(id: string): Promise<Row | null> {
  return loadRow(id)
}

async function loadRow(id: string): Promise<Row | null> {
  const rows = (await db.execute(sql`${SELECT} WHERE s.id = ${id}`)) as unknown as Row[]
  return rows[0] ?? null
}

/** The section `ref` names now (anchor, heading text/path or block id; an old anchor follows a rename). */
async function locateSection(pageId: string, ref: string): Promise<OutlineSection | null> {
  const outline = await readOutline(pageId)
  const direct = findSection(outline, ref)
  if (direct) return direct
  const moved = await resolveMovedSection(pageId, ref, outline.map((s) => s.anchor))
  if (moved.status === 'moved') return outline.find((s) => s.anchor === moved.anchor) ?? null
  if (moved.status === 'ambiguous') {
    throw new AppError(409, 'SECTION_AMBIGUOUS', `Section "${ref}" was renamed and now matches several sections: ${moved.anchors.join(', ')}. Use one of these anchors.`)
  }
  return null
}

/** The suggestion's section now: by heading block id first (stable across renames), then by anchor. */
async function currentSectionOf(r: Pick<Row, 'pageId' | 'anchor' | 'blockId'>): Promise<OutlineSection | null> {
  if (r.blockId) {
    const s = (await readOutline(r.pageId)).find((x) => x.blockId === r.blockId)
    if (s) return s
  }
  return locateSection(r.pageId, r.anchor).catch(() => null)
}

async function pageStamp(pageId: string): Promise<string> {
  const [r] = (await db.execute(sql`SELECT updated_at AS "u" FROM pages WHERE id = ${pageId}`)) as unknown as { u: string }[]
  return r ? new Date(r.u).toISOString() : ''
}

// ---------------------------------------------------------------------------
// creating
// ---------------------------------------------------------------------------

export interface SuggestInput {
  user: AuthUser
  page: PageRow
  /** Section reference; null = the whole body (update_page). */
  ref: string | null
  markdown: string
  mode: SuggestionMode
  baseVersion?: string
  origin: SuggestionOrigin
  policy?: EffectivePolicy | null
}

export interface SuggestItem {
  ref: string | null
  markdown: string
  mode: SuggestionMode
  baseVersion?: string
}

interface Prepared {
  anchor: string
  blockId: string | null
  headingPath: string
  base: string | null
  markdown: string
  mode: SuggestionMode
  /** The section as the agent read it (replace only, when baseVersion is the version now): docs/adr/1621-*. */
  baseMarkdown: string | null
}

/** Resolves and checks one suggestion before any row is written (refused like the direct write). */
async function prepare(user: AuthUser, page: PageRow, i: SuggestItem, resolveTitle: Awaited<ReturnType<typeof buildTitleResolver>>): Promise<Prepared> {
  if (i.mode !== 'delete' && !i.markdown.trim()) throw badRequest('markdown is empty; use mode=delete to suggest removing a section')
  let anchor = ''
  let blockId: string | null = null
  let headingPath = ''
  let base: string | null
  let baseMarkdown: string | null = null
  if (i.ref !== null) {
    const s = await locateSection(page.id, i.ref)
    if (!s) {
      const list = (await readOutline(page.id)).slice(0, 30).map((x) => x.anchor).join(', ')
      throw new AppError(404, 'SECTION_NOT_FOUND', `Section "${i.ref}" not found. Available anchors: ${list || '(none: the page has no headings)'}`)
    }
    anchor = s.anchor
    blockId = s.blockId
    headingPath = joinPath(s.headingPath)
    base = i.baseVersion ?? s.version
    if (i.mode === 'replace' && base === s.version) {
      const r = await readSection(page.id, s.anchor)
      if (r.found && r.section.version === s.version) baseMarkdown = r.markdown
    }
  } else {
    base = await pageStamp(page.id)
  }
  // The same conversion check as a direct write: a suggestion that cannot be applied is refused now.
  if (i.mode !== 'delete') {
    const blocks = await markdownToBlocks(stripFrontmatter(i.markdown), resolveTitle)
    if (blocks.length) blocksToStateBuffer(blocks)
  }
  return { anchor, blockId, headingPath, base, markdown: i.markdown, mode: i.mode, baseMarkdown }
}

/** Creates a suggestion (superseding the same connection's open one for that section). */
export async function createSuggestion(i: SuggestInput): Promise<SuggestionDTO> {
  const [one] = await createSuggestions(i.user, i.page, [{ ref: i.ref, markdown: i.markdown, mode: i.mode, baseVersion: i.baseVersion }], i.origin, i.policy ?? null)
  return one
}

/**
 * Creates several suggestions on one page in ONE transaction, all or none (patch_sections with
 * suggest, docs/adr/1538-*): every item is resolved and checked first, then the rows (and one
 * approval_request for the batch) are written together under the write gate. Two items for the
 * same section are refused (the second would supersede the first).
 */
export async function createSuggestions(
  user: AuthUser,
  page: PageRow,
  items: SuggestItem[],
  origin: SuggestionOrigin,
  policy: EffectivePolicy | null = null,
): Promise<SuggestionDTO[]> {
  if (page.kind !== 'doc') throw badRequest('Only document pages take suggestions')
  if (!items.length) return []
  const resolveTitle = await buildTitleResolver(page.workspaceId, new Map(), user.id)
  const prepared: Prepared[] = []
  for (const i of items) prepared.push(await prepare(user, page, i, resolveTitle))
  const seen = new Set<string>()
  for (const p of prepared) {
    if (seen.has(p.anchor)) throw badRequest(`§${p.anchor || '(whole page)'} is suggested twice; combine them into one edit`)
    seen.add(p.anchor)
  }
  const conn = connectionKey(user)
  const [meta] = (await db.execute(sql`SELECT owner_id AS "ownerId", created_by AS "createdBy" FROM pages WHERE id = ${page.id}`)) as unknown as {
    ownerId: string | null
    createdBy: string | null
  }[]
  const reviewer = meta?.ownerId ?? meta?.createdBy ?? null
  const anchors = prepared.map((p) => p.anchor)
  // The agent edit policy (docs/adr/1544-*, 1545-*): what each suggestion becomes. Asking for a
  // suggestion (suggest=true) is never auto-accepted.
  type Fate = { kind: 'now'; anchor: string } | { kind: 'later'; anchor: string } | { kind: 'review'; reason: string | null }
  const fates: Fate[] = []
  // A suggest-only connection's suggestions wait for a person, whatever the policy (docs/adr/2041-*).
  const taint = origin === 'taint' ? await demotionIn(page.workspaceId) : null
  const taintReason = origin === 'taint' ? (taint ? taintReviewReason(taint) : 'this connection recently read content flagged as a possible prompt injection') : null
  if (origin === 'taint') policy = null
  for (const p of prepared) {
    if (origin === 'taint') fates.push({ kind: 'review', reason: taintReason })
    else if (origin === 'asked' || !policy) fates.push({ kind: 'review', reason: null })
    else if (policy.level !== 'auto') {
      fates.push({ kind: 'review', reason: policy.source === 'workspace' ? 'this workspace sends every agent edit to a person' : null })
    } else {
      const like = { workspaceId: page.workspaceId, pageId: page.id, anchor: p.anchor, blockId: p.blockId, baseVersion: p.base, mode: p.mode, markdown: p.markdown } as Row
      const preview = await previewOf(like, user.id)
      const reason = reviewReasonFor({ mode: p.mode, connection: conn, preview }, policy.rules)
      const anchorNow = preview.currentAnchor ?? p.anchor
      fates.push(reason ? { kind: 'review', reason } : policy.rules.graceMinutes > 0 ? { kind: 'later', anchor: anchorNow } : { kind: 'now', anchor: anchorNow })
    }
  }
  const grace = policy?.rules.graceMinutes ?? 0

  const ids = await db.transaction(async (tx) => {
    // Write gate (docs/adr/1150-*, 1151-*): a lock change or agent block either commits first and
    // is seen here, or waits for these rows.
    const fresh = await gateWrite(tx, page.workspaceId, user.id)
    if (!fresh.role) throw forbidden()
    if (!(await suggestionRight(tx, page.id, user.id, fresh.role, fresh.acl))) {
      await assertPageEditable(page.id, user.id, { role: fresh.role, acl: fresh.acl, exec: tx })
      throw forbidden('This connection may not edit or suggest changes on this page')
    }
    const [open] = (await tx.execute(sql`
      SELECT count(*)::int AS n FROM section_suggestions
       WHERE page_id = ${page.id} AND status = 'open'
         AND NOT (anchor IN (SELECT jsonb_array_elements_text(${JSON.stringify(anchors)}::jsonb)) AND author_id = ${user.id} AND connection = ${conn})
    `)) as unknown as { n: number }[]
    if ((open?.n ?? 0) + prepared.length > MAX_OPEN_SUGGESTIONS_PER_PAGE) {
      throw new AppError(429, 'TOO_MANY_SUGGESTIONS', `This page would have more than ${MAX_OPEN_SUGGESTIONS_PER_PAGE} open suggestions; wait until people decide on them`)
    }
    const out: string[] = []
    for (const [k, p] of prepared.entries()) {
      const f = fates[k]
      const gone = (await tx.execute(sql`
        UPDATE section_suggestions SET status = 'superseded', decided_at = now()
         WHERE page_id = ${page.id} AND anchor = ${p.anchor} AND author_id = ${user.id} AND connection = ${conn} AND status = 'open'
        RETURNING id
      `)) as unknown as { id: string }[]
      await dropSuggestionBases(tx, gone.map((g) => g.id))
      const [row] = (await tx.execute(sql`
        INSERT INTO section_suggestions (workspace_id, page_id, anchor, block_id, heading_path, base_version, markdown, mode, origin,
                                         author_id, via, connection, review_reason, auto_at, rule)
        VALUES (${page.workspaceId}, ${page.id}, ${p.anchor}, ${p.blockId}, ${p.headingPath}, ${p.base}, ${p.markdown}, ${p.mode}, ${origin},
                ${user.id}, ${user.via ?? null}, ${conn}, ${f.kind === 'review' ? f.reason : null},
                ${f.kind === 'later' ? sql`now() + make_interval(mins => ${grace})` : null}, ${f.kind === 'later' ? policy!.label : null})
        RETURNING id
      `)) as unknown as { id: string }[]
      out.push(row.id)
      if (p.baseMarkdown !== null && p.base) await storeSuggestionBase(tx, user.id, row.id, p.base, p.baseMarkdown)
    }
    // Suggestions the rule accepts right now need nobody's approval (docs/adr/1545-*).
    const told = prepared.filter((_, k) => fates[k].kind !== 'now')
    if (reviewer && told.length) {
      // The reviewer may be the author (their own agent on their own page): still told, with no actor,
      // because the engine never notifies an event's actor (docs/adr/1534-*). One event per batch.
      const first = told[0]
      const later = fates.some((f) => f.kind === 'later') ? `auto-accepted in ${grace} min unless rejected: ` : ''
      const n = notifyOutboxRow({
        workspaceId: page.workspaceId,
        pageId: page.id,
        actorId: reviewer === user.id ? null : user.id,
        via: user.via ?? null,
        recipients: [{ userId: reviewer, kind: 'approval_request', reason: 'direct' }],
        anchor: first.anchor || null,
        excerpt:
          later +
          (told.length > 1
            ? `${told.length} suggested edits: ${told.map((p) => (p.anchor ? `§${p.anchor}` : 'whole page')).join(', ')}`
            : first.mode === 'delete'
              ? `(remove §${first.anchor})`
              : first.markdown),
      })
      if (n) await enqueue(tx, [n])
    }
    return out
  })
  if (reviewer && prepared.some((_, k) => fates[k].kind !== 'now')) outboxCommitted(['notify'])
  const out: SuggestionDTO[] = []
  for (const [k, id] of ids.entries()) {
    const f = fates[k]
    let applied: SuggestionDTO['applied'] = undefined
    if (f.kind === 'now') {
      const row = (await loadRow(id))!
      const r = await applyByRule(row, f.anchor, policy!.label, policy!.setter)
      if (r.ok) applied = r.anchor && r.version ? { anchor: r.anchor, version: r.version } : null
      else if (reviewer) {
        // Not applied after all (the section moved on): now it needs a person.
        notify({
          workspaceId: page.workspaceId,
          pageId: page.id,
          actorId: reviewer === user.id ? null : user.id,
          via: user.via ?? null,
          recipients: [{ userId: reviewer, kind: 'approval_request', reason: 'direct' }],
          anchor: prepared[k].anchor || null,
          excerpt: prepared[k].markdown,
        })
      }
    }
    const dto = toDto((await loadRow(id))!)
    if (applied !== undefined) dto.applied = applied
    out.push(dto)
  }
  return out
}

/**
 * For a write that may become suggestions (patch_sections, docs/adr/1538-*): 'asked' when the agent
 * asked (after "may it suggest at all"), 'lock' when the "suggestions only" lock applies to this
 * agent, null when it writes directly (the edit check passed). Throws the usual refusal otherwise.
 */
export async function suggestionMode(
  user: AuthUser,
  page: PageRow,
  access: CheckedAccess,
  suggest: boolean | undefined,
): Promise<{ origin: SuggestionOrigin; policy: EffectivePolicy | null } | null> {
  // A connection that read flagged content (docs/adr/2040-*, 2041-*): what it may edit or suggest
  // becomes a suggestion that no auto-accept rule takes — asked, under a lock or under a policy alike.
  const taint = await demotionIn(page.workspaceId)
  if (taint) {
    const right = await suggestionRight(db, page.id, user.id, access.role, access.acl)
    // Neither: the lock's / the person's own refusal (assertCan walks before the suggest-only check).
    if (!right) await assertPageEditable(page.id, user.id, { role: access.role, acl: access.acl })
    return { origin: 'taint', policy: null }
  }
  if (suggest) {
    const right = await suggestionRight(db, page.id, user.id, access.role, access.acl)
    if (!right) await assertPageEditable(page.id, user.id, { role: access.role, acl: access.acl })
    return { origin: 'asked', policy: null }
  }
  try {
    await assertPageEditable(page.id, user.id, { role: access.role, acl: access.acl })
  } catch (err) {
    if (err instanceof AppError && err.code === 'PAGE_LOCKED' && currentAgent()) {
      const right = await suggestionRight(db, page.id, user.id, access.role, access.acl).catch(() => null)
      if (right === 'suggest') {
        // an "auto" lock node accepts by its rules; "suggestions only" (or a direct node below one) waits
        const policy = await effectivePolicy(page)
        return { origin: 'lock', policy: policy.level === 'auto' ? policy : null }
      }
    }
    throw err
  }
  // The agent may edit: the agent edit policy decides whether it writes (docs/adr/1544-*).
  if (!currentAgent()) return null
  const policy = await effectivePolicy(page)
  return policy.level === 'direct' ? null : { origin: 'policy', policy }
}

/**
 * Entry check of an agent-facing write (patch_section / update_page, docs/adr/1531-*, 1532-*, 1536-*):
 * - `suggest` asked: the write becomes a suggestion (no edit check beyond "may suggest");
 * - the lock allows this agent only suggestions: the write becomes a suggestion;
 * - otherwise the usual edit check, then the section-claim check for bearer connections.
 * Returns the suggestion when one was made (the caller answers 202 with it), else null (write on).
 */
export async function suggestOrCheck(
  user: AuthUser,
  page: PageRow,
  access: CheckedAccess,
  w: { ref: string | null; markdown: string; mode: SuggestionMode; baseVersion?: string; suggest?: boolean },
): Promise<SuggestionDTO | null> {
  const how = await suggestionMode(user, page, access, w.suggest)
  if (how) return createSuggestion({ user, page, ref: w.ref, markdown: w.markdown, mode: w.mode, baseVersion: w.baseVersion, origin: how.origin, policy: how.policy })
  // An append to the body leaves every section as it is: claims do not stop it.
  if (w.mode !== 'page_append') await assertNotClaimed(user, page.id, w.ref)
  return null
}

// ---------------------------------------------------------------------------
// reading
// ---------------------------------------------------------------------------

async function normalized(r: Row, viewerId: string): Promise<{ text: string; leadingHeading: boolean }> {
  if (r.mode === 'delete') return { text: '', leadingHeading: false }
  const resolveTitle = await buildTitleResolver(r.workspaceId, new Map(), viewerId)
  const blocks = await markdownToBlocks(stripFrontmatter(r.markdown), resolveTitle)
  const { markdown } = await blocksToMarkdown(blocks, { assetMode: 'absolute', notation: 'agent' })
  return { text: markdown.trim(), leadingHeading: blocks[0]?.type === 'heading' }
}

/** The section (or body) now and with the suggestion applied, as Markdown, with a line diff. */
export async function previewOf(r: Row, viewerId: string): Promise<SuggestionPreviewDTO> {
  const p = await normalized(r, viewerId)
  const join = (...parts: string[]) => parts.filter((x) => x !== '').join('\n\n')
  let before = ''
  let after = ''
  let found = true
  let currentAnchor: string | null = null
  let currentVersion: string | null = null
  let changed = false
  if (r.anchor === '') {
    const { markdown } = await blocksToMarkdown(await currentBlocks(r.pageId), { assetMode: 'absolute', notation: 'agent' })
    before = markdown.trim()
    after = r.mode === 'page_replace' ? p.text : join(before, p.text)
    currentVersion = await pageStamp(r.pageId)
    changed = r.baseVersion !== currentVersion
  } else {
    const s = await currentSectionOf(r)
    if (!s) {
      found = false
      changed = true
      after = r.mode === 'delete' ? '' : p.text
    } else {
      currentAnchor = s.anchor
      currentVersion = s.version
      changed = r.baseVersion !== s.version
      const sec = await readSection(r.pageId, s.anchor)
      before = sec.found ? sec.markdown : ''
      const nl = before.indexOf('\n')
      const heading = s.level > 0 ? (nl === -1 ? before : before.slice(0, nl)) : ''
      const body = s.level > 0 ? (nl === -1 ? '' : before.slice(nl + 1).trim()) : before
      switch (r.mode) {
        case 'replace':
          after = p.leadingHeading && s.level > 0 ? p.text : join(heading, p.text)
          break
        case 'append':
        case 'insert_after':
          after = join(before, p.text)
          break
        case 'prepend':
          after = join(heading, p.text, body)
          break
        case 'delete':
          after = ''
          break
        default:
          after = join(before, p.text)
      }
    }
  }
  const ops = diffOps(before, after)
  return { found, currentAnchor, currentVersion, changed, before, after, ops, large: ops === null }
}

/** The preview plus, for `replace`, the hunks checked against people's edits (docs/adr/1621-*). */
async function previewWithMerge(r: Row, viewerId: string): Promise<SuggestionPreviewDTO> {
  const p = await previewOf(r, viewerId)
  if (r.mode === 'replace' && p.found && p.currentAnchor) {
    const m = await suggestionMerge(r, viewerId, p.currentAnchor).catch((err) => {
      console.error('[inkling] suggestion merge failed', r.id, err)
      return null
    })
    p.merge = m ? m.dto : null
  }
  return p
}

/** Suggestions of a page (the caller checked that `viewer` may see the page). */
export async function pageSuggestions(
  pageId: string,
  viewerId: string,
  opts: { preview?: boolean; all?: boolean; status?: SuggestionStatusFilter } = {},
): Promise<SuggestionDTO[]> {
  // `all=1` is the web history's view (everything but superseded); `status` the shared filter (docs/adr/1626-*).
  const where = opts.status ? statusSql(opts.status) : opts.all ? sql`s.status <> 'superseded'` : sql`s.status = 'open'`
  const rows = (await db.execute(sql`
    ${SELECT}
     WHERE s.page_id = ${pageId} AND ${where}
     ORDER BY s.created_at, s.id
     LIMIT 200
  `)) as unknown as Row[]
  const out: SuggestionDTO[] = []
  for (const r of rows) {
    const dto = toDto(r)
    if (opts.preview && r.status === 'open') dto.preview = await previewWithMerge(r, viewerId)
    out.push(dto)
  }
  return out
}

/** SQL condition of a status filter (docs/adr/1626-*): the same for a page's list and the caller's own. */
export function statusSql(f: SuggestionStatusFilter) {
  if (f === 'all') return sql`true`
  if (f === 'decided') return sql`s.status IN ('accepted', 'accepted_partial', 'rejected')`
  return sql`s.status = ${f}`
}

/**
 * The caller's own suggestions with the given status (default open), on pages they can still
 * see, newest first, at most 50 (list_suggestions without a page). Same filter as a page's list.
 */
export async function mySuggestions(user: AuthUser, status: SuggestionStatusFilter = 'open'): Promise<SuggestionDTO[]> {
  const rows = (await db.execute(sql`
    ${SELECT}
     WHERE s.author_id = ${user.id} AND ${statusSql(status)}
     ORDER BY s.created_at DESC, s.id
     LIMIT 50
  `)) as unknown as Row[]
  const ok = new Map<string, boolean>()
  const out: SuggestionDTO[] = []
  for (const r of rows) {
    if (!ok.has(r.pageId)) ok.set(r.pageId, await canSee(r.pageId, user.id))
    if (ok.get(r.pageId)) out.push(toDto(r))
  }
  return out
}

/** Visible page + membership (2FA, agent blocks, range included); guests are not shown suggestions. */
async function canSee(pageId: string, userId: string): Promise<boolean> {
  const page = await findVisiblePage(pageId, userId)
  if (!page) return false
  try {
    await requireMembershipAcl(page.workspaceId, userId)
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// deciding
// ---------------------------------------------------------------------------

/** Guard for accept/reject: a person (browser session or personal API token), never an agent. */
function assertPerson(): void {
  if (currentAgent()) {
    throw new AppError(403, 'PEOPLE_DECIDE', 'Only a person can accept or reject suggestions (in the web app or with a personal API token), not an agent connection')
  }
}

/**
 * Why a suggestion can no longer be withdrawn or decided, in words that fit its state
 * (docs/adr/1626-*): replaced by which newer suggestion, decided by whom, or already withdrawn.
 */
function notOpen(row: Row): AppError {
  if (row.status === 'superseded') {
    const next = row.supersededBy ? `your newer suggestion ${row.supersededBy}` : 'a newer suggestion'
    return new AppError(409, 'SUGGESTION_SUPERSEDED', `This suggestion was replaced by ${next} for ${row.anchor ? `§${row.anchor}` : 'the whole page'}; nothing changed`)
  }
  if (row.status === 'withdrawn') return new AppError(409, 'SUGGESTION_WITHDRAWN', 'This suggestion was already withdrawn; nothing changed')
  const by = row.rule && row.status === 'accepted' ? `a rule (${row.rule})` : (row.deciderName ?? 'someone')
  return new AppError(409, 'SUGGESTION_DECIDED', `This suggestion was already ${row.status.replace('_', ' ')} by ${by}`)
}

async function guardDecision(id: string, user: AuthUser): Promise<{ row: Row; page: PageRow; access: CheckedAccess }> {
  assertPerson()
  const row = await loadRow(id)
  if (!row) throw notFound()
  const page = await findVisiblePage(row.pageId, user.id)
  if (!page) throw notFound()
  const access = await requireMembershipAcl(page.workspaceId, user.id)
  await assertPageEditable(page.id, user.id, { role: access.role, acl: access.acl })
  if (row.status !== 'open') throw notOpen(row)
  return { row, page, access }
}

function resultEvent(row: Row, decider: AuthUser, status: 'accepted' | 'rejected' | 'accepted_partial', partial?: { applied: number; total: number }) {
  return {
    workspaceId: row.workspaceId,
    pageId: row.pageId,
    // The author deciding on their own agent's suggestion still hears about it (the agent reads the inbox).
    actorId: row.authorId === decider.id ? null : decider.id,
    via: null,
    recipients: [{ userId: row.authorId, kind: 'approval_result' as const, reason: 'direct' as const }],
    anchor: row.anchor || null,
    excerpt: `${status}${partial ? ` (${partial.applied} of ${partial.total} changes)` : ''}: suggestion ${row.id} (${row.mode}${row.anchor ? ` §${row.anchor}` : ''})`,
  }
}

export async function rejectSuggestion(id: string, user: AuthUser): Promise<SuggestionDTO> {
  const { row } = await guardDecision(id, user)
  const done = await db.transaction(async (tx) => {
    const r = (await tx.execute(sql`
      UPDATE section_suggestions SET status = 'rejected', decided_by = ${user.id}, decided_at = now()
       WHERE id = ${id} AND status = 'open' RETURNING id
    `)) as unknown as unknown[]
    if (!r.length) return false
    await dropSuggestionBases(tx, [id])
    const n = notifyOutboxRow(resultEvent(row, user, 'rejected'))
    if (n) await enqueue(tx, [n])
    return true
  })
  if (!done) throw new AppError(409, 'SUGGESTION_DECIDED', 'Someone decided on this suggestion just now')
  outboxCommitted(['notify'])
  return toDto((await loadRow(id))!)
}

/**
 * Accepts a suggestion: applies it to the section as it is NOW (no version check), as `user`, through
 * the same section patch / body write as an agent's direct edit. When the section changed since the
 * agent read it, a first call answers 409 SUGGESTION_CHANGED with the current diff; the person
 * confirms with `confirmChanged`. The row is claimed (status) before the edit so two people cannot
 * apply it twice; a failed edit puts it back to open.
 */
export async function acceptSuggestion(
  id: string,
  user: AuthUser,
  opts: { confirmChanged?: boolean; hunks?: number[]; mergeKey?: string },
  locale: () => Promise<Locale>,
): Promise<SuggestionDTO> {
  const { row, page, access } = await guardDecision(id, user)
  if (opts.hunks !== undefined) return acceptHunks(row, page, access, user, opts.hunks, opts.mergeKey, locale)
  const preview = await previewOf(row, user.id)
  if (row.anchor !== '' && !preview.found) {
    throw new AppError(409, 'SECTION_GONE', `The section "${row.headingPath || row.anchor}" no longer exists; reject the suggestion or apply it by hand`, undefined, { preview })
  }
  if (preview.changed && !opts.confirmChanged) {
    throw new AppError(
      409,
      'SUGGESTION_CHANGED',
      'The section changed after the agent read it. Check the diff against the current text and accept again to apply it anyway.',
      undefined,
      { preview },
    )
  }
  const claimed = (await db.execute(sql`
    UPDATE section_suggestions SET status = 'accepted', decided_by = ${user.id}, decided_at = now()
     WHERE id = ${id} AND status = 'open' RETURNING id
  `)) as unknown as unknown[]
  if (!claimed.length) throw new AppError(409, 'SUGGESTION_DECIDED', 'Someone decided on this suggestion just now')
  try {
    if (row.mode === 'page_replace' || row.mode === 'page_append') {
      await writePageContentAs(user, page, access, { markdown: row.markdown, mode: row.mode === 'page_replace' ? 'replace' : 'append' }, locale)
    } else {
      const r = await patchSectionAs(user, page, access, { ref: preview.currentAnchor ?? row.anchor, markdown: row.markdown, mode: row.mode }, locale)
      if (r.status !== 200) throw new AppError(409, r.body.error.code, r.body.error.message)
    }
  } catch (err) {
    await db.execute(sql`UPDATE section_suggestions SET status = 'open', decided_by = NULL, decided_at = NULL WHERE id = ${id} AND status = 'accepted'`)
    throw err
  }
  await dropSuggestionBases(db, [id])
  notify(resultEvent(row, user, 'accepted'))
  return toDto((await loadRow(id))!)
}

/**
 * Accepts the chosen hunks of a `replace` suggestion (docs/adr/1621-*, 1622-*): the 3-way merge of
 * base (the section as the agent read it), the section now and the suggestion is computed again
 * here — never taken from the client — and must be the one the person looked at (`mergeKey`), else
 * 409 SUGGESTION_CHANGED with the fresh hunks. The merged section is written with the section's
 * version as base version, so typing that lands meanwhile also answers 409 instead of being undone.
 * All effective hunks → `accepted`; some → `accepted_partial` with {applied, total} kept.
 */
async function acceptHunks(
  row: Row,
  page: PageRow,
  access: CheckedAccess,
  user: AuthUser,
  hunks: number[],
  mergeKey: string | undefined,
  locale: () => Promise<Locale>,
): Promise<SuggestionDTO> {
  if (row.mode !== 'replace' || row.anchor === '') throw badRequest('Only section replace suggestions can be accepted in part; accept or reject it whole')
  const preview = await previewOf(row, user.id)
  if (!preview.found || !preview.currentAnchor) {
    throw new AppError(409, 'SECTION_GONE', `The section "${row.headingPath || row.anchor}" no longer exists; reject the suggestion or apply it by hand`, undefined, { preview })
  }
  const m = await suggestionMerge(row, user.id, preview.currentAnchor)
  if (!m) throw new AppError(409, 'SUGGESTION_UNSPLITTABLE', 'This suggestion is too large to split into hunks; accept or reject it whole')
  if (mergeKey !== m.dto.key) {
    preview.merge = m.dto
    throw new AppError(409, 'SUGGESTION_CHANGED', 'The section changed while you were choosing; check the hunks again.', undefined, { preview })
  }
  const known = new Set(m.dto.hunks.map((h) => h.id))
  const chosen = new Set(hunks)
  for (const h of chosen) if (!known.has(h)) throw badRequest(`Unknown hunk ${h}`)
  const effective = m.dto.hunks.filter((h) => !h.same)
  const applied = effective.filter((h) => chosen.has(h.id)).length
  if (applied === 0) throw badRequest('Choose at least one change to apply, or reject the suggestion')
  const status = applied === effective.length ? 'accepted' : 'accepted_partial'
  const claimed = (await db.execute(sql`
    UPDATE section_suggestions SET status = ${status}, decided_by = ${user.id}, decided_at = now()
     WHERE id = ${row.id} AND status = 'open' RETURNING id
  `)) as unknown as unknown[]
  if (!claimed.length) throw new AppError(409, 'SUGGESTION_DECIDED', 'Someone decided on this suggestion just now')
  try {
    const blocks = mergedBlocks(m, chosen)
    const r = await patchSectionAs(user, page, access, { ref: m.section.anchor, markdown: '', blocks, mode: 'replace', baseVersion: m.section.version }, locale)
    if (r.status !== 200) {
      throw new AppError(409, 'SUGGESTION_CHANGED', 'The section changed while you were choosing; check the hunks again.')
    }
  } catch (err) {
    await db.execute(sql`UPDATE section_suggestions SET status = 'open', decided_by = NULL, decided_at = NULL WHERE id = ${row.id} AND status = ${status}`)
    throw err
  }
  const partial = { applied, total: effective.length }
  if (status === 'accepted_partial') await recordPartial(db, row.authorId, row.id, partial)
  else await dropSuggestionBases(db, [row.id])
  notify(resultEvent(row, user, status, status === 'accepted_partial' ? partial : undefined))
  return toDto((await loadRow(row.id))!)
}

/** The author withdraws their own open suggestion (agents may; it is their own). */
export async function withdrawSuggestion(id: string, user: AuthUser): Promise<SuggestionDTO> {
  const row = await loadRow(id)
  if (!row || row.authorId !== user.id || !(await canSee(row.pageId, user.id))) throw notFound()
  if (row.status !== 'open') throw notOpen(row)
  await db.execute(sql`
    UPDATE section_suggestions SET status = 'withdrawn', decided_by = ${user.id}, decided_at = now()
     WHERE id = ${id} AND status = 'open'
  `)
  await dropSuggestionBases(db, [id])
  return toDto((await loadRow(id))!)
}

/** A suggestion visible to `user` (for GET /suggestions/:id). */
export async function suggestionFor(id: string, user: AuthUser, preview: boolean): Promise<SuggestionDTO> {
  const row = await loadRow(id)
  if (!row || !(await canSee(row.pageId, user.id))) throw notFound()
  const dto = toDto(row)
  if (preview && row.status === 'open') dto.preview = await previewWithMerge(row, user.id)
  return dto
}

export { assertPerson }
