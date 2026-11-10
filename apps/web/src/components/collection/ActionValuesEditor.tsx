// Values an action sets (button actions and automations, docs/adr/2240-*): one row per field, typed
// by the field. Variables are stored as typed and resolved where the action runs
// (`resolveActionProps`): dates 'today' / 'today+7', people 'me' / 'creator', relations 'this',
// `{{today}}` `{{me}}` `{{page}}` inside text. Shared by the button settings and the automation editor.
import { useState } from 'react'
import type { CollectionField, MemberDTO } from '@inkling/shared'
import { ACTION_PROPS_MAX, FIELD_CAPS } from '@inkling/shared'
import { useT } from '../../i18n'
import { XIcon } from '../Icons'
import { DefaultValueEditor } from './RowTemplateDefaults'

const INPUT =
  'w-full rounded-md border border-line bg-app px-2 py-1 text-sm text-ink outline-none focus:border-accent disabled:opacity-70'

/** Fields an action may write (no formulas, rollups or automatic values). */
export function writableFields(fields: CollectionField[]): CollectionField[] {
  return fields.filter((f) => FIELD_CAPS[f.type]?.write)
}

/** The value a field gets when it is added to the list. */
function initialValue(f: CollectionField): unknown {
  switch (f.type) {
    case 'date':
      return 'today'
    case 'checkbox':
      return true
    case 'person':
      return 'me'
    case 'relation':
      return ['this']
    case 'select':
      return f.options?.[0]?.id ?? null
    case 'multiSelect':
      return []
    case 'number':
      return 0
    default:
      return ''
  }
}

function ValueInput({
  field,
  value,
  members,
  mode,
  readOnly,
  onChange,
}: {
  field: CollectionField
  value: unknown
  members?: MemberDTO[]
  mode: 'button' | 'automation'
  readOnly: boolean
  onChange: (v: unknown) => void
}) {
  const t = useT()
  switch (field.type) {
    case 'text':
    case 'url':
    case 'email':
    case 'phone':
      return (
        <input
          className={INPUT}
          name={`value-${field.id}`}
          aria-label={field.name}
          value={typeof value === 'string' ? value : ''}
          disabled={readOnly}
          maxLength={2000}
          placeholder={t('automation.value.textHint')}
          onChange={(e) => onChange(e.target.value)}
        />
      )
    case 'person':
      return (
        <select
          className={INPUT}
          name={`value-${field.id}`}
          aria-label={field.name}
          disabled={readOnly}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value || null)}
        >
          <option value="">{t('rowTpl.noValue')}</option>
          <option value="me">{mode === 'button' ? t('button.value.me') : t('automation.value.me')}</option>
          {mode === 'automation' && <option value="creator">{t('automation.value.creator')}</option>}
          {(members ?? []).map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      )
    case 'relation':
      return (
        <select
          className={INPUT}
          name={`value-${field.id}`}
          aria-label={field.name}
          disabled={readOnly}
          value={Array.isArray(value) && value.includes('this') ? 'this' : ''}
          onChange={(e) => onChange(e.target.value ? ['this'] : null)}
        >
          <option value="">{t('rowTpl.noValue')}</option>
          <option value="this">{mode === 'button' ? t('button.value.this') : t('automation.value.this')}</option>
        </select>
      )
    default:
      return <DefaultValueEditor field={field} value={value} members={members} readOnly={readOnly} onChange={onChange} />
  }
}

/** Field values of an action (`props`): add a field, set its value, remove it. */
export function ActionValuesEditor({
  fields,
  props,
  members,
  mode,
  readOnly = false,
  onChange,
}: {
  fields: CollectionField[]
  props: Record<string, unknown>
  members?: MemberDTO[]
  mode: 'button' | 'automation'
  readOnly?: boolean
  onChange: (next: Record<string, unknown>) => void
}) {
  const t = useT()
  const [pick, setPick] = useState('')
  const byId = new Map(fields.map((f) => [f.id, f]))
  const keys = Object.keys(props)
  const addable = writableFields(fields).filter((f) => !(f.id in props))
  const set = (k: string, v: unknown) => onChange({ ...props, [k]: v })
  const remove = (k: string) => {
    const next = { ...props }
    delete next[k]
    onChange(next)
  }
  return (
    <div className="flex flex-col gap-1.5">
      {keys.length === 0 && <p className="text-xs text-sub">{t('automation.value.none')}</p>}
      {keys.map((k) => {
        const f = byId.get(k)
        return (
          <div key={k} className="flex items-start gap-2">
            <span className="w-28 shrink-0 truncate pt-1 text-xs text-sub" title={f?.name ?? k}>
              {f?.name ?? t('automation.value.deletedField')}
            </span>
            <div className="min-w-0 flex-1">
              {f ? (
                <ValueInput field={f} value={props[k]} members={members} mode={mode} readOnly={readOnly} onChange={(v) => set(k, v)} />
              ) : (
                <span className="text-xs text-sub">{t('automation.value.deletedHint')}</span>
              )}
              {f?.type === 'date' && <p className="mt-0.5 text-[11px] text-sub">{t('automation.value.dateHint')}</p>}
            </div>
            {!readOnly && (
              <button
                type="button"
                onClick={() => remove(k)}
                aria-label={t('automation.value.remove')}
                title={t('automation.value.remove')}
                className="rounded p-1 text-sub hover:bg-hover hover:text-red-600"
              >
                <XIcon size={13} />
              </button>
            )}
          </div>
        )
      })}
      {!readOnly && addable.length > 0 && keys.length < ACTION_PROPS_MAX && (
        <select
          className={`${INPUT} w-auto self-start text-xs`}
          name="add-value-field"
          aria-label={t('automation.value.add')}
          value={pick}
          onChange={(e) => {
            const f = byId.get(e.target.value)
            setPick('')
            if (f) set(f.id, initialValue(f))
          }}
        >
          <option value="">{t('automation.value.add')}</option>
          {addable.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
      )}
    </div>
  )
}
