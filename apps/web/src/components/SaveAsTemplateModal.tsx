import { useEffect, useState } from 'react'
import type { PageMetaDTO, TemplateCategory } from '@inkling/shared'
import { TEMPLATE_CATEGORIES } from '@inkling/shared'
import { ApiError, useCreateTemplate } from '../api'
import { toast } from '../lib/toast'
import { Modal } from './Modal'
import { Spinner } from './Spinner'
import { useT } from '../i18n'
import type { TKey } from '../i18n'

// Save a page as a custom template (docs/adr/0920-*, 0921-*) — name/description/icon/category, and
// optionally the page's sub-pages, databases (with or without their rows) and canvases. The server
// snapshots the pages; a private page always gives a template only its creator sees.
export function SaveAsTemplateModal({
  open,
  onClose,
  wsId,
  page,
}: {
  open: boolean
  onClose: () => void
  wsId: string
  page: PageMetaDTO
}) {
  const t = useT()
  const create = useCreateTemplate(wsId)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [icon, setIcon] = useState('')
  const [category, setCategory] = useState<TemplateCategory>('custom')
  const [includeSubpages, setIncludeSubpages] = useState(false)
  const [includeRows, setIncludeRows] = useState(false)
  const [onlyMe, setOnlyMe] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const forcedPrivate = page.scope === 'private'

  useEffect(() => {
    if (open) {
      setName(page.title || '')
      setDescription('')
      setIcon(page.icon ?? '')
      setCategory('custom')
      setIncludeSubpages(page.kind === 'folder')
      setIncludeRows(false)
      setOnlyMe(false)
      setError(null)
    }
  }, [open, page.title, page.icon, page.kind])

  const submit = () => {
    const trimmed = name.trim()
    if (!trimmed || create.isPending) {
      if (!trimmed) setError(t('saveTemplate.nameRequired'))
      return
    }
    setError(null)
    create.mutate(
      {
        name: trimmed,
        description: description.trim() || undefined,
        icon: icon.trim() || undefined,
        fromPageId: page.id,
        category,
        includeSubpages,
        includeRows: (includeSubpages || page.kind === 'collection') && includeRows,
        private: forcedPrivate || onlyMe,
      },
      {
        onSuccess: () => {
          onClose()
          toast({ message: t('saveTemplate.saved', { name: trimmed }) })
        },
        onError: (err) =>
          setError(err instanceof ApiError ? err.message : t('saveTemplate.saveFailed')),
      },
    )
  }

  return (
    <Modal open={open} onClose={onClose} title={t('saveTemplate.title')}>
      <div className="flex flex-col gap-3">
        <div className="flex gap-2">
          <div className="flex w-16 shrink-0 flex-col gap-1">
            <label className="text-[11px] font-medium text-sub" htmlFor="tpl-icon">
              {t('saveTemplate.icon')}
            </label>
            <input
              id="tpl-icon"
              value={icon}
              onChange={(e) => setIcon(e.target.value)}
              placeholder="📄"
              maxLength={8}
              className="w-full rounded-md border border-line bg-transparent px-2 py-1.5 text-center text-base text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            />
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <label className="text-[11px] font-medium text-sub" htmlFor="tpl-name">
              {t('common.name')}
            </label>
            <input
              id="tpl-name"
              value={name}
              autoFocus
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  submit()
                }
              }}
              placeholder={t('saveTemplate.namePlaceholder')}
              className="w-full rounded-md border border-line bg-transparent px-2.5 py-1.5 text-sm text-ink placeholder:text-sub/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            />
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-[11px] font-medium text-sub" htmlFor="tpl-desc">
            {t('saveTemplate.description')}
          </label>
          <input
            id="tpl-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                submit()
              }
            }}
            placeholder={t('saveTemplate.descriptionPlaceholder')}
            className="w-full rounded-md border border-line bg-transparent px-2.5 py-1.5 text-sm text-ink placeholder:text-sub/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          />
        </div>

        <div className="flex items-center gap-2">
          <label className="text-[11px] font-medium text-sub" htmlFor="tpl-category">
            {t('saveTemplate.category')}
          </label>
          <select
            id="tpl-category"
            value={category}
            onChange={(e) => setCategory(e.target.value as TemplateCategory)}
            className="rounded-md border border-line bg-app px-2 py-1 text-sm text-ink"
          >
            {TEMPLATE_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {t(`tpl.cat.${c}` as TKey)}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1.5 text-[13px] text-ink">
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={includeSubpages}
              onChange={(e) => setIncludeSubpages(e.target.checked)}
            />
            {t('saveTemplate.includeSubpages')}
          </label>
          {(includeSubpages || page.kind === 'collection') && (
            <label className="flex items-start gap-2 pl-5">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={includeRows}
                onChange={(e) => setIncludeRows(e.target.checked)}
              />
              {t('saveTemplate.includeRows')}
            </label>
          )}
          {forcedPrivate ? (
            <p className="text-[11px] text-sub">{t('saveTemplate.privateForced')}</p>
          ) : (
            <label className="flex items-start gap-2">
              <input type="checkbox" className="mt-0.5" checked={onlyMe} onChange={(e) => setOnlyMe(e.target.checked)} />
              {t('saveTemplate.private')}
            </label>
          )}
        </div>

        {error && <p className="text-xs text-red-600">{error}</p>}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-line px-3 py-1.5 text-sm text-sub transition-colors duration-150 hover:bg-hover hover:text-ink"
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={create.isPending}
            className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white transition-opacity duration-150 hover:opacity-90 disabled:opacity-50"
          >
            {create.isPending && <Spinner size={14} />}
            {t('common.save')}
          </button>
        </div>
      </div>
    </Modal>
  )
}
