import { useEffect, useState } from 'react'
import type { CollectionField, FieldType, SelectOption } from '@inkling/shared'
import { useT } from '../../i18n'
import {
  OPTION_COLORS,
  OPTION_COLOR_LABEL,
  OPTION_DOT_CLASS,
} from '../../lib/optionColors'
import type { OptionColor } from '../../lib/optionColors'
import { ConfirmPopover } from '../ConfirmPopover'
import { PlusIcon, TrashIcon, XIcon } from '../Icons'
import { RelationEditor, RollupEditor } from './FieldConfigEditors'
import { FIELD_TYPE_LABEL as TYPE_LABEL } from './strings'

const TYPE_ORDER: FieldType[] = [
  'text',
  'number',
  'select',
  'multiSelect',
  'date',
  'checkbox',
  'person',
  'url',
  'relation',
  'rollup',
]

function newId(): string {
  return crypto.randomUUID().slice(0, 8)
}

function OptionEditor({
  options,
  onChange,
}: {
  options: SelectOption[]
  onChange: (next: SelectOption[]) => void
}) {
  const t = useT()
  const [colorFor, setColorFor] = useState<string | null>(null)

  const update = (id: string, patch: Partial<SelectOption>) =>
    onChange(options.map((o) => (o.id === id ? { ...o, ...patch } : o)))
  const remove = (id: string) => onChange(options.filter((o) => o.id !== id))
  const add = () =>
    onChange([...options, { id: newId(), name: t('fields.defaultOptionName'), color: 'gray' }])

  return (
    <div className="mt-2 rounded-md border border-line p-2">
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-sub">
        {t('fields.options')}
      </div>
      <div className="flex flex-col gap-1">
        {options.map((o) => (
          <div key={o.id} className="flex items-center gap-1.5">
            <div className="relative">
              <button
                type="button"
                onClick={() => setColorFor((v) => (v === o.id ? null : o.id))}
                aria-label={t('fields.color')}
                title={OPTION_COLOR_LABEL[o.color]}
                className={`h-4 w-4 rounded-full ${OPTION_DOT_CLASS[o.color]}`}
              />
              {colorFor === o.id && (
                <div className="absolute left-0 top-full z-10 mt-1 flex w-max gap-1 rounded-md border border-line bg-app p-1.5 shadow-xl">
                  {OPTION_COLORS.map((c: OptionColor) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => {
                        update(o.id, { color: c })
                        setColorFor(null)
                      }}
                      aria-label={OPTION_COLOR_LABEL[c]}
                      title={OPTION_COLOR_LABEL[c]}
                      className={`h-5 w-5 rounded-full ${OPTION_DOT_CLASS[c]} ${
                        o.color === c ? 'ring-2 ring-accent ring-offset-1' : ''
                      }`}
                    />
                  ))}
                </div>
              )}
            </div>
            <input
              value={o.name}
              onChange={(e) => update(o.id, { name: e.target.value })}
              className="min-w-0 flex-1 rounded border border-line bg-app px-1.5 py-1 text-sm text-ink outline-none focus-visible:border-accent"
            />
            <button
              type="button"
              onClick={() => remove(o.id)}
              aria-label={t('fields.deleteOption')}
              className="rounded p-1 text-sub hover:bg-hover hover:text-red-600"
            >
              <XIcon size={14} />
            </button>
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={add}
        className="mt-1.5 flex items-center gap-1 rounded px-1.5 py-1 text-xs text-sub hover:bg-hover hover:text-ink"
      >
        <PlusIcon size={13} /> {t('fields.addOption')}
      </button>
    </div>
  )
}

export function FieldsModal({
  open,
  onClose,
  fields,
  onSave,
  saving,
  wsId,
  pageId,
  error,
}: {
  open: boolean
  onClose: () => void
  fields: CollectionField[]
  onSave: (fields: CollectionField[]) => void
  saving?: boolean
  /** needed by the relation/rollup editors */
  wsId: string
  pageId: string
  /** server validation message (e.g. invalid relation target) */
  error?: string | null
}) {
  const t = useT()
  const [draft, setDraft] = useState<CollectionField[]>(fields)
  const [confirmId, setConfirmId] = useState<string | null>(null)

  // Reset to the server state every time it opens
  useEffect(() => {
    if (open) setDraft(fields)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  if (!open) return null

  const update = (id: string, patch: Partial<CollectionField>) =>
    setDraft((d) => d.map((f) => (f.id === id ? { ...f, ...patch } : f)))

  const changeType = (id: string, type: FieldType) => {
    const needsOptions = type === 'select' || type === 'multiSelect'
    setDraft((d) => {
      const firstRel = d.find((x) => x.type === 'relation' && x.relation?.targetPageId && x.id !== id)
      return d.map((f) =>
        f.id === id
          ? {
              ...f,
              type,
              options: needsOptions ? f.options ?? [] : undefined,
              relation: type === 'relation' ? f.relation : undefined,
              rollup:
                type === 'rollup'
                  ? f.rollup ??
                    (firstRel
                      ? { relationFieldId: firstRel.id, targetFieldId: 'title', fn: 'count' }
                      : undefined)
                  : undefined,
            }
          : f,
      )
    })
  }

  const remove = (id: string) => {
    setConfirmId(null)
    setDraft((d) => d.filter((f) => f.id !== id))
  }

  const move = (idx: number, dir: -1 | 1) => {
    setDraft((d) => {
      const next = [...d]
      const j = idx + dir
      if (j < 0 || j >= next.length) return d
      ;[next[idx], next[j]] = [next[j], next[idx]]
      return next
    })
  }

  const addField = () =>
    setDraft((d) => [...d, { id: newId(), name: t('fields.newFieldName'), type: 'text' }])

  // relation needs a target, rollup needs a configuration — otherwise the server rejects it
  const incomplete = draft.some(
    (f) => (f.type === 'relation' && !f.relation?.targetPageId) || (f.type === 'rollup' && !f.rollup),
  )

  const save = () => {
    if (incomplete) return
    // Guard against empty names: fall back to the localized 'Property' after trimming
    const cleaned = draft.map((f) => ({
      ...f,
      name: f.name.trim() || t('fields.fallbackName'),
    }))
    onSave(cleaned)
  }

  return (
    <div className="nd-backdrop fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="nd-dialog flex max-h-[85dvh] w-full max-w-lg flex-col rounded-xl border border-line bg-app shadow-2xl">
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold text-ink">{t('fields.title')}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            className="rounded-md p-1 text-sub hover:bg-hover hover:text-ink"
          >
            <XIcon size={17} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {draft.length === 0 ? (
            <p className="py-6 text-center text-sm text-sub">{t('fields.empty')}</p>
          ) : (
            <ul className="flex flex-col gap-3">
              {draft.map((f, idx) => (
                <li key={f.id} className="rounded-md border border-line p-2.5">
                  <div className="flex items-center gap-1.5">
                    <div className="flex flex-col">
                      <button
                        type="button"
                        onClick={() => move(idx, -1)}
                        disabled={idx === 0}
                        aria-label={t('fields.moveUp')}
                        className="text-sub hover:text-ink disabled:opacity-30"
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        onClick={() => move(idx, 1)}
                        disabled={idx === draft.length - 1}
                        aria-label={t('fields.moveDown')}
                        className="text-sub hover:text-ink disabled:opacity-30"
                      >
                        ↓
                      </button>
                    </div>
                    <input
                      value={f.name}
                      onChange={(e) => update(f.id, { name: e.target.value })}
                      className="min-w-0 flex-1 rounded border border-line bg-app px-2 py-1 text-sm text-ink outline-none focus-visible:border-accent"
                    />
                    <select
                      value={f.type}
                      onChange={(e) => changeType(f.id, e.target.value as FieldType)}
                      className="rounded border border-line bg-app px-1.5 py-1 text-sm text-ink outline-none focus-visible:border-accent"
                    >
                      {TYPE_ORDER.map((ft) => (
                        <option key={ft} value={ft}>
                          {TYPE_LABEL[ft]}
                        </option>
                      ))}
                    </select>
                    <div className="relative">
                      <ConfirmPopover
                        open={confirmId === f.id}
                        onCancel={() => setConfirmId(null)}
                        onConfirm={() => remove(f.id)}
                        message={t('fields.deleteConfirm')}
                      >
                        <button
                          type="button"
                          onClick={() => setConfirmId(f.id)}
                          aria-label={t('fields.delete')}
                          className="rounded p-1 text-sub hover:bg-hover hover:text-red-600"
                        >
                          <TrashIcon size={15} />
                        </button>
                      </ConfirmPopover>
                    </div>
                  </div>
                  {(f.type === 'select' || f.type === 'multiSelect') && (
                    <OptionEditor
                      options={f.options ?? []}
                      onChange={(next) => update(f.id, { options: next })}
                    />
                  )}
                  {f.type === 'relation' && (
                    <RelationEditor
                      wsId={wsId}
                      pageId={pageId}
                      field={f}
                      onChange={(p) => update(f.id, p)}
                    />
                  )}
                  {f.type === 'rollup' && (
                    <RollupEditor
                      field={f}
                      draft={draft}
                      pageId={pageId}
                      onChange={(p) => update(f.id, p)}
                    />
                  )}
                </li>
              ))}
            </ul>
          )}

          <button
            type="button"
            onClick={addField}
            className="mt-3 flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-sub hover:bg-hover hover:text-ink"
          >
            <PlusIcon size={15} /> {t('fields.add')}
          </button>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-line px-4 py-3">
          {error && <p className="mr-auto text-xs text-red-600">{error}</p>}
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-sm text-sub hover:bg-hover hover:text-ink"
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={save}
            disabled={saving || incomplete}
            className="rounded-md bg-accent px-3 py-1.5 text-sm text-white hover:opacity-90 disabled:opacity-60"
          >
            {saving ? t('common.saving') : t('common.save')}
          </button>
        </div>
      </div>
    </div>
  )
}
