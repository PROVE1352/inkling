import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { t, useT } from '../i18n'
import { en } from '../i18n/en'
import { ko } from '../i18n/ko'
import { PLATFORM, SHORTCUTS, useShortcutKeys } from '../lib/shortcuts'
import {
  SCOPE_LABEL,
  SCOPE_ORDER,
  currentKeys,
  isOverridden,
  isRemappable,
  keyLabels,
  type Scope,
  type ShortcutDef,
} from '../lib/shortcuts/registry'
import { scoreText } from '../lib/shortcuts/search'
import { SearchIcon, XIcon } from './Icons'

export type Row = {
  id: string
  label: string
  hint?: string
  keys: string[]
  texts: string[]
  /** the key cannot be changed in Settings (the editor's or the browser's own) */
  fixed: boolean
  /** the user changed the key in Settings */
  changed: boolean
}
export type Group = { scope: Scope; title: string; rows: Row[] }

const both = (key: string) => [(en as Record<string, string>)[key] ?? '', (ko as Record<string, string | undefined>)[key] ?? '']

// Built from the shortcut registry (lib/shortcuts/registry.ts, docs/adr/1403-*): every command with a
// key now (the user's own keys included, docs/adr/1404-*), grouped by where it works. Nothing here is
// written by hand, so the help window, Settings › Shortcuts, the menus and the palette always show the
// same keys. `all`: also the commands without a key that Settings can give one.
export function shortcutGroups(defs: readonly ShortcutDef[] = SHORTCUTS, { all = false }: { all?: boolean } = {}): Group[] {
  const listed = (d: ShortcutDef) =>
    currentKeys(d.id, PLATFORM).length > 0 || (all && (!!d.keys || (isRemappable(d) && d.palette !== false)))
  return SCOPE_ORDER.map((scope) => ({
    scope,
    title: t(SCOPE_LABEL[scope]),
    rows: defs
      .filter((d) => d.scope === scope && listed(d))
      .map((d) => {
        const keys = [...keyLabels(d.id, PLATFORM), ...(d.alsoTyped ?? [])]
        return {
          id: d.id,
          label: t(d.label),
          hint: d.hint ? t(d.hint) : undefined,
          keys,
          // found by its name in either language, the key, and the group it is in
          texts: [...both(d.label), ...(d.paletteLabel ? both(d.paletteLabel) : []), ...(d.hint ? both(d.hint) : []), ...keys, ...both(SCOPE_LABEL[scope])],
          fixed: !isRemappable(d),
          changed: isOverridden(d.id, PLATFORM),
        }
      }),
  })).filter((g) => g.rows.length > 0)
}

export function Kbd({ children }: { children: string }) {
  return (
    <kbd className="inline-flex min-w-[1.5rem] items-center justify-center rounded border border-line bg-side px-1.5 py-0.5 text-xs font-medium text-ink shadow-sm">
      {children}
    </kbd>
  )
}

/**
 * The shortcut table, shared by this modal (`?`) and Settings › Shortcuts. `query` keeps the rows whose
 * name (English or Korean, initial consonants too), key or group matches every word; groups left
 * empty are dropped.
 */
/** The groups with only the rows whose texts match every word of `query`; empty groups dropped. */
export function filterGroups(groups: Group[], query: string): Group[] {
  const words = query.trim().split(/\s+/).filter(Boolean)
  return groups
    .map((g) => ({
      ...g,
      rows: words.length ? g.rows.filter((r) => words.every((w) => r.texts.some((s) => scoreText(s, w) > 0))) : g.rows,
    }))
    .filter((g) => g.rows.length > 0)
}

export function ShortcutList({ query = '' }: { query?: string }) {
  useT()
  useShortcutKeys()
  const groups = filterGroups(shortcutGroups(), query)
  if (groups.length === 0) return <p className="py-2 text-sm text-sub">{t('shortcuts.noMatch')}</p>
  return (
    <div className="grid gap-x-8 gap-y-5 sm:grid-cols-2">
      {groups.map((g) => (
        <section key={g.scope} aria-label={g.title} data-scope={g.scope}>
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-sub">{g.title}</h3>
          <div className="flex flex-col gap-1.5">
            {g.rows.map((r) => (
              <div key={r.id} data-shortcut={r.id} className="flex items-center justify-between gap-2 text-sm">
                <span className="min-w-0 truncate text-ink">
                  {r.label}
                  {r.hint && <span className="ml-1 text-xs text-sub">({r.hint})</span>}
                </span>
                <span className="flex shrink-0 items-center gap-1">
                  {r.keys.map((k) => (
                    <Kbd key={k}>{k}</Kbd>
                  ))}
                </span>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

export function ShortcutsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  useT()
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const titleId = useId()

  useEffect(() => {
    if (!open) return
    setQuery('')
    requestAnimationFrame(() => inputRef.current?.focus())
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return createPortal(
    <div
      className="nd-backdrop fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-2 pt-3 sm:items-center sm:p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid="shortcuts-help"
        className="nd-dialog flex max-h-[calc(100dvh-1.5rem)] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-line bg-app shadow-xl sm:max-h-[85dvh]"
      >
        <div className="flex items-center justify-between gap-2 px-5 pb-2 pt-4">
          <h2 id={titleId} className="text-base font-semibold text-ink">
            {t('shortcuts.title')}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            className="rounded-md p-1 text-sub transition duration-150 hover:bg-hover hover:text-ink active:scale-[.98]"
          >
            <XIcon size={18} />
          </button>
        </div>
        <div className="px-5 pb-3">
          <label className="relative block">
            <span className="sr-only">{t('shortcuts.search')}</span>
            <SearchIcon size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-sub" />
            <input
              ref={inputRef}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('shortcuts.search')}
              aria-describedby={`${titleId}-hint`}
              className="w-full rounded-md border border-line bg-app py-1.5 pl-8 pr-2 text-sm text-ink placeholder:text-sub focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            />
          </label>
          <p id={`${titleId}-hint`} className="mt-1.5 text-xs text-sub">
            {t('cmd.helpSearchHint')}
          </p>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto border-t border-line px-5 pb-5 pt-4">
          <ShortcutList query={query} />
        </div>
      </div>
    </div>,
    document.body,
  )
}
