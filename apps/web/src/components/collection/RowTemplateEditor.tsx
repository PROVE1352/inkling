import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import * as Y from 'yjs'
import type { CollectionField, MemberDTO, RowTemplateDTO, UserDTO } from '@inkling/shared'
import { useQueryClient } from '@tanstack/react-query'
import { useT } from '../../i18n'
import { LocalDocEditor } from '../CollabEditor'
import { EmojiPicker } from '../EmojiPicker'
import { Spinner } from '../Spinner'
import { TemplateIcon, XIcon } from '../Icons'
import { fetchRowTemplate, fromBase64, qkRowTemplates, toBase64, updateRowTemplate } from '../../lib/rowTemplatesApi'
import { DefaultValueEditor } from './RowTemplateDefaults'

type SaveState = 'idle' | 'saving' | 'saved' | 'error'

/**
 * Row template editor (docs/adr/1182-*): opens like a page — icon, title, property values and a
 * body in the page editor — over a local Y.Doc. Body edits are sent as Yjs updates (only what
 * changed since the last save) and merged on the server; title/values/name are saved as fields.
 * Everything autosaves; closing flushes what is pending.
 */
export function RowTemplateEditor({
  templateId,
  collectionId,
  collectionTitle,
  wsId,
  fields,
  members,
  me,
  readOnly,
  onClose,
}: {
  templateId: string
  collectionId: string
  collectionTitle: string
  wsId: string
  fields: CollectionField[]
  members?: MemberDTO[]
  me: UserDTO
  readOnly: boolean
  onClose: () => void
}) {
  const t = useT()
  const qc = useQueryClient()
  const [doc] = useState(() => new Y.Doc())
  const [tpl, setTpl] = useState<RowTemplateDTO | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [save, setSave] = useState<SaveState>('idle')
  const [iconOpen, setIconOpen] = useState(false)
  const iconRef = useRef<HTMLButtonElement>(null)
  // Last state vector the server has (body updates are diffs from it).
  const savedSv = useRef<Uint8Array | null>(null)
  const metaTimer = useRef(0)
  const bodyTimer = useRef(0)
  const pendingMeta = useRef<Partial<RowTemplateDTO>>({})
  const inflight = useRef<Promise<unknown>>(Promise.resolve())

  useEffect(() => {
    let alive = true
    fetchRowTemplate(templateId)
      .then((r) => {
        if (!alive) return
        if (r.state) Y.applyUpdate(doc, fromBase64(r.state), 'load')
        savedSv.current = Y.encodeStateVector(doc)
        setTpl(r.template)
      })
      .catch(() => alive && setLoadError(true))
    return () => {
      alive = false
    }
  }, [templateId, doc])
  useEffect(() => () => doc.destroy(), [doc])

  // One save at a time, in order (body diffs must reach the server in sequence).
  const enqueue = useCallback((fn: () => Promise<unknown>) => {
    setSave('saving')
    const p = inflight.current
      .catch(() => undefined)
      .then(fn)
      .then(
        () => setSave('saved'),
        () => setSave('error'),
      )
    inflight.current = p
    return p
  }, [])

  const flushBody = useCallback(() => {
    window.clearTimeout(bodyTimer.current)
    if (readOnly || !savedSv.current) return Promise.resolve()
    const sv = savedSv.current
    const update = Y.encodeStateAsUpdate(doc, sv)
    // An empty diff is 2 bytes (no structs, empty delete set).
    if (update.length <= 2) return Promise.resolve()
    const next = Y.encodeStateVector(doc)
    return enqueue(async () => {
      await updateRowTemplate(templateId, { update: toBase64(update) })
      savedSv.current = next
    })
  }, [doc, enqueue, readOnly, templateId])

  const flushMeta = useCallback(() => {
    window.clearTimeout(metaTimer.current)
    const m = pendingMeta.current
    if (readOnly || Object.keys(m).length === 0) return Promise.resolve()
    pendingMeta.current = {}
    return enqueue(() =>
      updateRowTemplate(templateId, {
        ...(m.name !== undefined ? { name: m.name.trim() || t('rowTpl.newTemplateName') } : {}),
        ...(m.icon !== undefined ? { icon: m.icon } : {}),
        ...(m.title !== undefined ? { title: m.title } : {}),
        ...(m.props !== undefined ? { props: m.props } : {}),
        ...(m.isDefault !== undefined ? { isDefault: m.isDefault } : {}),
      }),
    )
  }, [enqueue, readOnly, templateId, t])

  // Body: save 800 ms after the last change.
  useEffect(() => {
    const onUpdate = (_u: Uint8Array, origin: unknown) => {
      if (origin === 'load' || readOnly) return
      window.clearTimeout(bodyTimer.current)
      bodyTimer.current = window.setTimeout(() => void flushBody(), 800)
    }
    doc.on('update', onUpdate)
    return () => doc.off('update', onUpdate)
  }, [doc, flushBody, readOnly])

  const change = (patch: Partial<RowTemplateDTO>) => {
    if (!tpl || readOnly) return
    setTpl({ ...tpl, ...patch })
    pendingMeta.current = { ...pendingMeta.current, ...patch }
    window.clearTimeout(metaTimer.current)
    metaTimer.current = window.setTimeout(() => void flushMeta(), 500)
  }

  const close = useCallback(() => {
    void Promise.all([flushMeta(), flushBody()]).finally(() => {
      void inflight.current.finally(() => qc.invalidateQueries({ queryKey: qkRowTemplates(collectionId) }))
      onClose()
    })
  }, [flushMeta, flushBody, onClose, qc, collectionId])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !iconOpen && !document.querySelector('.bn-suggestion-menu, [data-floating-ui-portal]')) close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [close, iconOpen])

  const editable = fields.filter((f) => f.type !== 'rollup' && f.type !== 'formula')
  const setProp = (fieldId: string, value: unknown) => {
    if (!tpl) return
    const next = { ...tpl.props }
    if (value === null || value === undefined || value === '') delete next[fieldId]
    else next[fieldId] = value
    change({ props: next })
  }

  return createPortal(
    <div
      className="nd-backdrop fixed inset-0 z-50 flex items-stretch justify-center bg-black/40 sm:p-6"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={tpl?.name ?? t('rowTpl.modalTitle')}
        className="nd-pop flex h-full w-full max-w-4xl flex-col overflow-hidden border-line bg-app shadow-xl sm:rounded-lg sm:border"
      >
        {/* banner: what is being edited, save state, name, default, close */}
        <div className="flex flex-wrap items-center gap-2 border-b border-line bg-accent/10 px-4 py-2 text-sm">
          <TemplateIcon size={15} />
          <span className="min-w-0 flex-1 truncate text-ink">
            {t('rowTpl.editingBanner', { name: collectionTitle || t('collection.exportFileName') })}
          </span>
          <span className="text-xs text-sub" aria-live="polite">
            {save === 'saving' ? t('rowTpl.saving') : save === 'saved' ? t('rowTpl.saved') : save === 'error' ? t('rowTpl.saveFailed') : ''}
          </span>
          <button
            type="button"
            onClick={close}
            className="rounded-md bg-accent px-3 py-1 text-xs font-medium text-white hover:opacity-90"
          >
            {t('rowTpl.done')}
          </button>
          <button
            type="button"
            onClick={close}
            aria-label={t('common.close')}
            className="rounded-md p-1 text-sub hover:bg-hover hover:text-ink"
          >
            <XIcon size={16} />
          </button>
        </div>
        {readOnly && <div className="border-b border-line px-4 py-1.5 text-xs text-sub">{t('rowTpl.readOnly')}</div>}

        {loadError ? (
          <div className="p-10 text-center text-sm text-sub">{t('collection.loadFailed')}</div>
        ) : !tpl ? (
          <div className="flex justify-center py-16">
            <Spinner size={22} />
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-3xl px-4 pb-24 pt-6 sm:px-0">
              <div className="nd-doc-head">
              {/* template name + default flag (meta, not part of the row) */}
              <div className="mb-6 flex flex-wrap items-center gap-3 text-sm">
                <label className="flex min-w-0 flex-1 items-center gap-2">
                  <span className="shrink-0 text-sub">{t('rowTpl.name')}</span>
                  <input
                    value={tpl.name}
                    onChange={(e) => change({ name: e.target.value })}
                    disabled={readOnly}
                    maxLength={60}
                    className="min-w-0 flex-1 rounded-md border border-line bg-app px-2 py-1 text-ink outline-none focus:border-accent"
                  />
                </label>
                <label className="flex items-center gap-1.5 text-sub">
                  <input
                    type="checkbox"
                    checked={tpl.isDefault}
                    disabled={readOnly}
                    onChange={(e) => change({ isDefault: e.target.checked })}
                  />
                  {t('rowTpl.isDefault')}
                </label>
              </div>

              {/* icon + title pattern, styled like a page title */}
              <button
                ref={iconRef}
                type="button"
                disabled={readOnly}
                onClick={() => setIconOpen((v) => !v)}
                className="mb-1 rounded-md px-1 text-4xl leading-tight hover:bg-hover disabled:hover:bg-transparent"
                aria-label="Icon"
              >
                {tpl.icon || <span className="text-base text-sub">＋ 🙂</span>}
              </button>
              {iconOpen && (
                <EmojiPicker
                  anchorRef={iconRef}
                  hasIcon={!!tpl.icon}
                  onSelect={(emoji) => {
                    change({ icon: emoji })
                    setIconOpen(false)
                  }}
                  onRemove={() => {
                    change({ icon: null })
                    setIconOpen(false)
                  }}
                  onClose={() => setIconOpen(false)}
                />
              )}
              <input
                value={tpl.title}
                onChange={(e) => change({ title: e.target.value })}
                disabled={readOnly}
                maxLength={300}
                placeholder={t('rowTpl.titlePlaceholder')}
                className="w-full bg-transparent text-3xl font-bold text-ink outline-none placeholder:text-sub/50"
              />
              <p className="mt-1 text-xs text-sub">
                {t('rowTpl.variablesHint')}{' '}
                {['{{date}}', '{{date:M/D}}', '{{weekday}}', '{{author}}', '{{input:…|…}}'].map((v) => (
                  <code key={v} className="mr-1 rounded bg-hover px-1">
                    {v}
                  </code>
                ))}
              </p>

              {/* property values */}
              {editable.length > 0 && (
                <div className="mt-5 border-y border-line py-2">
                  <div className="mb-1 text-xs font-medium uppercase tracking-wide text-sub">{t('rowTpl.properties')}</div>
                  {editable.map((f) => (
                    <div key={f.id} className="flex flex-col gap-1 py-1 sm:flex-row sm:items-center sm:gap-3">
                      <div className="w-40 shrink-0 truncate text-sm text-sub">{f.name}</div>
                      <div className="min-w-0 flex-1">
                        <DefaultValueEditor
                          field={f}
                          value={tpl.props[f.id]}
                          members={members}
                          readOnly={readOnly}
                          onChange={(v) => setProp(f.id, v)}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              )}

              </div>
              {/* body: the page editor */}
              <div className="mt-4">
                <LocalDocEditor
                  doc={doc}
                  wsId={wsId}
                  uploadPageId={collectionId}
                  me={me}
                  readOnly={readOnly}
                  placeholder={t('rowTpl.bodyPlaceholder')}
                />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}
