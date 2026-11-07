import { useEffect, useRef, useState } from 'react'
import type { RowTemplateDTO } from '@inkling/shared'
import { useT } from '../../i18n'
import { askConfirm } from '../../lib/confirm'
import { Modal } from '../Modal'
import { ChevronDownIcon, EditIcon, FileTextIcon, PlusIcon, TemplateIcon, TrashIcon } from '../Icons'

/** Closes a popover on an outside click or Escape. */
function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null)
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
  }, [open, close])
  return ref
}

const ITEM = 'flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-ink hover:bg-hover'

/**
 * Toolbar "New ▾" (docs/adr/1180-*): the button adds a row with the default template (an empty
 * row when there is none); ▾ picks a template or an empty row, and leads to template management.
 */
export function NewRowButton({
  templates,
  busy,
  onCreate,
  onManage,
  onNewTemplate,
}: {
  templates: RowTemplateDTO[]
  busy: boolean
  /** undefined = default template, null = empty row */
  onCreate: (templateId: string | null | undefined, opts?: { open?: boolean }) => void
  /** omitted when the database is locked for the viewer */
  onManage?: () => void
  onNewTemplate?: () => void
}) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const ref = useDismiss(open, () => setOpen(false))
  const pick = (id: string | null) => {
    setOpen(false)
    onCreate(id, { open: true })
  }
  return (
    <div ref={ref} className="relative flex shrink-0" data-print-hide>
      <button
        type="button"
        disabled={busy}
        onClick={() => onCreate(undefined)}
        aria-label={t('table.newRow')}
        className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-l-md bg-accent py-1 pl-2 pr-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-60"
      >
        <PlusIcon size={13} /> <span className="hidden sm:inline">{t('table.newRow')}</span>
      </button>
      <button
        type="button"
        disabled={busy}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('rowTpl.newMenu')}
        title={t('rowTpl.newMenu')}
        onClick={() => setOpen((v) => !v)}
        className="rounded-r-md border-l border-white/30 bg-accent px-1 py-1 text-white hover:opacity-90 disabled:opacity-60"
      >
        <ChevronDownIcon size={13} />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-40 mt-1 w-64 overflow-hidden rounded-md border border-line bg-app py-1 shadow-xl"
        >
          <div className="px-3 pb-1 pt-0.5 text-xs text-sub">{t('rowTpl.newMenu')}</div>
          {templates.map((tpl) => (
            <button key={tpl.id} type="button" role="menuitem" className={ITEM} onClick={() => pick(tpl.id)}>
              <span className="w-4 shrink-0 text-center">{tpl.icon || <TemplateIcon size={14} />}</span>
              <span className="min-w-0 flex-1 truncate">{tpl.name}</span>
              {tpl.isDefault && (
                <span className="shrink-0 rounded bg-accent/15 px-1.5 text-[11px] text-accent">{t('rowTpl.default')}</span>
              )}
            </button>
          ))}
          <button type="button" role="menuitem" className={ITEM} onClick={() => pick(null)}>
            <span className="w-4 shrink-0 text-center">
              <FileTextIcon size={14} />
            </span>
            <span className="flex-1">{t('rowTpl.emptyRow')}</span>
          </button>
          {(onNewTemplate || onManage) && <div className="my-1 border-t border-line" />}
          {onNewTemplate && (
            <button
              type="button"
              role="menuitem"
              className={`${ITEM} text-sub`}
              onClick={() => {
                setOpen(false)
                onNewTemplate()
              }}
            >
              <PlusIcon size={14} /> {t('rowTpl.newTemplate')}
            </button>
          )}
          {onManage && (
            <button
              type="button"
              role="menuitem"
              className={`${ITEM} text-sub`}
              onClick={() => {
                setOpen(false)
                onManage()
              }}
            >
              <TemplateIcon size={14} /> {t('rowTpl.manage')}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/** Template list for a database: edit, default, delete, new. */
export function RowTemplatesModal({
  open,
  onClose,
  templates,
  readOnly,
  onEdit,
  onNew,
  onSetDefault,
  onDelete,
}: {
  open: boolean
  onClose: () => void
  templates: RowTemplateDTO[]
  readOnly: boolean
  onEdit: (id: string) => void
  onNew: () => void
  onSetDefault: (id: string, isDefault: boolean) => void
  onDelete: (id: string) => void
}) {
  const t = useT()
  return (
    <Modal open={open} onClose={onClose} title={t('rowTpl.modalTitle')} size="md">
      {templates.length === 0 ? (
        <p className="mb-4 text-sm text-sub">{t('rowTpl.emptyList')}</p>
      ) : (
        <ul className="mb-4 divide-y divide-line rounded-md border border-line">
          {templates.map((tpl) => (
            <li key={tpl.id} className="flex items-center gap-2 px-3 py-2">
              <span className="w-5 shrink-0 text-center">{tpl.icon || <TemplateIcon size={15} />}</span>
              <button
                type="button"
                className="min-w-0 flex-1 truncate text-left text-sm text-ink hover:underline"
                onClick={() => onEdit(tpl.id)}
              >
                {tpl.name}
              </button>
              {tpl.isDefault && (
                <span className="shrink-0 rounded bg-accent/15 px-1.5 text-[11px] text-accent">{t('rowTpl.default')}</span>
              )}
              {!readOnly && (
                <button
                  type="button"
                  className="shrink-0 rounded-md px-1.5 py-0.5 text-xs text-sub hover:bg-hover hover:text-ink"
                  onClick={() => onSetDefault(tpl.id, !tpl.isDefault)}
                >
                  {tpl.isDefault ? t('rowTpl.clearDefault') : t('rowTpl.makeDefault')}
                </button>
              )}
              <button
                type="button"
                aria-label={t('rowTpl.edit')}
                title={t('rowTpl.edit')}
                className="shrink-0 rounded-md p-1 text-sub hover:bg-hover hover:text-ink"
                onClick={() => onEdit(tpl.id)}
              >
                <EditIcon size={14} />
              </button>
              {!readOnly && (
                <button
                  type="button"
                  aria-label={t('rowTpl.delete')}
                  title={t('rowTpl.delete')}
                  className="shrink-0 rounded-md p-1 text-sub hover:bg-hover hover:text-red-500"
                  onClick={() =>
                    void askConfirm(t('rowTpl.deleteConfirm', { name: tpl.name })).then((ok) => ok && onDelete(tpl.id))
                  }
                >
                  <TrashIcon size={14} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {!readOnly && (
        <button
          type="button"
          onClick={onNew}
          className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:opacity-90"
        >
          <PlusIcon size={14} /> {t('rowTpl.newTemplate')}
        </button>
      )}
    </Modal>
  )
}

/** Answers to a template's {{input:…}} prompts before the row is created. */
export function RowInputsModal({
  template,
  onCancel,
  onCreate,
  busy,
}: {
  template: RowTemplateDTO | null
  onCancel: () => void
  onCreate: (inputs: Record<string, string>) => void
  busy: boolean
}) {
  const t = useT()
  const [values, setValues] = useState<Record<string, string>>({})
  useEffect(() => setValues({}), [template?.id])
  if (!template) return null
  return (
    <Modal open onClose={onCancel} title={t('rowTpl.inputsTitle', { name: template.name })}>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          onCreate(values)
        }}
        className="space-y-3"
      >
        {template.inputs.map((inp, i) => (
          <label key={inp.name} className="block text-sm">
            <span className="mb-1 block text-sub">{inp.name}</span>
            <input
              autoFocus={i === 0}
              value={values[inp.name] ?? ''}
              placeholder={inp.default}
              maxLength={2000}
              onChange={(e) => setValues((v) => ({ ...v, [inp.name]: e.target.value }))}
              className="w-full rounded-md border border-line bg-app px-2 py-1.5 text-ink outline-none focus:border-accent"
            />
          </label>
        ))}
        <div className="flex justify-end">
          <button
            type="submit"
            disabled={busy}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            {t('rowTpl.create')}
          </button>
        </div>
      </form>
    </Modal>
  )
}
