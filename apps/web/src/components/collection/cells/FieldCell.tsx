import { useEffect, useRef, useState, type RefObject } from 'react'
import type { CollectionField, MemberDTO } from '@inkling/shared'
import { useT } from '../../../i18n'
import { CheckIcon } from '../../Icons'
import { FieldValue, OptionBadge } from './FieldValue'
import { RelationCell, RollupValue } from './RelationCell'

const CELL_BTN =
  'flex min-h-[30px] w-full items-center gap-1 px-2 py-1 text-left text-sm hover:bg-hover'

const EDIT_INPUT =
  'min-h-[30px] w-full bg-app px-2 py-1 text-sm text-ink outline-none ring-1 ring-inset ring-accent rounded-sm'

export type FieldCellProps = {
  field: CollectionField
  value: unknown
  members?: MemberDTO[]
  onCommit: (value: unknown) => void
  // Add a select/multiSelect option → returns the new optionId (fields PUT). Omit to hide the add UI.
  onAddOption?: (name: string) => string
}

function useOutsideClose(
  ref: RefObject<HTMLElement | null>,
  open: boolean,
  close: () => void,
) {
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    const id = window.setTimeout(() => {
      document.addEventListener('mousedown', onDown)
      document.addEventListener('keydown', onKey)
    }, 0)
    return () => {
      window.clearTimeout(id)
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, close, ref])
}

// ---------------------------------------------------------------------------
// text / url / number
// ---------------------------------------------------------------------------

function TextCell({ field, value, onCommit }: FieldCellProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')

  const start = () => {
    setDraft(value == null ? '' : String(value))
    setEditing(true)
  }

  const commit = () => {
    setEditing(false)
    const t = draft.trim()
    if (field.type === 'number') {
      if (t === '') {
        if (value != null) onCommit(null)
        return
      }
      const n = Number(t)
      if (Number.isNaN(n)) return
      if (n !== value) onCommit(n)
      return
    }
    const cur = value == null ? '' : String(value)
    if (t === cur) return
    onCommit(t === '' ? null : t)
  }

  if (editing) {
    return (
      <input
        autoFocus
        type={field.type === 'number' ? 'number' : 'text'}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            commit()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            setEditing(false)
          }
        }}
        className={EDIT_INPUT}
      />
    )
  }

  return (
    <button type="button" onClick={start} className={CELL_BTN}>
      {value == null || value === '' ? (
        <span className="select-none text-transparent">·</span>
      ) : (
        <span className={`truncate ${field.type === 'url' ? 'text-accent' : 'text-ink'}`}>
          {String(value)}
        </span>
      )}
    </button>
  )
}

// ---------------------------------------------------------------------------
// date
// ---------------------------------------------------------------------------

function DateCell({ value, onCommit }: FieldCellProps) {
  const [editing, setEditing] = useState(false)
  if (editing) {
    return (
      <input
        autoFocus
        type="date"
        defaultValue={value ? String(value) : ''}
        onBlur={() => setEditing(false)}
        onChange={(e) => {
          const v = e.target.value
          onCommit(v === '' ? null : v)
        }}
        className={EDIT_INPUT}
      />
    )
  }
  return (
    <button type="button" onClick={() => setEditing(true)} className={CELL_BTN}>
      {value ? (
        <span className="text-ink">{String(value)}</span>
      ) : (
        <span className="select-none text-transparent">·</span>
      )}
    </button>
  )
}

// ---------------------------------------------------------------------------
// checkbox
// ---------------------------------------------------------------------------

