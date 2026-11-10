import { and, desc, eq, gt, inArray } from 'drizzle-orm'
import type { AuthUser } from '../auth'
import type { CheckedAccess } from '../aclVersion'
import { hocuspocus } from '../collab'
import { db } from '../db/index'
import { pageSnapshots } from '../db/schema'
import { pageEditGate } from '../docWriteGate'
import { AppError } from '../errors'
import type { Locale } from '../i18n'
import { gatedTransact } from '../md/docWrite'
import { blocksToMarkdown, blocksToStateBuffer, markdownToBlocks, stripFrontmatter } from '../md/convert'
import type { AnyBlock } from '../md/convert'
import { buildTitleResolver } from '../md/importer'
import type { PageRow } from '../pageDto'
import { agentStepEnd, agentStepStart, createSnapshot, currentSnapshotSource } from '../snapshotStore'
import type { StepMeta } from '../snapshotStore'
import { diffOps } from './diff'
import { actorOf, withEditActor } from './attribution'
import { joinPath } from './chunker'
import type { Section } from './chunker'
import { applySectionPatch, buildEchoIndex } from './sectionPatch'
import type { EchoIndex, PatchMode, PatchOutcome } from './sectionPatch'
import { resolveMovedSection } from './sectionMoves'
import { pageMentionKeys, readSectionBlocks } from './sectionSource'
import { isAgentVia } from '../agentVia'

/**
 * One section patch as a given user (docs/adr/0930-*, 0940-*, 1501-*): the core of
 * POST /pages/:id/section, shared with accepting a suggestion (docs/adr/1533-*), which applies the
 * agent's Markdown as the person who accepts it. The caller has done the permission checks
 * (membership, visibility, edit lock) and passes the role + access version it decided on: the
 * document edit itself runs under the write gate (docs/adr/1150-*), which re-checks when they moved.
 */

export interface SectionPatchBody {
  ref: string
  markdown: string
  mode: PatchMode
  baseVersion?: string
  /**
   * The new blocks themselves instead of `markdown` (a merged section: live blocks kept as they are,
   * docs/adr/1621-*). Not parsed; checked for convertibility like parsed Markdown.
   */
  blocks?: AnyBlock[]
}

export type SectionPatchResult =
  | { status: 200; body: { ok: true; section: { anchor: string; headingPath: string; version: string } | null; movedFrom?: string; sections: number } }
  | { status: 409; body: { error: { code: 'SECTION_CONFLICT'; message: string; movedFrom?: string; current: { anchor: string; headingPath: string; version: string; markdown: string } } } }

/** "Before AI edit" snapshots for destructive section patches: at most one per page per 2 minutes. */
const PATCH_SNAPSHOT_WINDOW_MS = 2 * 60_000

/**
 * "Before AI edit" snapshot ahead of a destructive section edit (replace/delete; patch_section,
 * patch_sections, accepting a suggestion): at most one per page per 2 minutes, labelled in the
 * editor's locale. The one place for this rule (docs/adr/0930-*, 1542-*).
 */
export async function beforeAgentEditSnapshot(pageId: string, user: Pick<AuthUser, 'id' | 'via'>, locale: () => Promise<Locale>): Promise<void> {
  const recent = await db
    .select({ id: pageSnapshots.id })
    .from(pageSnapshots)
    .where(
      and(
        eq(pageSnapshots.pageId, pageId),
        inArray(pageSnapshots.label, ['Before AI edit', 'AI 편집 전']),
        gt(pageSnapshots.createdAt, new Date(Date.now() - PATCH_SNAPSHOT_WINDOW_MS)),
      ),
    )
    .orderBy(desc(pageSnapshots.createdAt))
    .limit(1)
  if (recent.length) return
  const before = await currentSnapshotSource(pageId)
  if (!before) return
  const label = (await locale()) === 'ko' ? 'AI 편집 전' : 'Before AI edit'
  await createSnapshot(pageId, before, label, user.id, user.via ?? null)
}

// ---------------------------------------------------------------------------
// AI steps (docs/adr/2180-*, 2181-*): every agent write is one version
// ---------------------------------------------------------------------------

/** Labels of the rows an agent write leaves, in the editor's locale (shown translated by the web). */
async function stepLabels(locale: () => Promise<Locale>): Promise<{ before: string; step: string; beforeRestore: string }> {
  return (await locale()) === 'ko'
    ? { before: 'AI 편집 전', step: 'AI 편집', beforeRestore: '복원 전' }
    : { before: 'Before AI edit', step: 'AI edit', beforeRestore: 'Before restore' }
}

