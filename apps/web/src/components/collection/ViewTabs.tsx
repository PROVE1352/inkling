import { useEffect, useRef, useState } from 'react'
import type { CollectionViewDTO, ViewType } from '@inkling/shared'
import { useT } from '../../i18n'
import { MoreHorizontalIcon, PlusIcon, TrashIcon } from '../Icons'
import { useCollectionReadOnly } from './readOnlyContext'
import { VIEW_TYPE_LABEL as TYPE_LABEL } from './strings'

const CREATABLE_TYPES: ViewType[] = ['table', 'list', 'board', 'calendar', 'gallery', 'timeline', 'chart', 'form']

function Tab({
  view,
  active,
  onSelect,
  onRename,
  onDelete,
  canDelete,
}: {
  view: CollectionViewDTO
  active: boolean
  onSelect: () => void
  onRename: (name: string) => void
  onDelete: () => void
  canDelete: boolean
}) {
  const t = useT()
  // Read-only: switching tabs is local state; rename/delete are view writes the lock denies.
  const readOnly = useCollectionReadOnly()
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState(view.name)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node))
        setMenuOpen(false)
    }
    const id = window.setTimeout(() => document.addEventListener('mousedown', onDown), 0)
    return () => {
      window.clearTimeout(id)
      document.removeEventListener('mousedown', onDown)
    }
  }, [menuOpen])

  const commit = () => {
    setRenaming(false)
    const next = name.trim()
    if (next && next !== view.name) onRename(next)
    else setName(view.name)
  }

  return (
    <div
      className={`flex items-center gap-0.5 border-b-2 px-1 ${
        active ? 'border-accent' : 'border-transparent'
      }`}
    >
      {renaming ? (
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              commit()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              setName(view.name)
              setRenaming(false)
            }
          }}
          className="w-24 rounded border border-accent bg-app px-1 py-0.5 text-sm text-ink outline-none"
        />
      ) : (
        <button
          type="button"
          onClick={onSelect}
          onDoubleClick={() => active && !readOnly && setRenaming(true)}
          className={`whitespace-nowrap px-1.5 py-1.5 text-sm ${
            active ? 'font-medium text-ink' : 'text-sub hover:text-ink'
          }`}
        >
          {view.name}
        </button>
      )}

      {active && !renaming && !readOnly && (
        <div ref={menuRef} className="relative">
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            aria-label={t('viewTabs.menu')}
            className="rounded p-0.5 text-sub hover:bg-hover hover:text-ink"
          >
            <MoreHorizontalIcon size={14} />
          </button>
          {menuOpen && (
            <div className="absolute left-0 top-full z-40 mt-1 w-32 overflow-hidden rounded-md border border-line bg-app py-1 shadow-xl">
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false)
                  setRenaming(true)
                }}
                className="w-full px-3 py-1.5 text-left text-sm text-ink hover:bg-hover"
              >
                {t('common.rename')}
              </button>
              <button
                type="button"
                disabled={!canDelete}
                onClick={() => {
                  setMenuOpen(false)
                  onDelete()
                }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-red-600 hover:bg-hover disabled:opacity-40"
                title={canDelete ? undefined : t('viewTabs.cantDeleteLast')}
              >
                <TrashIcon size={14} /> {t('common.delete')}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export function ViewTabs({
  views,
  activeViewId,
  onSelect,
  onCreate,
  onRename,
  onDelete,
  creating,
}: {
  views: CollectionViewDTO[]
  activeViewId: string
  onSelect: (id: string) => void
  onCreate: (name: string, type: ViewType) => void
  onRename: (id: string, name: string) => void
  onDelete: (id: string) => void
  creating?: boolean
}) {
  const t = useT()
  const readOnly = useCollectionReadOnly()
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [type, setType] = useState<ViewType>('table')
  const addRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!adding) return
    const onDown = (e: MouseEvent) => {
      if (addRef.current && !addRef.current.contains(e.target as Node)) setAdding(false)
    }
    const id = window.setTimeout(() => document.addEventListener('mousedown', onDown), 0)
    return () => {
      window.clearTimeout(id)
      document.removeEventListener('mousedown', onDown)
    }
  }, [adding])

  const submit = () => {
    // A blank name defaults to the view type in the current locale (existing views are never renamed).
    const viewName = name.trim() || TYPE_LABEL[type]
    onCreate(viewName, type)
    setName('')
    setType('table')
    setAdding(false)
  }

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1 border-b border-line px-1">
      {views.map((v) => (
        <Tab
          key={v.id}
          view={v}
          active={v.id === activeViewId}
          onSelect={() => onSelect(v.id)}
          onRename={(n) => onRename(v.id, n)}
          onDelete={() => onDelete(v.id)}
          canDelete={views.length > 1}
        />
      ))}

      {!readOnly && (
        <div ref={addRef} className="relative">
          <button
            type="button"
            onClick={() => setAdding((v) => !v)}
            aria-label={t('viewTabs.newView')}
            title={t('viewTabs.newView')}
            className="flex items-center gap-0.5 rounded px-1.5 py-1.5 text-sm text-sub hover:bg-hover hover:text-ink"
          >
            <PlusIcon size={15} />
          </button>
          {adding && (
            <div className="absolute left-0 top-full z-40 mt-1 w-60 rounded-md border border-line bg-app p-2 shadow-xl">
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    submit()
                  }
                }}
                placeholder={t('viewTabs.namePlaceholder')}
                className="mb-2 w-full rounded border border-line bg-app px-2 py-1 text-sm text-ink outline-none focus-visible:border-accent"
              />
              <div className="mb-2 grid grid-cols-3 gap-1">
                {CREATABLE_TYPES.map((vt) => (
                  <button
                    key={vt}
                    type="button"
                    onClick={() => setType(vt)}
                    className={`flex-1 rounded border px-2 py-1 text-xs ${
                      type === vt
                        ? 'border-accent bg-accent-soft text-accent'
                        : 'border-line text-sub hover:bg-hover'
                    }`}
                  >
                    {TYPE_LABEL[vt]}
                  </button>
                ))}
              </div>
              <button
                type="button"
                onClick={submit}
                disabled={creating}
                className="w-full rounded bg-accent px-2 py-1 text-sm text-white hover:opacity-90 disabled:opacity-60"
              >
                {creating ? t('viewTabs.creating') : t('common.create')}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
