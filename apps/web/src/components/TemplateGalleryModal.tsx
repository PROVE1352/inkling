import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import type {
  CreatePageFromTemplateInput,
  TemplateCategory,
  TemplateDTO,
  TemplatePreviewBlockDTO,
  TemplatePreviewDTO,
} from '@inkling/shared'
import { TEMPLATE_CATEGORIES } from '@inkling/shared'
import { ApiError, triggerDownload, useDeleteTemplate, useTemplates } from '../api'
import { templateExportUrl, useImportTemplate, useInstantiateTemplate, useTemplatePreview } from '../templatesApi'
import { todayISODate } from '../lib/time'
import { toast } from '../lib/toast'
import { Modal } from './Modal'
import { Spinner } from './Spinner'
import { DownloadIcon, SearchIcon, TrashIcon, UploadIcon } from './Icons'
import { useT } from '../i18n'
import type { TKey } from '../i18n'

// Template gallery (docs/adr/0925-*): category tabs, search, built-in / workspace / mine filter
// and a rendered preview of the first blocks plus the page outline. "Use template" opens the
// variable step (title, date for dated templates, {{input:…}} questions); the server substitutes
// everything and the editor puts the caret at {{cursor}}.

type Source = 'all' | 'builtin' | 'workspace' | 'mine'
const SOURCES: Source[] = ['all', 'builtin', 'workspace', 'mine']

function matchesSource(t: TemplateDTO, s: Source): boolean {
  if (s === 'builtin') return t.builtin
  if (s === 'workspace') return !t.builtin && t.scope === 'shared'
  if (s === 'mine') return t.mine
  return true
}

/** Highlight {{…}} / <% … %> tokens inside preview text. */
function withVars(text: string) {
  const parts = text.split(/(\{\{[^}]*\}\}|<%[^%]*%>)/g)
  return parts.map((p, i) =>
    i % 2 === 1 ? (
      <span key={i} className="rounded bg-accent/10 px-0.5 font-mono text-[0.85em] text-accent">
        {p}
      </span>
    ) : (
      p
    ),
  )
}

function PreviewBlock({ b }: { b: TemplatePreviewBlockDTO }) {
  const pad = { paddingLeft: `${b.depth * 14}px` }
  switch (b.type) {
    case 'h1':
      return <div style={pad} className="mt-2 text-base font-semibold text-ink">{withVars(b.text)}</div>
    case 'h2':
      return <div style={pad} className="mt-2 text-sm font-semibold text-ink">{withVars(b.text)}</div>
    case 'h3':
      return <div style={pad} className="mt-1.5 text-[13px] font-semibold text-ink">{withVars(b.text)}</div>
    case 'bullet':
      return <div style={pad} className="text-[13px] text-ink">• {withVars(b.text)}</div>
    case 'number':
      return <div style={pad} className="text-[13px] text-ink">1. {withVars(b.text)}</div>
    case 'check':
      return (
        <div style={pad} className="text-[13px] text-ink">
          {b.checked ? '☑' : '☐'} {withVars(b.text)}
        </div>
      )
    case 'quote':
      return <div style={pad} className="border-l-2 border-line pl-2 text-[13px] italic text-sub">{withVars(b.text)}</div>
    case 'code':
      return <pre style={pad} className="whitespace-pre-wrap rounded bg-hover px-2 py-1 font-mono text-[12px] text-ink">{b.text}</pre>
    case 'table':
      return (
        <pre style={pad} className="whitespace-pre-wrap rounded border border-line px-2 py-1 font-mono text-[11px] text-sub">
          {b.text}
        </pre>
      )
    default:
      return <div style={pad} className="text-[13px] text-ink">{withVars(b.text)}</div>
  }
}

