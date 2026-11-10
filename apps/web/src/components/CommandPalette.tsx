import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { WorkspaceAvatar } from './WorkspaceAvatar'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router'
import { usePages, useWorkspaces } from '../api'
import { PageIconGlyph } from './PageIconGlyph'
import { switcherOrder } from '../lib/workspaceListing'
import { useWorkspaceGroups } from '../workspaceListingApi'
import { getActiveEditor } from '../lib/activeEditor'
import { SHORTCUTS, isAvailable, onCommandsChanged, runCommand, shortcutLabel, useShortcutKeys } from '../lib/shortcuts'
import { PLATFORM } from '../lib/shortcuts'
import { keyLabels } from '../lib/shortcuts/registry'
import { loadRecent, rememberCommand, scoreText, searchCommands } from '../lib/shortcuts/search'
import {
  AlarmIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  CalendarDayIcon,
  CalendarIcon,
  CanvasIcon,
  CheckIcon,
  ClockIcon,
  ContrastIcon,
  CopyIcon,
  DatabaseIcon,
  DiceIcon,
  EditIcon,
  FileJumpIcon,
  FileTextIcon,
  FolderIcon,
  GraphIcon,
  HistoryIcon,
  MessageIcon,
  PanelLeftIcon,
  PanelRightIcon,
  PenIcon,
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
import { usePluginCommandItems } from '../plugins/integration'
import { en } from '../i18n/en'
import { ko } from '../i18n/ko'
import { useT, type TKey } from '../i18n'

type Item = {
  key: string
  /** Registry id for commands (recent list, availability); absent for pages, workspaces, plugins */
  command?: string
  /** Actions use a line icon (SVG); pages/workspaces use their own emoji icon */
  icon: ReactNode
  label: string
  hint?: string
  /** Everything the item can be found by: its name in both languages, its key */
  texts: string[]
  run: () => void
}

const icon16 = (C: (p: { size?: number }) => ReactNode) => <C size={16} />
const COMMAND_ICONS: Record<string, ReactNode> = {
  'app.search': icon16(SearchIcon),
  'app.quickSwitcher': icon16(FileJumpIcon),
  'app.fullTextSearch': icon16(TextSearchIcon),
  'app.newPage': icon16(FileTextIcon),
  'nav.back': icon16(ArrowLeftIcon),
  'nav.forward': icon16(ArrowRightIcon),
  'app.graph': icon16(GraphIcon),
  'app.settings': icon16(SettingsIcon),
  'app.toggleSidebar': icon16(PanelLeftIcon),
  'app.help': <span className="text-[13px] font-semibold">?</span>,
  'app.newFolder': icon16(FolderIcon),
  'app.newDatabase': icon16(DatabaseIcon),
  'app.newCanvas': icon16(CanvasIcon),
  'app.fromTemplate': icon16(TemplateIcon),
  'app.dailyToday': icon16(CalendarDayIcon),
  'app.dailyYesterday': icon16(CalendarDayIcon),
  'app.dailyTomorrow': icon16(CalendarDayIcon),
  'app.randomPage': icon16(DiceIcon),
  'app.due': icon16(AlarmIcon),
  'app.tags': icon16(TagIcon),
  'app.webShares': icon16(GlobeIcon),
  'app.calendar': icon16(CalendarIcon),
  'app.activity': icon16(HistoryIcon),
  'app.later': icon16(ClockIcon),
  'app.threads': icon16(MessageIcon),
  'app.trash': icon16(TrashIcon),
  'app.reload': icon16(RefreshIcon),
  'app.cycleTheme': icon16(ContrastIcon),
  'app.customizeSidebar': icon16(PanelLeftIcon),
  'app.mcp': icon16(PlugIcon),
  'page.renameTitle': icon16(EditIcon),
  'page.properties': icon16(PropertiesIcon),
  'page.toggleRightPanel': icon16(PanelRightIcon),
  'page.toggleFavorite': <span className="text-[15px] leading-none">☆</span>,
  'page.togglePen': icon16(PenIcon),
  'page.saveForLater': icon16(ClockIcon),
  'editor.duplicateBlock': icon16(CopyIcon),
  'editor.deleteBlock': icon16(TrashIcon),
  'editor.checkTodo': icon16(CheckIcon),
  'editor.toggleCheckbox': icon16(CheckIcon),
}
// Editor commands without their own picture get a pilcrow, the sign for "a block of text".
const EDITOR_GLYPH = <span className="text-[14px] leading-none">¶</span>

const PAGE_LIMIT = 8

// Command palette (⌘P / Ctrl+P, docs/adr/1402-*). Lists every registry command that can run right
// now (lib/shortcuts/registry.ts) with its key, plus workspace switches and plugin commands, and
// pages by title once something is typed. Search covers the English and the Korean name of each
// command and Korean initial consonants; the commands run last come first. Keyboard only works:
// ↑/↓ (Home/End) to move, Enter to run, Esc to close — a combobox over a listbox for screen readers.
export function CommandPalette({ open, onClose, wsId }: { open: boolean; onClose: () => void; wsId: string }) {
  const t = useT()
  const navigate = useNavigate()
  const pages = usePages(wsId)
  const workspaces = useWorkspaces()
  const wsGroups = useWorkspaceGroups()
  const listId = useId()
  // the user's keys (Settings › Shortcuts) changed: the hints and the key search follow
  const keysVersion = useShortcutKeys()

  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const [recent, setRecent] = useState<string[]>([])
  // availability changes when a page or an editor mounts; re-read it then
  const [bindVersion, setBindVersion] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => onCommandsChanged(() => setBindVersion((v) => v + 1)), [])

  useEffect(() => {
    if (!open) return
    setQuery('')
    setSelected(0)
    setRecent(loadRecent())
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [open])

  const runAndClose = (item: Item) => {
    onClose()
    if (item.command) {
      rememberCommand(item.command)
      // the palette had the focus: an editor command acts on the body's caret, so give it back first
      if (item.command.startsWith('editor.')) getActiveEditor()?.editor.focus()
    }
    item.run()
  }

  const commandItems = useMemo<Item[]>(() => {
    if (!open) return []
    const out: Item[] = []
    for (const def of SHORTCUTS) {
      if (def.palette === false || !isAvailable(def.id)) continue
      const names: TKey[] = def.paletteLabel ? [def.paletteLabel, def.label] : [def.label]
      out.push({
        key: def.id,
        command: def.id,
        icon: COMMAND_ICONS[def.id] ?? (def.scope === 'editor' ? EDITOR_GLYPH : icon16(FileTextIcon)),
        label: t(names[0]),
        hint: shortcutLabel(def.id),
        texts: [
          ...names.flatMap((k) => [(en as Record<string, string>)[k] ?? '', (ko as Record<string, string | undefined>)[k] ?? '']),
          ...keyLabels(def.id, PLATFORM),
        ],
        run: () => void runCommand(def.id),
      })
    }
    return out
    // bindVersion: re-evaluate availability when handlers are bound or released
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, bindVersion, keysVersion, t])

  const wsItems = useMemo<Item[]>(
    () =>
      // switcher order: groups, archived last (docs/adr/2300-*)
      switcherOrder(workspaces.data ?? [], wsGroups)
        .filter((w) => w.id !== wsId)
        .map((w) => {
          const label = t('palette.switchWorkspace', { name: w.name })
          return {
            key: `ws-${w.id}`,
            icon: <WorkspaceAvatar name={w.name} icon={w.icon} size={16} />,
            label,
            texts: [label, w.name],
            run: () => navigate(`/w/${w.id}`),
          }
        }),
    [workspaces.data, wsGroups, wsId, navigate, t],
  )

  // Plugin commands (experimental `plugins`; [] when off) are appended to the built-in actions.
  const pluginItems = usePluginCommandItems()
  const actions = useMemo<Item[]>(
    () => [...commandItems, ...wsItems, ...pluginItems.map((p) => ({ ...p, texts: [p.label, p.hint ?? ''] }))],
    [commandItems, wsItems, pluginItems],
  )

  const q = query.trim()
  const ordered = useMemo(
    () => searchCommands(actions.map((a) => ({ ...a, id: a.command ?? a.key })), q, recent),
    [actions, q, recent],
  )
  const recentCount = q ? 0 : ordered.filter((a) => a.command && recent.includes(a.command)).length

  const pageItems = useMemo<Item[]>(() => {
    if (!q) return []
    return (pages.data ?? [])
      .filter((p) => !p.deletedAt)
      .map((p) => ({ p, title: p.title || t('common.untitled') }))
      .map((x) => ({ ...x, score: scoreText(x.title, q) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, PAGE_LIMIT)
      .map(({ p, title }) => ({
        key: `page-${p.id}`,
        icon: <PageIconGlyph page={p} size={16} />,
        label: title,
        hint: t('common.page'),
        texts: [title],
        run: () => navigate(`/w/${wsId}/p/${p.id}`),
      }))
  }, [pages.data, q, wsId, navigate, t])

  // Flat list shared by render and keyboard nav: recent, commands, then pages
  const items = useMemo(() => [...ordered, ...pageItems], [ordered, pageItems])

  useEffect(() => {
    setSelected(0)
  }, [q])

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${selected}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  if (!open) return null

  const optionId = (i: number) => `${listId}-opt-${i}`
  const sections: { title: string; from: number; to: number }[] = []
  if (recentCount > 0) sections.push({ title: t('cmd.recent'), from: 0, to: recentCount })
  if (ordered.length > recentCount) sections.push({ title: t('cmd.commands'), from: recentCount, to: ordered.length })
  if (pageItems.length > 0) sections.push({ title: t('common.pages'), from: ordered.length, to: items.length })

  const move = (to: number) => {
    if (items.length === 0) return
    setSelected(Math.max(0, Math.min(items.length - 1, to)))
  }

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
        data-testid="command-palette"
        className="nd-dialog flex max-h-[calc(100dvh-1.5rem)] w-full max-w-lg sm:max-h-[70dvh] flex-col overflow-hidden rounded-xl border border-line bg-app shadow-xl"
      >
        <div className="flex items-center gap-2 border-b border-line px-3 py-2.5">
          <SearchIcon size={18} className="shrink-0 text-sub" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={items.length ? optionId(selected) : undefined}
            aria-label={t('palette.placeholder')}
            onKeyDown={(e) => {
              // Enter that ends a Korean syllable belongs to the IME
              if (e.nativeEvent.isComposing || e.keyCode === 229) return
              if (e.key === 'Escape') {
                e.preventDefault()
                onClose()
              } else if (e.key === 'ArrowDown') {
                e.preventDefault()
                move(selected + 1)
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                move(selected - 1)
              } else if (e.key === 'PageDown') {
                e.preventDefault()
                move(selected + 8)
              } else if (e.key === 'PageUp') {
                e.preventDefault()
                move(selected - 8)
              } else if ((e.key === 'Home' || e.key === 'End') && (e.ctrlKey || e.metaKey || !query)) {
                e.preventDefault()
                move(e.key === 'Home' ? 0 : items.length - 1)
              } else if (e.key === 'Enter') {
                e.preventDefault()
                const item = items[selected]
                if (item) runAndClose(item)
              }
            }}
            placeholder={t('palette.placeholder')}
            className="min-w-0 flex-1 bg-transparent text-sm text-ink placeholder:text-sub focus-visible:outline-none"
          />
        </div>

        <div ref={listRef} id={listId} role="listbox" aria-label={t('shortcuts.commandPalette')} className="min-h-0 flex-1 overflow-y-auto py-1">
          {items.length === 0 ? (
            <p role="presentation" className="px-3 py-6 text-center text-xs text-sub">
              {t('common.noResults')}
            </p>
          ) : (
            sections.map((sec, si) => (
              <div key={sec.title} role="group" aria-labelledby={`${listId}-sec-${si}`}>
                <div
                  id={`${listId}-sec-${si}`}
                  role="presentation"
                  className={`px-3 pb-0.5 pt-1.5 text-[11px] font-semibold uppercase tracking-wide text-sub ${
                    si > 0 ? 'mt-1 border-t border-line pt-2' : ''
                  }`}
                >
                  {sec.title}
                </div>
                {items.slice(sec.from, sec.to).map((item, k) => {
                  const i = sec.from + k
                  return (
                    <div
                      key={item.key}
                      id={optionId(i)}
                      role="option"
                      aria-selected={i === selected}
                      data-index={i}
                      data-command={item.command}
                      onMouseMove={() => i !== selected && setSelected(i)}
                      // keep the focus (and the caret) in the input
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => runAndClose(item)}
                      className={`flex cursor-pointer items-center gap-2.5 px-3 py-2 text-left text-sm transition-colors duration-100 ${
                        i === selected ? 'bg-active text-ink' : 'text-ink hover:bg-hover'
                      }`}
                    >
                      <span className="flex w-4 shrink-0 items-center justify-center text-[15px] leading-none text-sub">
                        {item.icon}
                      </span>
                      <span className="min-w-0 flex-1 truncate">{item.label}</span>
                      {item.hint && <span className="shrink-0 text-xs text-sub">{item.hint}</span>}
                    </div>
                  )
                })}
              </div>
            ))
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