/**
 * One agent write as AI steps: the page before it is a version (the agent's previous step when
 * nothing happened since, else a new "Before AI edit" row), `write` runs, and the page after it is
 * stored as one "AI edit" row with what `write` reports changed (null = nothing written: no step).
 * People's writes (no agent `via`) run as they are. Returns the write's result and the step rows.
 */
export async function asAgentStep<T>(
  pageId: string,
  user: Pick<AuthUser, 'id' | 'via'>,
  locale: () => Promise<Locale>,
  write: () => Promise<{ result: T; step: StepMeta | null }>,
  opts: { beforeLabel?: 'before' | 'beforeRestore' } = {},
): Promise<{ result: T; before: string | null; step: string | null }> {
  if (!isAgentVia(user.via)) return { result: (await write()).result, before: null, step: null }
  const labels = await stepLabels(locale)
  const before = await agentStepStart(pageId, user, labels[opts.beforeLabel ?? 'before'])
  const { result, step } = await write()
  const id = step ? await agentStepEnd(pageId, user, labels.step, step) : null
  return { result, before, step: id }
}

const nonBlank = (s: string) => s.trim() !== ''

/** Markdown lines removed from `before` and added in `after` (non-blank lines; whole sides when over the diff caps). */
export function lineDelta(before: string, after: string): { added: number; removed: number } {
  const ops = diffOps(before, after)
  if (ops) {
    return {
      added: ops.filter((o) => o.t === '+' && nonBlank(o.s)).length,
      removed: ops.filter((o) => o.t === '-' && nonBlank(o.s)).length,
    }
  }
  const lines = (t: string) => t.split('\n').filter(nonBlank).length
  return { added: lines(after), removed: lines(before) }
}

/**
 * Lines one section edit changes: `old` = the section's blocks before (heading first), `incoming` = what
 * is written. A replace whose Markdown has no leading heading keeps the heading: compared without it.
 */
export async function sectionEditDelta(
  mode: PatchMode,
  old: AnyBlock[] | null,
  incoming: AnyBlock[],
): Promise<{ added: number; removed: number }> {
  const md = async (blocks: AnyBlock[]) =>
    blocks.length ? (await blocksToMarkdown(blocks, { assetMode: 'absolute', notation: 'agent' })).markdown.trim() : ''
  if (mode === 'delete') return lineDelta(await md(old ?? []), '')
  if (mode !== 'replace') return lineDelta('', await md(incoming))
  let before = old ?? []
  if (before[0]?.type === 'heading' && incoming[0]?.type !== 'heading') before = before.slice(1)
  return lineDelta(await md(before), await md(incoming))
}

/** At most three section anchors and how many more (step rows name what they touched). */
export function stepSections(anchors: string[]): Pick<StepMeta, 'sections' | 'more'> {
  const list = [...new Set(anchors)]
  return { sections: list.slice(0, 3), ...(list.length > 3 ? { more: list.length - 3 } : {}) }
}

export async function sectionMarkdown(blocks: AnyBlock[], s: Section): Promise<string> {
  const { markdown } = await blocksToMarkdown(blocks.slice(s.start, s.end), { assetMode: 'absolute', notation: 'agent' })
  return markdown.trim()
}

/** The renamed section's new anchor, or the error for a miss (docs/adr/1501-*). */
export async function movedOrThrow(pageId: string, ref: string, sections: { anchor: string }[]): Promise<string> {
  const moved = await resolveMovedSection(pageId, ref, sections.map((s) => s.anchor))
  if (moved.status === 'moved') return moved.anchor
  if (moved.status === 'ambiguous') {
    return Promise.reject(
      new AppError(
        409,
        'SECTION_AMBIGUOUS',
        `Section "${ref}" was renamed and now matches several sections: ${moved.anchors.join(', ')}. Use one of these anchors.`,
      ),
    )
  }
  return Promise.reject(sectionNotFound(ref, sections))
}

export function sectionNotFound(ref: string, sections: { anchor: string }[]): AppError {
  const list = sections.slice(0, 30).map((s) => s.anchor).join(', ')
  return new AppError(
    404,
    'SECTION_NOT_FOUND',
    `Section "${ref}" not found. Available anchors: ${list || '(none: the page has no headings)'}`,
  )
}


