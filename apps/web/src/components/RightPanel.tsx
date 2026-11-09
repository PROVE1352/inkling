import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import type { CollectionField, PageMetaDTO } from '@inkling/shared'
import {
  ApiError,
  useBacklinks,
  useCollection,
  useComments,
  useMembers,
  usePages,
  useSnapshots,
  useUnlinked,
  useUpdateFields,
  useUpdatePage,
  useUpdateProps,
} from '../api'
import { t, useT } from '../i18n'
import { consumePropsFocus } from '../lib/propsFocus'
import { reloadOnceForStaleChunk } from '../lib/pwa'
import { revealBlock } from '../lib/headingFolds'
import { computeOutline, type Outline } from '../lib/docOutline'
import { kindLabel } from '../lib/pageIcon'
import { PageIconGlyph } from './PageIconGlyph'
import { OPTION_COLORS } from '../lib/optionColors'
import { formatDateTime, relativeTime } from '../lib/time'
import type { InklingEditor } from './CollabEditor'
import { FieldCell } from './collection/cells/FieldCell'
import { CommentsPanel } from './comments/CommentsPanel'
import { HistoryModal, snapLabel } from './HistoryModal'
import { PageChanges } from './PageChanges'
import { PageReviewCard } from './PageReview'
import { SaveAsTemplateModal } from './SaveAsTemplateModal'
import {
  ChevronRightIcon,
  HistoryIcon,
  LinkIcon,
  LockIcon,
  TemplateIcon,
  UsersIcon,
  XIcon,
} from './Icons'

const EMPTY_OUTLINE: Outline = { headings: [], outgoingIds: [], tags: [] }

// ---------------------------------------------------------------------------
// Accordion section
// ---------------------------------------------------------------------------

function Section({
  title,
  count,
  open,
  onToggle,
  children,
  anchor,
}: {
  title: string
  count?: number
  open: boolean
  onToggle: () => void
  children: React.ReactNode
  /** Marker used by the shortcut (⌘;) to find this section */
  anchor?: string
}) {
  return (
    <div className="border-b border-line" data-panel-section={anchor}>
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-sub hover:text-ink"
      >
        <span
          className={`inline-flex transition-transform duration-200 ease-out ${
            open ? 'rotate-90' : ''
          }`}
        >
          <ChevronRightIcon size={13} />
        </span>
        <span className="flex-1">{title}</span>
        {count !== undefined && count > 0 && (
          <span className="text-[11px] font-normal text-sub" title={t('rightPanel.itemCount', { count })}>
            {count}
          </span>
        )}
      </button>
      {/* Smooth collapse/expand via a grid-rows 0fr↔1fr transition (avoids animating height) */}
      <div
        className={`grid transition-[grid-template-rows] duration-[180ms] ease-out ${
          open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
        }`}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="px-3 pb-3">{children}</div>
        </div>
      </div>
    </div>
  )
}

const SECTION_KEYS = [
  'outline',
  'comments',
  'backlinks',
  'unlinked',
  'outgoing',
  'tags',
  'localGraph',
  'aliases',
  'history',
  'props',
  'review',
] as const
type SectionKey = (typeof SECTION_KEYS)[number]

function loadSectionState(): Record<SectionKey, boolean> {
  const def: Record<SectionKey, boolean> = {
    outline: true,
    comments: true,
    backlinks: true,
    // Unlinked mentions / local graph start collapsed — fetch and the heavy graph mount only happen when opened.
    unlinked: false,
    outgoing: true,
    tags: true,
    localGraph: false,
    aliases: true,
    history: true,
    props: true,
    review: true,
  }
  try {
    const raw = localStorage.getItem('inkling:rightPanel:sections')
    if (raw) return { ...def, ...(JSON.parse(raw) as Partial<Record<SectionKey, boolean>>) }
  } catch {
    // ignore
  }
  return def
}

