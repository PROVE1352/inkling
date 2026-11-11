/**
 * Form view (docs/adr/1820-*, 1821-*): members fill it to add a row; editors choose the questions
 * (order, required, help text) and owners/admins turn on a public link. The public page
 * (pages/PublicForm.tsx) renders the same FormFill with the questions the server hands visitors.
 */
import { useState } from 'react'
import { FeatureOn } from '../quota/FeatureOn'
import type { FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  defaultFormSettings,
  FORM_FIELD_TYPES,
  FORM_TITLE_FIELD,
  formSubmissionProps,
  PUBLIC_FORM_FIELD_TYPES,
} from '@inkling/shared'
import type { CollectionField, CollectionViewDTO, FormLinkDTO, FormProblem, FormSettings, MemberDTO, ViewConfig } from '@inkling/shared'
import { api } from '../../api'
import { useT } from '../../i18n'
import { copyText } from '../../lib/clipboard'
import { addableQuestions, memberQuestions, moveQuestion } from '../../lib/forms'
import type { FormQuestion } from '../../lib/forms'
import { useCreateRow } from '../../lib/rowTemplatesApi'
import { toast } from '../../lib/toast'
import { useCollectionReadOnly } from './readOnlyContext'

const INPUT =
  'w-full rounded border border-line bg-app px-2 py-1.5 text-sm text-ink outline-none focus-visible:border-accent'

/** Public form address on this origin. */
export function publicFormUrl(token: string): string {
  return `${location.origin}/f/${token}`
}

// ---------------------------------------------------------------------------
// filling a form (members and visitors)
// ---------------------------------------------------------------------------

export function FormFill({
  title,
  description,
  questions,
  members,
  submitLabel,
  successMessage,
  honeypot,
  check,
  onSubmit,
}: {
  title: string
  description: string
  questions: FormQuestion[]
  members?: MemberDTO[]
  submitLabel?: string | null
  successMessage?: string | null
  /** name of a hidden field people leave empty (public forms) */
  honeypot?: string
  check: (values: Record<string, unknown>) => Record<string, FormProblem>
  onSubmit: (values: Record<string, unknown>, honeypotValue: string) => Promise<void>
}) {
  const t = useT()
  const [values, setValues] = useState<Record<string, unknown>>({})
  const [problems, setProblems] = useState<Record<string, FormProblem>>({})
  const [trap, setTrap] = useState('')
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  const set = (key: string, v: unknown) => {
    setValues((x) => ({ ...x, [key]: v }))
    if (problems[key]) setProblems(({ [key]: _gone, ...rest }) => rest)
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const found = check(values)
    setProblems(found)
    if (Object.keys(found).length) return
    setSending(true)
    setFailure(null)
    try {
      await onSubmit(values, trap)
      setSent(true)
      setValues({})
    } catch (err) {
      const e2 = err as { status?: number; details?: { fields?: Record<string, FormProblem> } }
      if (e2.details?.fields) setProblems(e2.details.fields)
      setFailure(e2.status === 429 ? t('form.tooMany') : t('form.sendFailed'))
    } finally {
      setSending(false)
    }
  }

  if (sent) {
    return (
      <div className="mx-auto max-w-xl rounded-lg border border-line p-6 text-center">
        <p className="whitespace-pre-wrap text-sm text-ink">{successMessage || t('form.sent')}</p>
        <button
          type="button"
          onClick={() => setSent(false)}
          className="mt-4 rounded-md px-3 py-1.5 text-sm text-accent hover:bg-hover"
        >
          {t('form.sendAnother')}
        </button>
      </div>
    )
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="mx-auto flex max-w-xl flex-col gap-4 rounded-lg border border-line p-5" noValidate>
      <div>
        <h2 className="text-lg font-semibold text-ink">{title}</h2>
        {description && <p className="mt-1 whitespace-pre-wrap text-sm text-sub">{description}</p>}
      </div>
      {questions.length === 0 && <p className="text-sm text-sub">{t('form.noQuestions')}</p>}
      {questions.map((q) => (
        <div key={q.key} className="flex flex-col gap-1">
          <label htmlFor={`fq-${q.key}`} className="text-sm font-medium text-ink">
            {q.name}
            {q.required && <span className="ml-0.5 text-red-600">*</span>}
          </label>
          {q.description && <p className="whitespace-pre-wrap text-xs text-sub">{q.description}</p>}
          <QuestionInput q={q} value={values[q.key]} members={members} onChange={(v) => set(q.key, v)} />
          {problems[q.key] && (
            <p className="text-xs text-red-600">{problems[q.key] === 'required' ? t('form.problem.required') : t('form.problem.invalid')}</p>
          )}
        </div>
      ))}
      {honeypot && (
        // Off-screen, not focusable, no autofill: people never fill it (docs/adr/1822-*).
        <div aria-hidden="true" style={{ position: 'absolute', left: '-10000px', width: 1, height: 1, overflow: 'hidden' }}>
          <label>
            {t('form.honeypot')}
            <input type="text" name={honeypot} tabIndex={-1} autoComplete="off" value={trap} onChange={(e) => setTrap(e.target.value)} />
          </label>
        </div>
      )}
      {failure && <p className="text-sm text-red-600">{failure}</p>}
      <div>
        <button
          type="submit"
          disabled={sending || questions.length === 0}
          className="rounded-md bg-accent px-4 py-1.5 text-sm text-white hover:opacity-90 disabled:opacity-60"
        >
          {sending ? t('form.sending') : submitLabel || t('form.submit')}
        </button>
      </div>
    </form>
  )
}