export async function patchSectionAs(
  user: AuthUser,
  page: PageRow,
  access: CheckedAccess,
  body: SectionPatchBody,
  locale: () => Promise<Locale>,
): Promise<SectionPatchResult> {
  const id = page.id
  const resolveTitle = await buildTitleResolver(page.workspaceId, new Map(), user.id)
  // Mention chips already in the page may be kept or moved, not created (docs/adr/1500-*).
  const notation = { mentions: await pageMentionKeys(id, body.markdown) }
  const incoming =
    body.mode === 'delete' ? [] : body.blocks ? body.blocks : await markdownToBlocks(stripFrontmatter(body.markdown), resolveTitle, undefined, notation)
  // Full convertibility check on a throwaway doc before touching the live one.
  if (incoming.length) blocksToStateBuffer(incoming)

  // An agent write is one AI step (docs/adr/2180-*); a person's destructive patch (accepting a
  // suggestion) keeps the "Before AI edit" undo point of docs/adr/0930-*.
  const agent = isAgentVia(user.via)
  if (!agent && (body.mode === 'replace' || body.mode === 'delete')) await beforeAgentEditSnapshot(id, user, locale)
  // What the section held before, for the step's line counts (replace/delete only).
  const old = agent && (body.mode === 'replace' || body.mode === 'delete') ? await readSectionBlocks(id, body.ref) : null

  const attempt = async (ref: string): Promise<PatchOutcome> => {
    // What the agent saw of each block (Markdown round trip), so untouched blocks stay untouched.
    // Computed before the synchronous patch; blocks that changed in between are simply diffed.
    let echo: EchoIndex | null = null
    if (body.mode === 'replace') {
      const r = await readSectionBlocks(id, ref)
      if (r.found) echo = await buildEchoIndex(r.blocks, resolveTitle, notation, incoming)
    }
    let outcome: PatchOutcome | null = null
    await withEditActor([id], actorOf(user), async () => {
      const conn = await hocuspocus.openDirectConnection(id)
      try {
        // The patch is applied under the write gate (docs/adr/1150-*); the store runs after it.
        const gate = pageEditGate(id, page.workspaceId, user.id, access)
        await gatedTransact(conn, (doc) => {
          outcome = applySectionPatch(doc, ref, incoming, body.mode, body.baseVersion, echo)
        }, gate)
      } finally {
        await conn.disconnect()
      }
    })
    const out = outcome as PatchOutcome | null
    if (!out) throw new AppError(500, 'INTERNAL', 'Patch did not run')
    return out
  }
  const run = async () => {
    let res = await attempt(body.ref)
    // An anchor from before a heading rename patches the section under its new anchor (docs/adr/1501-*).
    // Nothing was written by the missed attempt; the version check still applies to the section found.
    let movedFrom: string | undefined
    if (res.status === 'not_found') {
      const anchor = await movedOrThrow(id, body.ref, res.sections)
      res = await attempt(anchor)
      if (res.status === 'not_found') throw sectionNotFound(body.ref, res.sections)
      movedFrom = body.ref
    }
    let step: StepMeta | null = null
    if (res.status === 'ok' && agent) {
      const anchor = res.section?.anchor ?? (old?.found ? old.section.anchor : body.ref)
      step = { tool: 'patch_section', mode: body.mode, ...stepSections([anchor]), ...(await sectionEditDelta(body.mode, old?.found ? old.blocks : null, incoming)) }
    }
    return { result: { res, movedFrom }, step }
  }
  const {
    result: { res, movedFrom },
  } = await asAgentStep(id, user, locale, run)
  if (res.status === 'conflict') {
    const markdown = await sectionMarkdown(res.blocks, res.section)
    return {
      status: 409,
      body: {
        error: {
          code: 'SECTION_CONFLICT',
          message: movedFrom
            ? `Section "${movedFrom}" was renamed to "${res.section.anchor}" (its version includes the heading, so it changed since baseVersion ${body.baseVersion}); nothing was written. Check the current content and retry with section "${res.section.anchor}" and baseVersion ${res.section.version}.`
            : `Section "${res.section.anchor}" changed since baseVersion ${body.baseVersion}; nothing was written. Merge your edit into the current content and retry with baseVersion ${res.section.version}.`,
          ...(movedFrom ? { movedFrom } : {}),
          current: {
            anchor: res.section.anchor,
            headingPath: joinPath(res.section.headingPath),
            version: res.section.version,
            markdown,
          },
        },
      },
    }
  }
  return {
    status: 200,
    body: {
      ok: true,
      section: res.section
        ? { anchor: res.section.anchor, headingPath: joinPath(res.section.headingPath), version: res.section.version }
        : null,
      ...(movedFrom ? { movedFrom } : {}),
      sections: res.sections.length,
    },
  }
}