// Alias chip editor — Enter/comma adds, x removes → updatePage({ aliases }). Read-only (edit lock): chips only.
// Trim, dedupe (case-insensitive), drop empties, max 20 (the UI applies the same rules as the server).
function AliasEditor({
  wsId,
  page,
  readOnly = false,
}: {
  wsId: string
  page: PageMetaDTO
  readOnly?: boolean
}) {
  const tr = useT()
  const updatePage = useUpdatePage(wsId)
  const [input, setInput] = useState('')
  const aliases = page.aliases ?? []

  const commit = (next: string[]) => {
    const clean: string[] = []
    const seen = new Set<string>()
    for (const a of next) {
      const v = a.trim()
      if (!v) continue
      const key = v.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      clean.push(v)
    }
    updatePage.mutate({ id: page.id, input: { aliases: clean.slice(0, 20) } })
  }

  const add = () => {
    if (!input.trim()) return
    commit([...aliases, ...input.split(',')])
    setInput('')
  }
  const remove = (a: string) => commit(aliases.filter((x) => x !== a))

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap gap-1.5">
        {aliases.length === 0 && <span className="text-xs text-sub">{tr('common.none')}</span>}
        {aliases.map((a) => (
          <span
            key={a}
            className="flex items-center gap-1 rounded-full bg-accent-soft px-2 py-0.5 text-xs text-accent"
          >
            {a}
            {!readOnly && (
              <button
                type="button"
                onClick={() => remove(a)}
                aria-label={tr('rightPanel.removeAlias', { name: a })}
                className="leading-none hover:opacity-70"
              >
                <XIcon size={11} />
              </button>
            )}
          </span>
        ))}
      </div>
      {!readOnly && (
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault()
              add()
            } else if (e.key === 'Backspace' && input === '' && aliases.length > 0) {
              remove(aliases[aliases.length - 1])
            }
          }}
          onBlur={add}
          placeholder={tr('rightPanel.addAlias')}
          className="w-full rounded border border-line bg-transparent px-2 py-1 text-xs text-ink placeholder:text-sub/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        />
      )}
    </div>
  )
}

// ⌘; "add property" request flag lives in lib/propsFocus.ts (kept out of the entry chunk).
export { requestPropsFocus } from '../lib/propsFocus'

// Force-directed local graph (d3-force engine) — its own chunk, loaded when the section opens.
const LocalGraph = lazy(() => import('./graph/LocalGraph').then((m) => ({ default: m.LocalGraph }), reloadOnceForStaleChunk))