function QuestionInput({
  q,
  value,
  members,
  onChange,
}: {
  q: FormQuestion
  value: unknown
  members?: MemberDTO[]
  onChange: (v: unknown) => void
}) {
  const t = useT()
  const id = `fq-${q.key}`
  const str = typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value)
  switch (q.type) {
    case 'text':
      return <textarea id={id} value={str} onChange={(e) => onChange(e.target.value)} rows={3} maxLength={5000} className={INPUT} />
    case 'number':
      return <input id={id} type="number" inputMode="decimal" value={str} onChange={(e) => onChange(e.target.value)} className={INPUT} />
    case 'date':
      return <input id={id} type="date" value={str} onChange={(e) => onChange(e.target.value)} className={INPUT} />
    case 'url':
      return <input id={id} type="url" value={str} onChange={(e) => onChange(e.target.value)} maxLength={2000} className={INPUT} />
    case 'email':
      return <input id={id} type="email" autoComplete="email" value={str} onChange={(e) => onChange(e.target.value)} maxLength={2000} className={INPUT} />
    case 'phone':
      return <input id={id} type="tel" autoComplete="tel" value={str} onChange={(e) => onChange(e.target.value)} maxLength={2000} className={INPUT} />
    case 'checkbox':
      return (
        <label className="flex items-center gap-2 text-sm text-ink">
          <input id={id} type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
          {t('form.yes')}
        </label>
      )
    case 'select':
      return (
        <select id={id} value={str} onChange={(e) => onChange(e.target.value)} className={INPUT}>
          <option value="">{t('form.choose')}</option>
          {(q.options ?? []).map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
      )
    case 'multiSelect': {
      const list = Array.isArray(value) ? (value as string[]) : []
      return (
        <div id={id} className="flex flex-wrap gap-x-4 gap-y-1">
          {(q.options ?? []).map((o) => (
            <label key={o.id} className="flex items-center gap-1.5 text-sm text-ink">
              <input
                type="checkbox"
                checked={list.includes(o.id)}
                onChange={(e) => onChange(e.target.checked ? [...list, o.id] : list.filter((x) => x !== o.id))}
              />
              {o.name}
            </label>
          ))}
        </div>
      )
    }
    case 'person':
      return (
        <select id={id} value={str} onChange={(e) => onChange(e.target.value)} className={INPUT}>
          <option value="">{t('form.choose')}</option>
          {(members ?? []).map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      )
    default:
      return <input id={id} type="text" value={str} onChange={(e) => onChange(e.target.value)} maxLength={300} className={INPUT} />
  }
}

// ---------------------------------------------------------------------------
// the view: fill, or edit the questions
// ---------------------------------------------------------------------------

export function FormView({
  view,
  fields,
  members,
  wsId,
  pageId,
  onUpdateConfig,
}: {
  view: CollectionViewDTO
  fields: CollectionField[]
  members?: MemberDTO[]
  wsId: string
  pageId: string
  onUpdateConfig: (config: ViewConfig) => void
}) {
  const t = useT()
  const readOnly = useCollectionReadOnly()
  const [editing, setEditing] = useState(false)
  const createRow = useCreateRow(wsId, pageId)
  const settings: FormSettings = view.config.form ?? defaultFormSettings(fields)
  const titleName = t('form.titleQuestion')
  const questions = memberQuestions(settings, fields, titleName)

  const onSubmit = async (values: Record<string, unknown>) => {
    const conv = formSubmissionProps(settings, fields, values, { public: false })
    await createRow.mutateAsync({ template: null, title: conv.title, props: conv.props })
  }

  return (
    <div className="flex flex-col gap-3 py-3">
      {!readOnly && (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => setEditing((v) => !v)}
            className="rounded-md px-2.5 py-1 text-sm text-sub hover:bg-hover hover:text-ink"
          >
            {editing ? t('form.preview') : t('form.edit')}
          </button>
        </div>
      )}
      {editing && !readOnly ? (
        <FormEditor
          view={view}
          settings={settings}
          fields={fields}
          titleName={titleName}
          onChange={(form) => onUpdateConfig({ ...view.config, form })}
        />
      ) : (
        <FormFill
          key={view.id}
          title={settings.title?.trim() || view.name}
          description={settings.description ?? ''}
          questions={questions}
          members={members}
          submitLabel={settings.submitLabel}
          successMessage={settings.successMessage}
          check={(v) => formSubmissionProps(settings, fields, v, { public: false }).problems}
          onSubmit={onSubmit}
        />
      )}
    </div>
  )
}