function Preview({ preview }: { preview: TemplatePreviewDTO }) {
  const tr = useT()
  const kindLabel: Record<string, TKey> = {
    doc: 'tpl.kind.doc',
    folder: 'tpl.kind.folder',
    canvas: 'tpl.kind.canvas',
    collection: 'tpl.kind.collection',
  }
  return (
    <div className="flex flex-col gap-3">
      {preview.blocks.length > 0 && (
        <div data-testid="template-preview" className="flex flex-col gap-0.5">
          {preview.blocks.map((b, i) => (
            <PreviewBlock key={i} b={b} />
          ))}
          {preview.truncated && <div className="pt-1 text-[11px] text-sub">{tr('tpl.previewMore')}</div>}
        </div>
      )}
      {preview.outline.length > 1 && (
        <div className="flex flex-col gap-0.5 border-t border-line pt-2">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-sub">{tr('tpl.outline')}</div>
          {preview.outline.map((n, i) => (
            <div key={i} style={{ paddingLeft: `${n.depth * 14}px` }} className="flex items-baseline gap-1.5 text-[12px] text-ink">
              <span className="shrink-0">{n.icon || (n.kind === 'folder' ? '📁' : n.kind === 'collection' ? '🗃️' : n.kind === 'canvas' ? '🧭' : '📄')}</span>
              <span className="truncate">{withVars(n.title)}</span>
              <span className="shrink-0 text-[10px] text-sub">{tr(kindLabel[n.kind])}</span>
              {n.kind === 'collection' && (
                <span className="shrink-0 text-[10px] text-sub">
                  {tr('tpl.collectionInfo', { fields: n.fields ?? 0, views: (n.views ?? []).join(', ') || '—', rows: n.rows ?? 0 })}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function TemplateGalleryModal({
  open,
  onClose,
  wsId,
}: {
  open: boolean
  onClose: () => void
  wsId: string
}) {
  // `tr`, not `t`: `t` is used for template items below
  const tr = useT()
  const navigate = useNavigate()
  const templates = useTemplates(wsId)
  const create = useInstantiateTemplate(wsId)
  const del = useDeleteTemplate(wsId)
  const importTpl = useImportTemplate(wsId)
  const fileRef = useRef<HTMLInputElement>(null)

  const [step, setStep] = useState<'pick' | 'fill'>('pick')
  const [category, setCategory] = useState<TemplateCategory | 'all'>('all')
  const [source, setSource] = useState<Source>('all')
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [date, setDate] = useState(() => todayISODate())
  const [inputs, setInputs] = useState<Record<string, string>>({})
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Reset state every time it opens
  useEffect(() => {
    if (open) {
      setStep('pick')
      setCategory('all')
      setSource('all')
      setQuery('')
      setSelectedId(null)
      setTitle('')
      setDate(todayISODate())
      setInputs({})
      setPendingDelete(null)
      setError(null)
    }
  }, [open])

  const list = useMemo(() => templates.data ?? [], [templates.data])
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return list.filter(
      (t) =>
        (category === 'all' || t.category === category) &&
        matchesSource(t, source) &&
        (!q || t.name.toLowerCase().includes(q) || (t.description ?? '').toLowerCase().includes(q)),
    )
  }, [list, category, source, query])
  const selected = list.find((t) => t.id === selectedId) ?? null
  const preview = useTemplatePreview(wsId, step === 'pick' ? selectedId : null)

  const pick = (t: TemplateDTO) => {
    setSelectedId(t.id)
    setError(null)
  }

  const toFill = () => {
    if (!selected) return
    setInputs(Object.fromEntries(selected.inputs.map((i) => [i.name, i.default])))
    setTitle('')
    setError(null)
    setStep('fill')
  }

  const submit = () => {
    if (!selected || create.isPending) return
    setError(null)
    const input: Omit<CreatePageFromTemplateInput, 'workspaceId' | 'tz'> = selected.builtin
      ? { builtinKey: selected.id as CreatePageFromTemplateInput['builtinKey'] }
      : { templateId: selected.id }
    // date doubles as {{date}}; send it only when the user can see and change it
    if (selected.withDate) input.date = date
    if (title.trim()) input.title = title.trim()
    if (selected.inputs.length) input.inputs = inputs
    create.mutate(input, {
      onSuccess: ({ page, cursor }) => {
        onClose()
        const qs = cursor && cursor.pageId === page.id ? `?cursor=${encodeURIComponent(`${cursor.blockId}:${cursor.offset}`)}` : ''
        navigate(`/w/${wsId}/p/${page.id}${qs}`)
      },
      onError: (err) => setError(err instanceof ApiError ? err.message : tr('templates.applyFailed')),
    })
  }

  const removeCustom = (id: string) => {
    del.mutate(id, {
      onSuccess: () => {
        if (selectedId === id) setSelectedId(null)
        setPendingDelete(null)
      },
      onError: (err) => setError(err instanceof ApiError ? err.message : tr('templates.deleteFailed')),
    })
  }

  const onImportFile = (file: File | undefined) => {
    if (!file) return
    setError(null)
    importTpl.mutate(
      { file, private: source === 'mine' },
      {
        onSuccess: (t) => {
          toast({ message: tr('tpl.imported', { name: t.name }) })
          setCategory('all')
          setSelectedId(t.id)
        },
        onError: (err) => setError(err instanceof ApiError ? err.message : tr('tpl.importFailed')),
      },
    )
  }

  const badge = (t: TemplateDTO) =>
    t.builtin ? tr('tpl.badge.builtin') : t.scope === 'private' ? tr('tpl.badge.private') : tr('tpl.badge.shared')

  const card = (t: TemplateDTO) => {
    const isSel = selectedId === t.id
    const confirming = pendingDelete === t.id
    return (
      <div
        key={t.id}
        className={`group flex items-center gap-2 rounded-md px-2.5 py-2 transition-colors duration-100 ${
          isSel ? 'bg-active' : 'hover:bg-hover'
        }`}
      >
        <button
          type="button"
          onClick={() => pick(t)}
          onDoubleClick={() => {
            pick(t)
            setInputs(Object.fromEntries(t.inputs.map((i) => [i.name, i.default])))
            setStep('fill')
          }}
          data-template-id={t.id}
          className="flex min-w-0 flex-1 items-start gap-2.5 text-left"
        >
          <span className="mt-0.5 shrink-0 text-[17px] leading-none">{t.icon || '📄'}</span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5">
              <span className="truncate text-sm text-ink">{t.name}</span>
              {t.kind === 'structure' && (
                <span className="shrink-0 rounded bg-hover px-1 text-[10px] text-sub">
                  {tr('tpl.pages', { count: t.pageCount })}
                </span>
              )}
            </span>
            <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-sub">
              <span className="shrink-0">{badge(t)}</span>
              {t.description && <span className="truncate">· {t.description}</span>}
            </span>
          </span>
        </button>
        {!t.builtin &&
          (confirming ? (
            <span className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                onClick={() => removeCustom(t.id)}
                disabled={del.isPending}
                className="rounded px-1.5 py-0.5 text-[11px] font-medium text-red-600 hover:bg-hover disabled:opacity-50"
              >
                {tr('common.delete')}
              </button>
              <button
                type="button"
                onClick={() => setPendingDelete(null)}
                className="rounded px-1.5 py-0.5 text-[11px] text-sub hover:bg-hover"
              >
                {tr('common.cancel')}
              </button>
            </span>
          ) : (
            <button
              type="button"
              onClick={() => setPendingDelete(t.id)}
              aria-label={tr('templates.delete')}
              title={tr('templates.delete')}
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-sub opacity-0 transition-opacity hover:bg-hover hover:text-red-600 focus-visible:opacity-100 group-hover:opacity-100"
            >
              <TrashIcon size={14} />
            </button>
          ))}
      </div>
    )
  }

  const chip = (active: boolean) =>
    `rounded-full px-2.5 py-1 text-[12px] transition-colors duration-100 ${
      active ? 'bg-accent text-white' : 'text-sub hover:bg-hover hover:text-ink'
    }`

  const fillStep = selected && (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <span className="text-[19px] leading-none">{selected.icon || '📄'}</span>
        <span className="text-sm font-medium text-ink">{tr('tpl.fillTitle', { name: selected.name })}</span>
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-[11px] font-medium text-sub" htmlFor="tpl-title">
          {tr('tpl.titleLabel')}
        </label>
        <input
          id="tpl-title"
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              submit()
            }
          }}
          placeholder={tr('tpl.titlePlaceholder')}
          className="w-full rounded-md border border-line bg-transparent px-2.5 py-1.5 text-sm text-ink placeholder:text-sub/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        />
      </div>
      {selected.withDate && (
        <div className="flex items-center gap-2">
          <label className="text-[11px] font-medium text-sub" htmlFor="tpl-date">
            {tr('templates.date')}
          </label>
          <input
            id="tpl-date"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="rounded-md border border-line bg-transparent px-2 py-1 text-sm text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          />
        </div>
      )}
      {selected.inputs.length > 0 && (
        <div className="flex flex-col gap-2 rounded-md border border-line p-3">
          <p className="text-[11px] text-sub">{tr('tpl.inputsHint')}</p>
          {selected.inputs.map((inp, i) => (
            <div key={inp.name} className="flex flex-col gap-1">
              <label className="text-[12px] font-medium text-ink" htmlFor={`tpl-input-${i}`}>
                {inp.name}
              </label>
              <input
                id={`tpl-input-${i}`}
                value={inputs[inp.name] ?? ''}
                onChange={(e) => setInputs((prev) => ({ ...prev, [inp.name]: e.target.value }))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    submit()
                  }
                }}
                placeholder={inp.default}
                className="w-full rounded-md border border-line bg-transparent px-2.5 py-1.5 text-sm text-ink placeholder:text-sub/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
              />
            </div>
          ))}
        </div>
      )}
    </div>
  )

  return (
    <Modal open={open} onClose={onClose} title={tr('templates.title')} size="lg">
      <div className="flex flex-col gap-3">
        {templates.isLoading ? (
          <div className="flex justify-center py-6">
            <Spinner size={18} />
          </div>
        ) : step === 'fill' && selected ? (
          fillStep
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex min-w-[12rem] flex-1 items-center gap-1.5 rounded-md border border-line px-2 py-1 focus-within:ring-1 focus-within:ring-accent">
                <SearchIcon size={14} />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={tr('tpl.search')}
                  aria-label={tr('tpl.search')}
                  className="w-full bg-transparent text-sm text-ink placeholder:text-sub/60 focus:outline-none"
                />
              </div>
              <select
                value={source}
                onChange={(e) => setSource(e.target.value as Source)}
                aria-label={tr('tpl.src.all')}
                className="rounded-md border border-line bg-app px-2 py-1 text-[12px] text-ink"
              >
                {SOURCES.map((s) => (
                  <option key={s} value={s}>
                    {tr(`tpl.src.${s}` as TKey)}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                disabled={importTpl.isPending}
                className="flex items-center gap-1 rounded-md border border-line px-2 py-1 text-[12px] text-sub hover:bg-hover hover:text-ink disabled:opacity-50"
              >
                {importTpl.isPending ? <Spinner size={12} /> : <UploadIcon size={13} />}
                {tr('tpl.import')}
              </button>
              <input
                ref={fileRef}
                type="file"
                accept=".md,.markdown,.txt,.zip"
                className="hidden"
                onChange={(e) => {
                  onImportFile(e.target.files?.[0])
                  e.target.value = ''
                }}
              />
            </div>
            <div className="flex flex-wrap gap-1" role="tablist">
              {(['all', ...TEMPLATE_CATEGORIES] as const).map((c) => (
                <button
                  key={c}
                  type="button"
                  role="tab"
                  aria-selected={category === c}
                  onClick={() => setCategory(c)}
                  className={chip(category === c)}
                >
                  {tr(`tpl.cat.${c}` as TKey)}
                </button>
              ))}
            </div>
            <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
              <div className="flex max-h-[22rem] flex-col gap-0.5 overflow-y-auto">
                {filtered.length === 0 ? (
                  <p className="px-2.5 py-3 text-[12px] text-sub">
                    {list.some((t) => !t.builtin) || source !== 'mine' ? tr('tpl.empty') : tr('templates.mineEmpty')}
                  </p>
                ) : (
                  filtered.map(card)
                )}
              </div>
              <div className="max-h-[22rem] min-h-[10rem] overflow-y-auto rounded-md border border-line p-3">
                {!selected ? (
                  <p className="text-[12px] text-sub">{tr('tpl.pickHint')}</p>
                ) : preview.isLoading ? (
                  <div className="flex justify-center py-6">
                    <Spinner size={16} />
                  </div>
                ) : preview.isError || !preview.data ? (
                  <p className="text-[12px] text-red-600">{tr('tpl.previewFailed')}</p>
                ) : (
                  <Preview preview={preview.data} />
                )}
              </div>
            </div>
          </>
        )}

        {error && <p className="text-xs text-red-600">{error}</p>}

        <div className="flex items-center justify-end gap-2">
          {step === 'pick' && selected && (
            <button
              type="button"
              onClick={() => triggerDownload(templateExportUrl(wsId, selected.id))}
              className="mr-auto flex items-center gap-1 rounded-md px-2 py-1.5 text-[12px] text-sub hover:bg-hover hover:text-ink"
            >
              <DownloadIcon size={13} />
              {tr('tpl.export')}
            </button>
          )}
          <button
            type="button"
            onClick={step === 'fill' ? () => setStep('pick') : onClose}
            className="rounded-md border border-line px-3 py-1.5 text-sm text-sub transition-colors duration-150 hover:bg-hover hover:text-ink"
          >
            {step === 'fill' ? tr('tpl.back') : tr('common.cancel')}
          </button>
          {step === 'pick' ? (
            <button
              type="button"
              onClick={toFill}
              disabled={!selected}
              className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white transition-opacity duration-150 hover:opacity-90 disabled:opacity-50"
            >
              {tr('tpl.use')}
            </button>
          ) : (
            <button
              type="button"
              onClick={submit}
              disabled={!selected || create.isPending}
              className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white transition-opacity duration-150 hover:opacity-90 disabled:opacity-50"
            >
              {create.isPending && <Spinner size={14} />}
              {tr('common.create')}
            </button>
          )}
        </div>
      </div>
    </Modal>
  )
}