export function RightPanel({
  open,
  onClose,
  wsId,
  page,
  editor,
  onOpenSearch,
  readOnly = false,
  guest = false,
  canComment = true,
}: {
  open: boolean
  onClose: () => void
  wsId: string
  page: PageMetaDTO
  editor: InklingEditor | null
  onOpenSearch: (q: string) => void
  /** Page edit lock denies editing (docs/adr/0970-*): properties, aliases and scope are display only. */
  readOnly?: boolean
  /**
   * Guest of the workspace (docs/adr/1252-*): outline, comments, backlinks and outgoing links only.
   * Review, unlinked mentions, tags (search), local graph, aliases, history and properties are member features.
   */
  guest?: boolean
  /** The caller may comment here (PageLockDTO.canComment; a guest with view access may not). */
  canComment?: boolean
}) {
  const tr = useT()
  const navigate = useNavigate()
  const pages = usePages(wsId)
  const backlinks = useBacklinks(page.id)
  const comments = useComments(page.kind === 'doc' ? page.id : undefined)

  // When the parent is a collection, this row's properties are edited with that collection's fields.
  const parent = page.parentId
    ? (pages.data ?? []).find((p) => p.id === page.parentId)
    : undefined
  const parentIsCollection = parent?.kind === 'collection'
  const parentCollection = useCollection(parentIsCollection ? parent!.id : undefined)
  const members = useMembers(wsId)
  const updateProps = useUpdateProps(parent?.id ?? '')
  const updateFields = useUpdateFields(parent?.id ?? '')

  // Section (shared/private) switch. created_by is not in the DTO, so the client cannot tell ownership;
  // the button is always shown and rule violations surface as the server's 403/400 message (shared→private, etc.).
  const updatePage = useUpdatePage(wsId)
  const [scopeError, setScopeError] = useState<string | null>(null)
  const targetScope = page.scope === 'private' ? 'shared' : 'private'
  const toggleScope = () => {
    setScopeError(null)
    updatePage.mutate(
      { id: page.id, input: { scope: targetScope } },
      {
        onError: (err) =>
          setScopeError(err instanceof ApiError ? err.message : tr('rightPanel.scopeFailed')),
      },
    )
  }

  const collFields = parentCollection.data?.collection.fields ?? []
  const rowProps = parentCollection.data?.rows.find((r) => r.id === page.id)?.props ?? {}
  const addOption = (fieldId: string, name: string): string => {
    const id = crypto.randomUUID().slice(0, 8)
    const target = collFields.find((f) => f.id === fieldId)
    const color = OPTION_COLORS[(target?.options?.length ?? 0) % OPTION_COLORS.length]
    const next: CollectionField[] = collFields.map((f) =>
      f.id === fieldId
        ? { ...f, options: [...(f.options ?? []), { id, name, color }] }
        : f,
    )
    updateFields.mutate(next)
    return id
  }

  const [sections, setSections] = useState<Record<SectionKey, boolean>>(loadSectionState)
  const toggleSection = (key: SectionKey) => {
    setSections((prev) => {
      const next = { ...prev, [key]: !prev[key] }
      try {
        localStorage.setItem('inkling:rightPanel:sections', JSON.stringify(next))
      } catch {
        // ignore
      }
      return next
    })
  }

  // Follow edits: recompute outline/outgoing links/tags on editor.onChange, debounced 300ms
  const [docTick, setDocTick] = useState(0)
  useEffect(() => {
    if (!editor) return
    let timer: number | undefined
    const unsub = editor.onChange(() => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => setDocTick((v) => v + 1), 300)
    })
    return () => {
      window.clearTimeout(timer)
      unsub?.()
    }
  }, [editor])

  const showDocSections = !!editor && page.kind === 'doc'

  // ⌘; → expand the properties section and scroll it into view (focus the first input if any)
  useEffect(() => {
    const consume = () => {
      if (!consumePropsFocus()) return
      setSections((prev) => {
        if (prev.props) return prev
        const next = { ...prev, props: true }
        try {
          localStorage.setItem('inkling:rightPanel:sections', JSON.stringify(next))
        } catch {
          // ignore
        }
        return next
      })
      requestAnimationFrame(() => {
        const el = document.querySelector<HTMLElement>('[data-panel-section="props"]')
        el?.scrollIntoView({ block: 'nearest' })
        el?.querySelector<HTMLElement>('input, textarea, [tabindex="0"]')?.focus()
      })
    }
    consume()
    window.addEventListener('inkling:open-props', consume)
    return () => window.removeEventListener('inkling:open-props', consume)
  }, [])

  // History — fetched only for doc pages with the section open. Previews the 5 most recent.
  const [historyOpen, setHistoryOpen] = useState(false)
  const [saveTemplateOpen, setSaveTemplateOpen] = useState(false)
  const [historyInitialSid, setHistoryInitialSid] = useState<string | null>(null)
  const snapshots = useSnapshots(page.id, showDocSections && sections.history && !guest)
  const recentSnapshots = (snapshots.data ?? []).slice(0, 5)

  // Unlinked mentions and local graph are doc-only (no editor needed). Unlinked mentions are fetched only when the section is open.
  const isDoc = page.kind === 'doc'
  const unlinked = useUnlinked(page.id, isDoc && sections.unlinked && !guest)
  const openHistory = (sid: string | null) => {
    setHistoryInitialSid(sid)
    setHistoryOpen(true)
  }

  // Outline / outgoing links / tags straight from the ProseMirror doc with a per-block cache —
  // only edited blocks are re-read (docs/adr/0705-*). Previously `editor.document` converted the
  // whole document to block JSON on every tick.
  const { headings, outgoingIds, tags } = useMemo(
    () =>
      showDocSections && editor
        ? computeOutline(editor.prosemirrorState.doc as unknown as Parameters<typeof computeOutline>[0])
        : EMPTY_OUTLINE,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editor, showDocSections, docTick],
  )

  const byId = useMemo(() => {
    const m = new Map<string, PageMetaDTO>()
    for (const p of pages.data ?? []) m.set(p.id, p)
    return m
  }, [pages.data])

  const scrollToBlock = (id: string) => {
    revealBlock(id)
    const el = document.querySelector(`[data-id="${id}"]`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  if (!open) return null

  const content = (
    <>
      <div className="flex items-center justify-between border-b border-line px-3 py-2.5 md:hidden">
        <span className="text-sm font-semibold text-ink">{tr('rightPanel.title')}</span>
        <button
          type="button"
          onClick={onClose}
          aria-label={tr('common.close')}
          className="rounded-md p-1 text-sub hover:bg-hover hover:text-ink"
        >
          <XIcon size={17} />
        </button>
      </div>

      {showDocSections && (
        <Section
          title={tr('outline.title')}
          count={headings.length}
          open={sections.outline}
          onToggle={() => toggleSection('outline')}
        >
          {headings.length === 0 ? (
            <p className="text-xs text-sub">{tr('outline.empty')}</p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {headings.map((h, i) => (
                <li key={`${h.id}-${i}`}>
                  <button
                    type="button"
                    onClick={() => scrollToBlock(h.id)}
                    style={{ paddingLeft: (h.level - 1) * 12 }}
                    className="block w-full truncate py-0.5 text-left text-xs text-sub hover:text-ink"
                    title={h.text}
                  >
                    {h.text}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}

      {showDocSections && (
        <Section
          title={tr('rightPanel.comments')}
          count={comments.data?.length ?? 0}
          open={sections.comments}
          onToggle={() => toggleSection('comments')}
        >
          <CommentsPanel
            wsId={wsId}
            pageId={page.id}
            editor={editor}
            members={members.data ?? []}
            canComment={canComment}
          />
        </Section>
      )}

      <Section
        title={tr('backlinks.title')}
        count={backlinks.data?.length ?? 0}
        open={sections.backlinks}
        onToggle={() => toggleSection('backlinks')}
      >
        {(backlinks.data?.length ?? 0) === 0 ? (
          <p className="text-xs text-sub">{tr('common.none')}</p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {backlinks.data!.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => navigate(`/w/${wsId}/p/${p.id}`)}
                  className="flex w-full items-center gap-1.5 truncate py-0.5 text-left text-xs text-ink hover:text-accent"
                >
                  <span className="shrink-0 leading-none"><PageIconGlyph page={p} size={13} /></span>
                  <span className="min-w-0 flex-1 truncate">{p.title || tr('common.untitled')}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* Document owner and last review (docs/adr/0951-*) */}
      {page.kind !== 'folder' && !guest && (
        <Section
          title={tr('review.section')}
          open={sections.review}
          onToggle={() => toggleSection('review')}
        >
          {sections.review && <PageReviewCard wsId={wsId} page={page} readOnly={readOnly} />}
        </Section>
      )}

      {isDoc && !guest && (
        <Section
          title={tr('backlinks.unlinked')}
          count={unlinked.data?.length ?? 0}
          open={sections.unlinked}
          onToggle={() => toggleSection('unlinked')}
        >
          {!sections.unlinked ? null : unlinked.isLoading ? (
            <p className="text-xs text-sub">{tr('common.loading')}</p>
          ) : (unlinked.data?.length ?? 0) === 0 ? (
            <p className="text-xs text-sub">{tr('common.none')}</p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {unlinked.data!.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => navigate(`/w/${wsId}/p/${p.id}`)}
                    className="flex w-full items-center gap-1.5 truncate py-0.5 text-left text-xs text-ink hover:text-accent"
                  >
                    <span className="shrink-0 leading-none"><PageIconGlyph page={p} size={13} /></span>
                    <span className="min-w-0 flex-1 truncate">{p.title || tr('common.untitled')}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}

      {showDocSections && (
        <Section
          title={tr('rightPanel.outgoing')}
          count={outgoingIds.length}
          open={sections.outgoing}
          onToggle={() => toggleSection('outgoing')}
        >
          {outgoingIds.length === 0 ? (
            <p className="text-xs text-sub">{tr('common.none')}</p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {outgoingIds.map((id) => {
                const target = byId.get(id)
                return (
                  <li key={id}>
                    {target ? (
                      <button
                        type="button"
                        onClick={() => navigate(`/w/${wsId}/p/${id}`)}
                        className="flex w-full items-center gap-1.5 truncate py-0.5 text-left text-xs text-ink hover:text-accent"
                      >
                        <span className="shrink-0 leading-none"><PageIconGlyph page={target} size={13} /></span>
                        <span className="min-w-0 flex-1 truncate">
                          {target.title || tr('common.untitled')}
                        </span>
                      </button>
                    ) : (
                      <span className="flex items-center gap-1.5 py-0.5 text-xs text-sub/70">
                        <LinkIcon size={12} /> {tr('rightPanel.deletedPage')}
                      </span>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </Section>
      )}

      {showDocSections && !guest && (
        <Section
          title={tr('rightPanel.tags')}
          count={tags.length}
          open={sections.tags}
          onToggle={() => toggleSection('tags')}
        >
          {tags.length === 0 ? (
            <p className="text-xs text-sub">{tr('common.none')}</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {tags.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  // The body stores '#tag' literally, so prefix the hash for an exact full-text search hit.
                  onClick={() => onOpenSearch(`#${tag}`)}
                  className="rounded-full bg-accent-soft px-2 py-0.5 text-xs text-accent hover:opacity-80"
                >
                  #{tag}
                </button>
              ))}
            </div>
          )}
        </Section>
      )}

      {isDoc && !guest && (
        <Section
          title={tr('localGraph.title')}
          open={sections.localGraph}
          onToggle={() => toggleSection('localGraph')}
        >
          {/* Mounted only when open — avoids the graph/layout computation cost */}
          {sections.localGraph ? (
            <Suspense fallback={null}>
              <LocalGraph wsId={wsId} focusId={page.id} />
            </Suspense>
          ) : null}
        </Section>
      )}

      {!guest && (
      <Section
        title={tr('rightPanel.aliases')}
        count={(page.aliases ?? []).length}
        open={sections.aliases}
        onToggle={() => toggleSection('aliases')}
      >
        <AliasEditor wsId={wsId} page={page} readOnly={readOnly} />
      </Section>
      )}

      {showDocSections && !guest && (
        <Section
          title={tr('rightPanel.history')}
          count={snapshots.data?.length ?? 0}
          open={sections.history}
          onToggle={() => toggleSection('history')}
        >
          {snapshots.isLoading ? (
            <p className="text-xs text-sub">{tr('common.loading')}</p>
          ) : recentSnapshots.length === 0 ? (
            <p className="text-xs text-sub">{tr('rightPanel.noVersions')}</p>
          ) : (
            <div className="flex flex-col gap-0.5">
              <ul className="flex flex-col">
                {recentSnapshots.map((s) => (
                  <li key={s.id}>
                    <button
                      type="button"
                      onClick={() => openHistory(s.id)}
                      className="flex w-full items-center gap-2 rounded py-1 text-left hover:bg-hover"
                      title={snapLabel(s.label)}
                    >
                      <HistoryIcon size={12} className="shrink-0 text-sub" />
                      <span className="min-w-0 flex-1 truncate text-xs text-ink">
                        {snapLabel(s.label)}
                      </span>
                      <span className="shrink-0 text-[11px] text-sub">
                        {relativeTime(s.createdAt)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              <button
                type="button"
                onClick={() => openHistory(null)}
                className="mt-1 self-start text-xs text-accent hover:underline"
              >
                {tr('rightPanel.viewAll')}
              </button>
            </div>
          )}
          {/* Recent changes with "revert" for agent edits (docs/adr/1620-*) */}
          {sections.history && <PageChanges wsId={wsId} pageId={page.id} readOnly={readOnly} />}
        </Section>
      )}

      {!guest && (
      <Section
        title={tr('rightPanel.properties')}
        anchor="props"
        count={parentIsCollection ? collFields.length : undefined}
        open={sections.props}
        onToggle={() => toggleSection('props')}
      >
        {parentIsCollection && parentCollection.data ? (
          collFields.length === 0 ? (
            <p className="text-xs text-sub">{tr('rightPanel.noProperties')}</p>
          ) : (
            <div className="flex flex-col gap-2">
              {collFields.map((f) => (
                <div key={f.id} className="flex flex-col gap-0.5">
                  <span className="text-[11px] text-sub">{f.name}</span>
                  <div className="rounded border border-line">
                    <FieldCell
                      field={f}
                      value={rowProps[f.id]}
                      members={members.data}
                      readOnly={readOnly}
                      onCommit={(v) =>
                        updateProps.mutate({ id: page.id, props: { [f.id]: v } })
                      }
                      onAddOption={
                        f.type === 'select' || f.type === 'multiSelect'
                          ? (name) => addOption(f.id, name)
                          : undefined
                      }
                    />
                  </div>
                </div>
              ))}
            </div>
          )
        ) : (
          <div className="flex flex-col gap-2">
            <dl className="flex flex-col gap-1.5 text-xs">
              <div className="flex justify-between gap-2">
                <dt className="text-sub">{tr('rightPanel.kind')}</dt>
                <dd className="text-ink">{kindLabel(page.kind)}</dd>
              </div>
              <div className="flex items-center justify-between gap-2">
                <dt className="text-sub">{tr('rightPanel.section')}</dt>
                <dd className="flex items-center gap-1 text-ink">
                  {page.scope === 'private' ? (
                    <>
                      <LockIcon size={12} /> {tr('rightPanel.private')}
                    </>
                  ) : (
                    <>
                      <UsersIcon size={12} /> {tr('rightPanel.shared')}
                    </>
                  )}
                </dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-sub">{tr('rightPanel.created')}</dt>
                <dd className="text-ink">{formatDateTime(page.createdAt)}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-sub">{tr('rightPanel.updated')}</dt>
                <dd className="text-ink">{formatDateTime(page.updatedAt)}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-sub">{tr('rightPanel.backlinkCount')}</dt>
                <dd className="text-ink">{backlinks.data?.length ?? 0}</dd>
              </div>
            </dl>
            {/* A scope change carries the subtree: the edit lock denies it (docs/adr/0970-*) */}
            {!readOnly && (
              <button
                type="button"
                onClick={toggleScope}
                disabled={updatePage.isPending}
                className="flex items-center justify-center gap-1.5 rounded-md border border-line px-2 py-1.5 text-xs text-sub transition-colors duration-150 hover:bg-hover hover:text-ink disabled:opacity-60"
              >
                {targetScope === 'private' ? <LockIcon size={12} /> : <UsersIcon size={12} />}
                {targetScope === 'private' ? tr('rightPanel.makePrivate') : tr('rightPanel.makeShared')}
              </button>
            )}
            {scopeError && <p className="text-xs text-red-600">{scopeError}</p>}
            {/* Save as template — same modal as the row menu (templates table → template gallery).
                The old isTemplate toggle set a field the gallery never reads, so it did nothing (replaced 2026-09-23). */}
            {page.kind === 'doc' && (
              <button
                type="button"
                onClick={() => setSaveTemplateOpen(true)}
                className="flex items-center justify-center gap-1.5 rounded-md border border-line px-2 py-1.5 text-xs text-sub transition-colors duration-150 hover:bg-hover hover:text-ink"
              >
                <TemplateIcon size={12} />
                {tr('rightPanel.saveAsTemplate')}
              </button>
            )}
            {saveTemplateOpen && (
              <SaveAsTemplateModal
                open={saveTemplateOpen}
                onClose={() => setSaveTemplateOpen(false)}
                wsId={wsId}
                page={page}
              />
            )}
          </div>
        )}
      </Section>
      )}
    </>
  )

  return (
    <>
      {/* Desktop: fixed 280px on the right — nd-enter when opened */}
      <aside className="nd-enter hidden w-[280px] shrink-0 overflow-y-auto border-l border-line transition-colors duration-200 md:block">
        {content}
      </aside>

      {/* Mobile: right overlay drawer (backdrop fade + panel slides in from the right) */}
      <div className="fixed inset-0 z-40 md:hidden">
        <div className="nd-backdrop absolute inset-0 bg-black/40" onClick={onClose} />
        <aside className="nd-drawer-r absolute inset-y-0 right-0 w-[320px] max-w-[88%] overflow-y-auto border-l border-line bg-app pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)] shadow-xl transition-colors duration-200">
          {content}
        </aside>
      </div>

      {/* History modal — a portal, so mounted only once (content is rendered twice) */}
      {historyOpen && (
        <HistoryModal
          open
          onClose={() => setHistoryOpen(false)}
          pageId={page.id}
          initialSid={historyInitialSid}
        />
      )}
    </>
  )
}
