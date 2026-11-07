import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { WorkspaceAvatar } from './WorkspaceAvatar'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router'
import { useCreatePage, usePages, useWorkspaces } from '../api'
import { pageIcon } from '../lib/pageIcon'
import { getTheme, setTheme, type Theme } from '../lib/theme'
import { toISODate } from '../lib/time'
import { useDailyNote } from '../lib/dailyNote'
import { useNewPage } from '../lib/newPage'
import { ALT, BACK_KEY, FORWARD_KEY, MOD, NEW_PAGE_KEY, SHIFT, combo, modKey } from '../lib/platform'
import {
  AlarmIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  CalendarDayIcon,
  CalendarIcon,
  CanvasIcon,
  ContrastIcon,
  DatabaseIcon,
  DiceIcon,
  FileJumpIcon,
  FileTextIcon,
  FolderIcon,
  GraphIcon,
  HistoryIcon,
  PanelLeftIcon,
  PanelRightIcon,
  PlugIcon,
  PropertiesIcon,
  RefreshIcon,
  SearchIcon,
  SettingsIcon,
  TagIcon,
  GlobeIcon,
  TemplateIcon,
  TextSearchIcon,
  TrashIcon,
} from './Icons'
import { useHistoryNav } from './NavButtons'
import { usePluginCommandItems } from '../plugins/integration'
import { requestPropsFocus } from '../lib/propsFocus'
import type { SearchMode } from './SearchModal'
import { useT } from '../i18n'

type Item = {
  key: string
  /** Actions use a line icon (SVG); pages/workspaces use their own emoji icon */
  icon: ReactNode
  label: string
  hint?: string
  run: () => void
}

const THEME_ORDER: Theme[] = ['light', 'dark', 'system']