function FormEditor({
  view,
  settings,
  fields,
  titleName,
  onChange,
}: {
  view: CollectionViewDTO
  settings: FormSettings
  fields: CollectionField[]
  titleName: string
  onChange: (s: FormSettings) => void
}) {
  const t = useT()
  const byId = new Map(fields.map((f) => [f.id, f]))
  const addable = addableQuestions(settings, fields, (type) => FORM_FIELD_TYPES.has(type))
  const nameOf = (id: string) => (id === FORM_TITLE_FIELD ? titleName : byId.get(id)?.name ?? id)
  const patchQ = (i: number, p: Partial<FormSettings['fields'][number]>) =>
    onChange({ ...settings, fields: settings.fields.map((q, j) => (j === i ? { ...q, ...p } : q)) })
  // Text inputs save on blur, so typing does not send a view update per key.
  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-3 rounded-lg border border-line p-4">
      <label className="flex flex-col gap-1 text-xs text-sub">
        {t('form.formTitle')}
        <input key={`t-${view.id}`} defaultValue={settings.title ?? ''} placeholder={view.name} maxLength={200} onBlur={(e) => onChange({ ...settings, title: e.target.value })} className={INPUT} />
      </label>
      <label className="flex flex-col gap-1 text-xs text-sub">
        {t('form.formDescription')}
        <textarea key={`d-${view.id}`} defaultValue={settings.description ?? ''} rows={2} maxLength={2000} onBlur={(e) => onChange({ ...settings, description: e.target.value })} className={INPUT} />
      </label>
      <div className="text-xs font-medium text-sub">{t('form.questions')}</div>
      <ul className="flex flex-col gap-2">
        {settings.fields.map((q, i) => {
          const f = byId.get(q.fieldId)
          const notPublic = f && !PUBLIC_FORM_FIELD_TYPES.has(f.type)
          return (
            <li key={q.fieldId} className="rounded-md border border-line p-2">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-sm text-ink">
                  {nameOf(q.fieldId)}
                  {notPublic && <span className="ml-1 text-xs text-sub">({t('form.publicNote')})</span>}
                </span>
                <label className="flex items-center gap-1 text-xs text-sub">
                  <input type="checkbox" checked={!!q.required} onChange={(e) => patchQ(i, { required: e.target.checked })} />
                  {t('form.required')}
                </label>
                <button type="button" aria-label={t('form.moveUp')} onClick={() => onChange(moveQuestion(settings, i, -1))} className="rounded px-1 text-sub hover:bg-hover">↑</button>
                <button type="button" aria-label={t('form.moveDown')} onClick={() => onChange(moveQuestion(settings, i, 1))} className="rounded px-1 text-sub hover:bg-hover">↓</button>
                <button
                  type="button"
                  onClick={() => onChange({ ...settings, fields: settings.fields.filter((_, j) => j !== i) })}
                  className="rounded px-1 text-xs text-sub hover:bg-hover hover:text-red-600"
                >
                  {t('form.remove')}
                </button>
              </div>
              <input
                key={`h-${view.id}-${q.fieldId}`}
                defaultValue={q.description ?? ''}
                placeholder={t('form.helpText')}
                maxLength={500}
                onBlur={(e) => patchQ(i, { description: e.target.value || undefined })}
                className={`${INPUT} mt-1.5 text-xs`}
              />
            </li>
          )
        })}
      </ul>
      {addable.length > 0 && (
        <select
          value=""
          onChange={(e) => e.target.value && onChange({ ...settings, fields: [...settings.fields, { fieldId: e.target.value }] })}
          className={INPUT}
        >
          <option value="">{t('form.addQuestion')}</option>
          {addable.map((id) => (
            <option key={id} value={id}>
              {nameOf(id)}
            </option>
          ))}
        </select>
      )}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs text-sub">
          {t('form.submitLabel')}
          <input key={`s-${view.id}`} defaultValue={settings.submitLabel ?? ''} placeholder={t('form.submit')} maxLength={60} onBlur={(e) => onChange({ ...settings, submitLabel: e.target.value })} className={INPUT} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-sub">
          {t('form.successMessage')}
          <input key={`m-${view.id}`} defaultValue={settings.successMessage ?? ''} placeholder={t('form.sent')} maxLength={500} onBlur={(e) => onChange({ ...settings, successMessage: e.target.value })} className={INPUT} />
        </label>
      </div>
      {/* the public form link is off on this server (DISABLED_FEATURES=public-forms, docs/adr/2507-*) */}
      <FeatureOn name="public-forms">
        <FormLinkPanel viewId={view.id} />
      </FeatureOn>
    </div>
  )
}

