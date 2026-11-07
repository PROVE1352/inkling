import { useEffect, useState } from 'react'
import type { CollectionField, MemberDTO } from '@inkling/shared'
import { useT } from '../../i18n'
import { OptionBadge } from './cells/FieldValue'

const INPUT =
  'w-full rounded-md border border-line bg-app px-2 py-1 text-sm text-ink outline-none focus:border-accent disabled:opacity-70'
const SELECT = `${INPUT} pr-6`

/** Relative date default → editor mode. */
function dateMode(v: unknown): { mode: '' | 'today' | 'rel' | 'fixed'; days: number; date: string } {
  if (typeof v !== 'string' || !v) return { mode: '', days: 7, date: '' }
  if (v === 'today') return { mode: 'today', days: 7, date: '' }
  const m = /^today([+-]\d+)$/.exec(v)
  if (m) return { mode: 'rel', days: Number(m[1]), date: '' }
  return { mode: 'fixed', days: 7, date: v }
}

/**
 * Editor for one property default of a row template (docs/adr/1181-*). Values are stored like row
 * values, except dates (`today`, `today+7`) and people (`me` = whoever adds the row).
 */
export function DefaultValueEditor({
  field,
  value,
  members,
  readOnly,
  onChange,
}: {
  field: CollectionField
  value: unknown
  members?: MemberDTO[]
  readOnly: boolean
  /** null clears the default */
  onChange: (value: unknown) => void
}) {
  const t = useT()
  const [draft, setDraft] = useState(value == null ? '' : String(value))
  useEffect(() => setDraft(value == null ? '' : String(value)), [value])

  switch (field.type) {
    case 'text':
    case 'url':
      return (
        <input
          className={INPUT}
          value={draft}
          disabled={readOnly}
          placeholder={t('rowTpl.noValue')}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => draft !== (value ?? '') && onChange(draft.trim() ? draft : null)}
        />
      )
    case 'number':
      return (
        <input
          className={INPUT}
          inputMode="decimal"
          value={draft}
          disabled={readOnly}
          placeholder={t('rowTpl.noValue')}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            const s = draft.trim()
            if (!s) return onChange(null)
            const n = Number(s)
            if (Number.isFinite(n)) onChange(n)
            else setDraft(value == null ? '' : String(value))
          }}
        />
      )
    case 'checkbox':
      return (
        <select
          className={SELECT}
          disabled={readOnly}
          value={value === true ? '1' : value === false ? '0' : ''}
          onChange={(e) => onChange(e.target.value === '' ? null : e.target.value === '1')}
        >
          <option value="">{t('rowTpl.noValue')}</option>
          <option value="1">{t('rowTpl.checked')}</option>
          <option value="0">{t('rowTpl.unchecked')}</option>
        </select>
      )
    case 'select':
      return (
        <select
          className={SELECT}
          disabled={readOnly}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value || null)}
        >
          <option value="">{t('rowTpl.noValue')}</option>
          {(field.options ?? []).map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
      )
    case 'multiSelect': {
      const cur = new Set(Array.isArray(value) ? (value as string[]) : [])
      const opts = field.options ?? []
      if (!opts.length) return <span className="text-sm text-sub">{t('rowTpl.noValue')}</span>
      return (
        <div className="flex flex-wrap gap-1">
          {opts.map((o) => (
            <button
              key={o.id}
              type="button"
              disabled={readOnly}
              aria-pressed={cur.has(o.id)}
              onClick={() => {
                const next = new Set(cur)
                if (next.has(o.id)) next.delete(o.id)
                else next.add(o.id)
                onChange(next.size ? opts.filter((x) => next.has(x.id)).map((x) => x.id) : null)
              }}
              className={`rounded-md border px-1 py-0.5 ${cur.has(o.id) ? 'border-accent' : 'border-transparent opacity-50 hover:opacity-100'}`}
            >
              <OptionBadge field={field} optionId={o.id} />
            </button>
          ))}
        </div>
      )
    }
    case 'date': {
      const d = dateMode(value)
      return (
        <div className="flex flex-wrap items-center gap-2">
          <select
            className={`${SELECT} w-auto`}
            disabled={readOnly}
            value={d.mode}
            onChange={(e) => {
              const m = e.target.value
              if (m === '') onChange(null)
              else if (m === 'today') onChange('today')
              else if (m === 'rel') onChange(`today+${d.days > 0 ? d.days : 7}`)
              else onChange(new Date().toISOString().slice(0, 10))
            }}
          >
            <option value="">{t('rowTpl.noValue')}</option>
            <option value="today">{t('rowTpl.dateToday')}</option>
            <option value="rel">{t('rowTpl.dateRelative')}</option>
            <option value="fixed">{t('rowTpl.dateFixed')}</option>
          </select>
          {d.mode === 'rel' && (
            <input
              type="number"
              className={`${INPUT} w-20`}
              disabled={readOnly}
              value={d.days}
              min={-999}
              max={999}
              onChange={(e) => {
                const n = Math.trunc(Number(e.target.value))
                if (Number.isFinite(n)) onChange(n === 0 ? 'today' : `today${n > 0 ? '+' : ''}${n}`)
              }}
            />
          )}
          {d.mode === 'fixed' && (
            <input
              type="date"
              className={`${INPUT} w-auto`}
              disabled={readOnly}
              value={d.date}
              onChange={(e) => e.target.value && onChange(e.target.value)}
            />
          )}
        </div>
      )
    }
    case 'person':
      return (
        <select
          className={SELECT}
          disabled={readOnly}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value || null)}
        >
          <option value="">{t('rowTpl.noValue')}</option>
          <option value="me">{t('rowTpl.personCreator')}</option>
          {(members ?? []).map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      )
    default:
      // relation / rollup: set on each row
      return <span className="text-sm text-sub">{t('rowTpl.noDefault')}</span>
  }
}