// Global command palette (⌘P / Ctrl+P), reusing the SearchModal structure (portal + keyboard navigation).
// A list of actions plus page shortcuts (title filter). Each action calls an existing hook or navigate.
export function CommandPalette({
  open,
  onClose,
  wsId,
  onOpenSearch,
  onToggleSidebar,
  onOpenTrash,
  onOpenTemplates,
}: {
  open: boolean
  onClose: () => void
  wsId: string
  onOpenSearch: (q?: string, mode?: SearchMode) => void
  onToggleSidebar: () => void
  onOpenTrash: () => void
  onOpenTemplates: () => void
}) {
  const t = useT()
  const navigate = useNavigate()
  const pages = usePages(wsId)
  const workspaces = useWorkspaces()
  const createPage = useCreatePage(wsId)
  const { create: newPage } = useNewPage(wsId)
  // The action list is memoized, so read the "current page" fresh through a ref (used to place the new page)
  const newPageRef = useRef(newPage)
  newPageRef.current = newPage
  const { openDaily } = useDailyNote(wsId)
  const histNav = useHistoryNav()

  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    setQuery('')
    setSelected(0)
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [open])

  // --- Action helpers (always close the palette before running) ---
  const runAndClose = (fn: () => void) => {
    onClose()
    fn()
  }

  const newInKind = (kind: 'doc' | 'folder' | 'collection' | 'canvas') => {
    createPage.mutate(
      { workspaceId: wsId, kind },
      {
        onSuccess: (page) => {
          if (kind !== 'folder') navigate(`/w/${wsId}/p/${page.id}`)
        },
      },
    )
  }

  // Daily notes: lib/dailyNote (hook shared with the sidebar and calendar). offset = ±days from today.
  const openDailyAt = (offset: number) => {
    const d = new Date()
    d.setDate(d.getDate() + offset)
    openDaily(toISODate(d))
  }

  // Random page — excludes folders and trashed pages
  const openRandom = () => {
    const list = (pages.data ?? []).filter((p) => !p.deletedAt && p.kind !== 'folder')
    if (list.length === 0) return
    const p = list[Math.floor(Math.random() * list.length)]
    navigate(`/w/${wsId}/p/${p.id}`)
  }

  const cycleTheme = () => {
    const next = THEME_ORDER[(THEME_ORDER.indexOf(getTheme()) + 1) % THEME_ORDER.length]
    setTheme(next)
  }

  const actions = useMemo<Item[]>(() => {
    const base: Item[] = [
      { key: 'new-doc', icon: <FileTextIcon size={16} />, label: t('palette.newDoc'), hint: NEW_PAGE_KEY, run: () => newPageRef.current() },
      { key: 'new-folder', icon: <FolderIcon size={16} />, label: t('palette.newFolder'), run: () => newInKind('folder') },
      {
        key: 'new-db',
        icon: <DatabaseIcon size={16} />,
        label: t('palette.newDatabase'),
        run: () => newInKind('collection'),
      },
      { key: 'new-canvas', icon: <CanvasIcon size={16} />, label: t('palette.newCanvas'), run: () => newInKind('canvas') },
      {
        key: 'from-template',
        icon: <TemplateIcon size={16} />,
        label: t('palette.fromTemplate'),
        run: onOpenTemplates,
      },
      { key: 'daily', icon: <CalendarDayIcon size={16} />, label: t('palette.dailyToday'), run: () => openDailyAt(0) },
      { key: 'daily-prev', icon: <CalendarDayIcon size={16} />, label: t('palette.dailyYesterday'), run: () => openDailyAt(-1) },
      { key: 'daily-next', icon: <CalendarDayIcon size={16} />, label: t('palette.dailyTomorrow'), run: () => openDailyAt(1) },
      { key: 'random', icon: <DiceIcon size={16} />, label: t('palette.randomPage'), run: openRandom },
      { key: 'due', icon: <AlarmIcon size={16} />, label: t('palette.due'), run: () => navigate(`/w/${wsId}/due`) },
      { key: 'search', icon: <SearchIcon size={16} />, label: t('palette.openSearch'), hint: modKey('K'), run: () => onOpenSearch() },
      {
        key: 'quick-switch',
        icon: <FileJumpIcon size={16} />,
        label: t('palette.quickSwitcher'),
        hint: modKey('O'),
        run: () => onOpenSearch('', 'title'),
      },
      {
        key: 'search-all',
        icon: <TextSearchIcon size={16} />,
        label: t('palette.fullTextSearch'),
        hint: combo(MOD, SHIFT, 'F'),
        run: () => onOpenSearch('', 'all'),
      },
      {
        key: 'graph',
        icon: <GraphIcon size={16} />,
        label: t('palette.graph'),
        hint: modKey('G'),
        run: () => navigate(`/w/${wsId}/graph`),
      },
      { key: 'tags', icon: <TagIcon size={16} />, label: t('palette.tags'), run: () => navigate(`/w/${wsId}/tags`) },
      { key: 'shared', icon: <GlobeIcon size={16} />, label: t('palette.webShares'), run: () => navigate(`/w/${wsId}/shared`) },
      // Every sidebar menu has a command here too, so a menu hidden from the sidebar stays reachable (docs/adr/1020-*).
      { key: 'calendar', icon: <CalendarIcon size={16} />, label: t('palette.calendar'), run: () => navigate(`/w/${wsId}/calendar`) },
      { key: 'activity', icon: <HistoryIcon size={16} />, label: t('palette.activity'), run: () => navigate(`/w/${wsId}/activity`) },
      { key: 'trash', icon: <TrashIcon size={16} />, label: t('palette.openTrash'), run: onOpenTrash },
      {
        key: 'right-panel',
        icon: <PanelRightIcon size={16} />,
        label: t('palette.toggleRightPanel'),
        run: () => window.dispatchEvent(new Event('inkling:toggle-right')),
      },
      { key: 'props', icon: <PropertiesIcon size={16} />, label: t('palette.editProperties'), hint: modKey(';'), run: requestPropsFocus },
      {
        key: 'back',
        icon: <ArrowLeftIcon size={16} />,
        label: t('common.back'),
        hint: BACK_KEY,
        run: histNav.back,
      },
      {
        key: 'forward',
        icon: <ArrowRightIcon size={16} />,
        label: t('nav.forward'),
        hint: FORWARD_KEY,
        run: histNav.forward,
      },
      { key: 'reload', icon: <RefreshIcon size={16} />, label: t('palette.reload'), run: () => window.location.reload() },
      { key: 'theme', icon: <ContrastIcon size={16} />, label: t('palette.cycleTheme'), run: cycleTheme },
      { key: 'sidebar', icon: <PanelLeftIcon size={16} />, label: t('palette.toggleSidebar'), hint: modKey('\\'), run: onToggleSidebar },
      {
        key: 'settings',
        icon: <SettingsIcon size={16} />,
        label: t('common.settings'),
        hint: modKey(','),
        run: () => navigate(`/w/${wsId}/settings`),
      },
      {
        key: 'customize-sidebar',
        icon: <PanelLeftIcon size={16} />,
        label: t('palette.customizeSidebar'),
        run: () => navigate(`/w/${wsId}/settings#sidebar`),
      },
      { key: 'mcp', icon: <PlugIcon size={16} />, label: t('palette.mcpConnections'), run: () => navigate('/settings/connections') },
    ]
    const wsItems: Item[] = (workspaces.data ?? [])
      .filter((w) => w.id !== wsId)
      .map((w) => ({
        key: `ws-${w.id}`,
        icon: <WorkspaceAvatar name={w.name} icon={w.icon} size={16} />,
        label: t('palette.switchWorkspace', { name: w.name }),
        run: () => navigate(`/w/${w.id}`),
      }))
    return [...base, ...wsItems]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsId, workspaces.data, pages.data])

  const q = query.trim().toLowerCase()

  // Plugin commands (experimental `plugins`; [] when off) are appended to the built-in actions.
  const pluginActions = usePluginCommandItems()
  const allActions = useMemo(() => [...actions, ...pluginActions], [actions, pluginActions])
  const filteredActions = useMemo(
    () => (q ? allActions.filter((a) => a.label.toLowerCase().includes(q)) : allActions),
    [allActions, q],
  )

  const pageItems = useMemo<Item[]>(() => {
    if (!q) return []
    return (pages.data ?? [])
      .filter((p) => !p.deletedAt && (p.title || t('common.untitled')).toLowerCase().includes(q))
      .slice(0, 8)
      .map((p) => ({
        key: `page-${p.id}`,
        icon: pageIcon(p),
        label: p.title || t('common.untitled'),
        hint: t('common.page'),
        run: () => navigate(`/w/${wsId}/p/${p.id}`),
      }))
  }, [pages.data, q, wsId, navigate, t])

  // Flat list shared by render and keyboard nav (actions first, then pages)
  const items = useMemo(
    () => [...filteredActions, ...pageItems],
    [filteredActions, pageItems],
  )

  useEffect(() => {
    setSelected(0)
  }, [items])

  const go = (index: number) => {
    const item = items[index]
    if (!item) return
    runAndClose(item.run)
  }

  if (!open) return null

  const actionCount = filteredActions.length

  return createPortal(
    <div
      className="nd-backdrop fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-2 pt-3 sm:p-4 sm:pt-[12dvh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('shortcuts.commandPalette')}
        className="nd-pop flex max-h-[calc(100dvh-1.5rem)] w-full max-w-lg sm:max-h-[70dvh] flex-col overflow-hidden rounded-lg border border-line bg-app shadow-xl"
      >
        <div className="flex items-center gap-2 border-b border-line px-3 py-2.5">
          <SearchIcon size={18} className="shrink-0 text-sub" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault()
                onClose()
              } else if (e.key === 'ArrowDown') {
                e.preventDefault()
                setSelected((s) => Math.min(s + 1, items.length - 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setSelected((s) => Math.max(s - 1, 0))
              } else if (e.key === 'Enter') {
                e.preventDefault()
                go(selected)
              }
            }}
            placeholder={t('palette.placeholder')}
            className="min-w-0 flex-1 bg-transparent text-sm text-ink placeholder:text-sub focus-visible:outline-none"
          />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto py-1">
          {items.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs text-sub">{t('common.noResults')}</p>
          ) : (
            items.map((item, i) => (
              <div key={item.key}>
                {actionCount > 0 && i === 0 && (
                  <div className="px-3 pb-0.5 pt-1.5 text-[11px] font-semibold uppercase tracking-wide text-sub">
                    {t('palette.sectionActions')}
                  </div>
                )}
                {i === actionCount && pageItems.length > 0 && (
                  <div className="mt-1 border-t border-line px-3 pb-0.5 pt-2 text-[11px] font-semibold uppercase tracking-wide text-sub">
                    {t('common.pages')}
                  </div>
                )}
                <button
                  type="button"
                  onMouseEnter={() => setSelected(i)}
                  onClick={() => go(i)}
                  className={`flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm transition-colors duration-100 ${
                    i === selected ? 'bg-active text-ink' : 'text-ink hover:bg-hover'
                  }`}
                >
                  <span className="flex w-4 shrink-0 items-center justify-center text-[15px] leading-none text-sub">
                    {item.icon}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  {item.hint && (
                    <span className="shrink-0 text-xs text-sub">{item.hint}</span>
                  )}
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