function FormLinkPanel({ viewId }: { viewId: string }) {
  const t = useT()
  const qc = useQueryClient()
  const key = ['form-link', viewId]
  const status = useQuery({ queryKey: key, queryFn: () => api<FormLinkDTO>(`/api/collection-views/${viewId}/form-link`) })
  const [busy, setBusy] = useState(false)
  const run = async (method: 'POST' | 'DELETE') => {
    setBusy(true)
    try {
      const r = await api<FormLinkDTO>(`/api/collection-views/${viewId}/form-link`, { method, body: '{}' })
      qc.setQueryData(key, r)
    } catch (e) {
      toast({ message: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }
  const d = status.data
  const token = d?.shared ? d.token : null
  return (
    <div className="flex flex-col gap-2 rounded-md border border-line p-3">
      <div className="text-xs font-medium text-sub">{t('form.publicLink')}</div>
      <p className="text-xs text-sub">{token ? t('form.publicOn') : t('form.publicOff')}</p>
      {token ? (
        <div className="flex flex-wrap items-center gap-2">
          <input readOnly value={publicFormUrl(token)} className={`${INPUT} min-w-0 flex-1 text-xs`} onFocus={(e) => e.target.select()} />
          <button
            type="button"
            onClick={() => void copyText(publicFormUrl(token)).then((ok) => ok && toast({ message: t('form.copied') }))}
            className="rounded-md px-2.5 py-1 text-sm text-accent hover:bg-hover"
          >
            {t('form.copyLink')}
          </button>
          <button type="button" disabled={busy} onClick={() => void run('DELETE')} className="rounded-md px-2.5 py-1 text-sm text-sub hover:bg-hover hover:text-red-600">
            {t('form.unpublish')}
          </button>
        </div>
      ) : d?.canPublish ? (
        <div>
          <button type="button" disabled={busy} onClick={() => void run('POST')} className="rounded-md bg-accent px-3 py-1 text-sm text-white hover:opacity-90 disabled:opacity-60">
            {t('form.publish')}
          </button>
        </div>
      ) : (
        <p className="text-xs text-sub">{t('form.onlyManagers')}</p>
      )}
      <p className="text-[11px] text-sub">{t('form.publicNote')}</p>
    </div>
  )
}
