import { useEffect, useMemo, useState } from 'react'
import type { AccessRange, AccessRangeView, PageMetaDTO } from '@inkling/shared'
import { usePages, useWorkspaces } from '../api'
import { fmtList, useT } from '../i18n'

/**
 * Picks what a connection may see (docs/adr/1200-*): everything, some workspaces, or one page and
 * the pages under it. Used on the OAuth consent screen and in Settings › Connections (grants and API
 * tokens). `onChange(null)` while the choice is incomplete (no workspace / no page picked yet).
 */
export function RangePicker({
  initial,
  initialWorkspaceId,
  onChange,
  name,
}: {
  initial?: AccessRange
  /** workspace of the initial subtree root, so its page list opens there */
  initialWorkspaceId?: string | null
  onChange: (range: AccessRange | null) => void
  /** radio group name (several pickers can be on one page) */
  name: string
}) {
  const t = useT()
  const workspaces = useWorkspaces()
  const [kind, setKind] = useState<AccessRange['kind']>(initial?.kind ?? 'all')
  const [wsIds, setWsIds] = useState<string[]>(initial?.kind === 'workspaces' ? initial.workspaceIds : [])
  const [pageId, setPageId] = useState<string | null>(initial?.kind === 'subtree' ? initial.pageId : null)
  const [treeWs, setTreeWs] = useState<string>(initialWorkspaceId ?? '')
  const [filter, setFilter] = useState('')
  const list = useMemo(() => workspaces.data ?? [], [workspaces.data])

  useEffect(() => {
    if (!treeWs && list.length) setTreeWs(list[0].id)
  }, [list, treeWs])

  useEffect(() => {
    if (kind === 'all') onChange({ kind: 'all' })
    else if (kind === 'workspaces') onChange(wsIds.length ? { kind: 'workspaces', workspaceIds: wsIds } : null)
    else onChange(pageId ? { kind: 'subtree', pageId } : null)
    // onChange is a callback prop; reporting on value changes only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, wsIds, pageId])

  const option = (k: AccessRange['kind'], label: string, hint: string) => (
    <label
      className={`flex cursor-pointer items-start gap-2 rounded-md border px-2.5 py-2 text-xs ${
        kind === k ? 'border-accent' : 'border-line'
      }`}
    >
      <input type="radio" name={name} className="mt-0.5" checked={kind === k} onChange={() => setKind(k)} />
      <span className="flex flex-col">
        <span className="font-medium text-ink">{label}</span>
        <span className="text-sub">{hint}</span>
      </span>
    </label>
  )

  return (
    <fieldset className="flex flex-col gap-1.5" data-testid="range-picker">
      <legend className="mb-1 text-xs font-medium text-ink">{t('range.label')}</legend>
      {option('all', t('range.all'), t('range.allHint'))}
      {option('workspaces', t('range.workspaces'), t('range.workspacesHint'))}
      {kind === 'workspaces' && (
        <div className="ml-6 flex flex-col gap-1">
          {list.map((w) => (
            <label key={w.id} className="flex items-center gap-2 text-xs text-ink">
              <input
                type="checkbox"
                checked={wsIds.includes(w.id)}
                onChange={(e) =>
                  setWsIds((cur) => (e.target.checked ? [...cur, w.id] : cur.filter((x) => x !== w.id)))
                }
              />
              <span className="truncate">{w.name}</span>
            </label>
          ))}
        </div>
      )}
      {option('subtree', t('range.subtree'), t('range.subtreeHint'))}
      {kind === 'subtree' && (
        <div className="ml-6 flex flex-col gap-1.5">
          <label className="flex items-center gap-2 text-xs text-sub">
            {t('range.pickWorkspace')}
            <select
              value={treeWs}
              onChange={(e) => {
                setTreeWs(e.target.value)
                setPageId(null)
              }}
              className="min-w-0 flex-1 rounded border border-line bg-app px-1.5 py-1 text-xs text-ink"
            >
              {list.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </label>
          <input
            type="search"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={t('range.filterPages')}
            aria-label={t('range.filterPages')}
            className="rounded border border-line bg-app px-2 py-1 text-xs text-ink"
          />
          {treeWs && <PageList wsId={treeWs} filter={filter} selected={pageId} onPick={setPageId} />}
        </div>
      )}
    </fieldset>
  )
}

/** The workspace's pages in tree order, indented, filtered by title. */
function PageList({
  wsId,
  filter,
  selected,
  onPick,
}: {
  wsId: string
  filter: string
  selected: string | null
  onPick: (id: string) => void
}) {
  const t = useT()
  const pages = usePages(wsId)
  const rows = useMemo(() => treeOrder(pages.data ?? []), [pages.data])
  const q = filter.trim().toLowerCase()
  const shown = (q ? rows.filter((r) => r.page.title.toLowerCase().includes(q)) : rows).slice(0, 200)
  if (!shown.length) return <p className="text-xs text-sub">{t('range.noPages')}</p>
  return (
    <ul className="max-h-48 overflow-y-auto rounded border border-line" role="listbox" aria-label={t('range.choosePage')}>
      {shown.map(({ page, depth }) => (
        <li key={page.id}>
          <button
            type="button"
            role="option"
            aria-selected={selected === page.id}
            onClick={() => onPick(page.id)}
            className={`block w-full truncate px-2 py-1 text-left text-xs ${
              selected === page.id ? 'bg-accent/10 text-accent' : 'text-ink hover:bg-hover'
            }`}
            style={{ paddingLeft: `${0.5 + (q ? 0 : depth) * 0.75}rem` }}
          >
            {page.icon ? `${page.icon} ` : ''}
            {page.title || 'Untitled'}
          </button>
        </li>
      ))}
    </ul>
  )
}

function treeOrder(pages: PageMetaDTO[]): { page: PageMetaDTO; depth: number }[] {
  const live = pages.filter((p) => !p.deletedAt)
  const ids = new Set(live.map((p) => p.id))
  const kids = new Map<string | null, PageMetaDTO[]>()
  for (const p of live) {
    const k = p.parentId && ids.has(p.parentId) ? p.parentId : null
    const arr = kids.get(k) ?? []
    arr.push(p)
    kids.set(k, arr)
  }
  for (const arr of kids.values()) arr.sort((a, b) => a.sortOrder - b.sortOrder)
  const out: { page: PageMetaDTO; depth: number }[] = []
  const walk = (k: string | null, d: number) => {
    for (const p of kids.get(k) ?? []) {
      out.push({ page: p, depth: d })
      if (d < 63) walk(p.id, d + 1)
    }
  }
  walk(null, 0)
  return out
}

/** Short label of a stored range for lists ("All notes", "Workspaces: A, B", "Under “Page”"). */
export function RangeBadge({ range }: { range: AccessRangeView | undefined }) {
  const t = useT()
  let label: string
  if (!range || range.kind === 'all') label = t('range.badgeAll')
  else if (range.kind === 'workspaces')
    label = t('range.badgeWorkspaces', {
      names: fmtList(range.workspaces.map((w) => w.name ?? t('range.unavailable'))),
    })
  else label = t('range.badgeSubtree', { title: range.page.title ?? t('range.unavailable') })
  return (
    <span
      className="max-w-full shrink truncate rounded bg-hover px-1.5 py-0.5 text-[10px] text-sub"
      title={label}
      data-testid="range-badge"
    >
      {label}
    </span>
  )
}

/** The stored range as a picker's starting value. */
export function rangeFromView(v: AccessRangeView | undefined): AccessRange {
  if (!v || v.kind === 'all') return { kind: 'all' }
  if (v.kind === 'workspaces') return { kind: 'workspaces', workspaceIds: v.workspaces.map((w) => w.id) }
  return { kind: 'subtree', pageId: v.page.id }
}