function CheckboxCell({ value, onCommit }: FieldCellProps) {
  return (
    <div className="flex min-h-[30px] w-full items-center px-2">
      <button
        type="button"
        aria-pressed={!!value}
        onClick={() => onCommit(!value)}
        className={`inline-flex h-4 w-4 items-center justify-center rounded border ${
          value ? 'border-accent bg-accent text-white' : 'border-line hover:border-sub'
        }`}
      >
        {value ? <CheckIcon size={12} /> : null}
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// select
// ---------------------------------------------------------------------------

function SelectCell({ field, value, onCommit, onAddOption }: FieldCellProps) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  useOutsideClose(ref, open, () => setOpen(false))
  const options = field.options ?? []

  const pick = (id: string | null) => {
    onCommit(id)
    setOpen(false)
  }
  const add = () => {
    const name = newName.trim()
    if (!name || !onAddOption) return
    const id = onAddOption(name)
    setNewName('')
    onCommit(id)
    setOpen(false)
  }

  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen((v) => !v)} className={CELL_BTN}>
        {value ? (
          <OptionBadge field={field} optionId={String(value)} />
        ) : (
          <span className="select-none text-transparent">·</span>
        )}
      </button>
      {open && (
        <div className="absolute left-0 top-full z-40 mt-1 w-56 rounded-md border border-line bg-app p-1 shadow-xl">
          {!!value && (
            <button
              type="button"
              onClick={() => pick(null)}
              className="mb-1 w-full rounded px-2 py-1 text-left text-xs text-sub hover:bg-hover"
            >
              {t('cell.clear')}
            </button>
          )}
          <div className="max-h-52 overflow-y-auto">
            {options.map((o) => (
              <button
                key={o.id}
                type="button"
                onClick={() => pick(o.id)}
                className="flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left hover:bg-hover"
              >
                <OptionBadge field={field} optionId={o.id} />
                {value === o.id && <CheckIcon size={13} />}
              </button>
            ))}
            {options.length === 0 && (
              <p className="px-2 py-1 text-xs text-sub">{t('cell.noOptions')}</p>
            )}
          </div>
          {onAddOption && (
            <div className="mt-1 flex gap-1 border-t border-line pt-1">
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    add()
                  }
                }}
                placeholder={t('fields.addOption')}
                className="min-w-0 flex-1 rounded border border-line bg-app px-1.5 py-1 text-xs text-ink outline-none focus-visible:border-accent"
              />
              <button
                type="button"
                onClick={add}
                className="rounded bg-accent px-2 py-1 text-xs text-white hover:opacity-90"
              >
                {t('common.add')}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// multiSelect
// ---------------------------------------------------------------------------

function MultiSelectCell({ field, value, onCommit, onAddOption }: FieldCellProps) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  useOutsideClose(ref, open, () => setOpen(false))
  const options = field.options ?? []
  const selected: string[] = Array.isArray(value) ? (value as string[]) : []

  const toggle = (id: string) => {
    const next = selected.includes(id)
      ? selected.filter((x) => x !== id)
      : [...selected, id]
    onCommit(next.length ? next : null)
  }
  const add = () => {
    const name = newName.trim()
    if (!name || !onAddOption) return
    const id = onAddOption(name)
    setNewName('')
    onCommit([...selected, id])
  }

  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen((v) => !v)} className={CELL_BTN}>
        {selected.length ? (
          <span className="flex flex-wrap gap-1">
            {selected.map((id) => (
              <OptionBadge key={id} field={field} optionId={id} />
            ))}
          </span>
        ) : (
          <span className="select-none text-transparent">·</span>
        )}
      </button>
      {open && (
        <div className="absolute left-0 top-full z-40 mt-1 w-56 rounded-md border border-line bg-app p-1 shadow-xl">
          <div className="max-h-52 overflow-y-auto">
            {options.map((o) => (
              <button
                key={o.id}
                type="button"
                onClick={() => toggle(o.id)}
                className="flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left hover:bg-hover"
              >
                <OptionBadge field={field} optionId={o.id} />
                {selected.includes(o.id) && <CheckIcon size={13} />}
              </button>
            ))}
            {options.length === 0 && (
              <p className="px-2 py-1 text-xs text-sub">{t('cell.noOptions')}</p>
            )}
          </div>
          {onAddOption && (
            <div className="mt-1 flex gap-1 border-t border-line pt-1">
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    add()
                  }
                }}
                placeholder={t('fields.addOption')}
                className="min-w-0 flex-1 rounded border border-line bg-app px-1.5 py-1 text-xs text-ink outline-none focus-visible:border-accent"
              />
              <button
                type="button"
                onClick={add}
                className="rounded bg-accent px-2 py-1 text-xs text-white hover:opacity-90"
              >
                {t('common.add')}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// person
// ---------------------------------------------------------------------------

function PersonCell({ field, value, members, onCommit }: FieldCellProps) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useOutsideClose(ref, open, () => setOpen(false))
  const list = members ?? []

  const pick = (id: string | null) => {
    onCommit(id)
    setOpen(false)
  }

  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen((v) => !v)} className={CELL_BTN}>
        {value ? (
          <FieldValue field={field} value={value} members={members} />
        ) : (
          <span className="select-none text-transparent">·</span>
        )}
      </button>
      {open && (
        <div className="absolute left-0 top-full z-40 mt-1 w-56 rounded-md border border-line bg-app p-1 shadow-xl">
          {!!value && (
            <button
              type="button"
              onClick={() => pick(null)}
              className="mb-1 w-full rounded px-2 py-1 text-left text-xs text-sub hover:bg-hover"
            >
              {t('cell.clear')}
            </button>
          )}
          <div className="max-h-52 overflow-y-auto">
            {list.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => pick(m.id)}
                className="flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left text-sm hover:bg-hover"
              >
                <span className="inline-flex items-center gap-1.5">
                  <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-accent-soft text-[10px] font-medium text-accent">
                    {m.name.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="truncate text-ink">{m.name}</span>
                </span>
                {value === m.id && <CheckIcon size={13} />}
              </button>
            ))}
            {list.length === 0 && (
              <p className="px-2 py-1 text-xs text-sub">{t('cell.noMembers')}</p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// Dispatches to the inline cell editor for each field type.
export function FieldCell(props: FieldCellProps) {
  switch (props.field.type) {
    case 'checkbox':
      return <CheckboxCell {...props} />
    case 'select':
      return <SelectCell {...props} />
    case 'multiSelect':
      return <MultiSelectCell {...props} />
    case 'person':
      return <PersonCell {...props} />
    case 'date':
      return <DateCell {...props} />
    case 'relation':
      return <RelationCell field={props.field} value={props.value} onCommit={props.onCommit} />
    case 'rollup':
      // computed on the server — read-only
      return (
        <div className="flex min-h-[30px] w-full items-center px-2 py-1">
          <RollupValue value={props.value} />
        </div>
      )
    default:
      return <TextCell {...props} />
  }
}
