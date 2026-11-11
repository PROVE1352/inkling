// Editor of one collection automation (docs/adr/2240-* .. 2243-*): name, trigger, an optional
// condition and up to AUTOMATION_ACTIONS_MAX actions. Drafts may be half filled; saving validates
// with the shared schema. The condition is a flat "all of" list here; a tree made elsewhere (any /
// NOT / groups, e.g. by an agent) is shown as kept and sent back unchanged unless cleared.
import { useState } from 'react'
import type {
  AutomationAction,
  AutomationDTO,
  AutomationInput,
  AutomationTrigger,
  CollectionField,
  FieldType,
  FilterCondition,
  FilterOp,
  MemberDTO,
  ViewFilter,
} from '@inkling/shared'
import { AUTOMATION_ACTIONS_MAX, VIEW_FILTER_MAX_ITEMS, automationInputSchema, isFlatAndFilter } from '@inkling/shared'
import { useT, type TKey } from '../../i18n'
import { useAgentConnections } from '../../teamAgentsApi'
import { useCreateAutomation, useUpdateAutomation } from '../../lib/automationsApi'
import { AddRowEditor, WebhookPicker, keyed, type ActionDraft } from '../blocks/ButtonSettings'
import { ActionValuesEditor } from './ActionValuesEditor'
import { useFeatureOff } from '../quota/features'
import { PlusIcon, TrashIcon, XIcon } from '../Icons'

type ActionType = AutomationAction['type']
const ACTION_TYPES: ActionType[] = ['setFields', 'assign', 'notify', 'webhook', 'addRow', 'assignAgent']

const INPUT =
  'w-full rounded-md border border-line bg-app px-2 py-1 text-sm text-ink outline-none focus:border-accent disabled:opacity-70'
const SMALL = 'rounded border border-line bg-app px-1.5 py-1 text-xs text-ink outline-none focus-visible:border-accent'
const LABEL = 'mb-0.5 block text-[11px] font-medium text-sub'

export const automationActionKey = (type: ActionType): TKey => `automation.action.${type}` as TKey

const OP_KEY: Record<FilterOp, TKey> = {
  contains: 'filter.opContains',
  eq: 'filter.opEq',
  ne: 'filter.opNe',
  empty: 'filter.opEmpty',
  notEmpty: 'filter.opNotEmpty',
  gt: 'filter.opGt',
  lt: 'filter.opLt',
}

// The operators the view filter offers per type (ViewSettings.tsx keeps the same list).
function opsForType(type: FieldType): FilterOp[] {
  switch (type) {
    case 'number':
    case 'date':
    case 'createdTime':
    case 'editedTime':
    case 'uniqueId':
      return ['eq', 'ne', 'gt', 'lt', 'empty', 'notEmpty']
    case 'select':
    case 'person':
    case 'createdBy':
    case 'editedBy':
      return ['eq', 'ne', 'empty', 'notEmpty']
    case 'multiSelect':
      return ['contains', 'empty', 'notEmpty']
    case 'checkbox':
      return ['eq']
    case 'relation':
      return ['empty', 'notEmpty']
    case 'rollup':
    case 'formula':
      return ['eq', 'ne', 'gt', 'lt', 'contains', 'empty', 'notEmpty']
    default:
      return ['contains', 'eq', 'ne', 'empty', 'notEmpty']
  }
}

/** A value input typed by the field: option, true/false, number, date or text. */
function TypedValue({
  field,
  value,
  members,
  name,
  onChange,
}: {
  field: CollectionField
  value: string | number | boolean | undefined
  members?: MemberDTO[]
  name: string
  onChange: (v: string | number | boolean) => void
}) {
  const t = useT()
  if (field.type === 'select' || field.type === 'multiSelect') {
    return (
      <select className={SMALL} name={name} aria-label={field.name} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)}>
        <option value="">{t('filter.choose')}</option>
        {(field.options ?? []).map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
    )
  }
  if (field.type === 'checkbox') {
    return (
      <select className={SMALL} name={name} aria-label={field.name} value={value ? 'true' : 'false'} onChange={(e) => onChange(e.target.value === 'true')}>
        <option value="true">{t('filter.checked')}</option>
        <option value="false">{t('filter.unchecked')}</option>
      </select>
    )
  }
  if (field.type === 'person' || field.type === 'createdBy' || field.type === 'editedBy') {
    return (
      <select className={SMALL} name={name} aria-label={field.name} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)}>
        <option value="">{t('filter.choose')}</option>
        {(members ?? []).map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}
          </option>
        ))}
      </select>
    )
  }
  return (
    <input
      className={`${SMALL} w-32`}
      name={name}
      aria-label={field.name}
      type={field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'}
      value={value === undefined ? '' : String(value)}
      onChange={(e) => onChange(field.type === 'number' ? Number(e.target.value) : e.target.value)}
    />
  )
}

function TriggerEditor({
  trigger,
  fields,
  members,
  onChange,
}: {
  trigger: Partial<AutomationTrigger> & { type: AutomationTrigger['type'] }
  fields: CollectionField[]
  members?: MemberDTO[]
  onChange: (t: Partial<AutomationTrigger> & { type: AutomationTrigger['type'] }) => void
}) {
  const t = useT()
  const fieldId = 'fieldId' in trigger ? trigger.fieldId : undefined
  const field = fields.find((f) => f.id === fieldId)
  const dateFields = fields.filter((f) => f.type === 'date')
  const to = trigger.type === 'fieldChanged' ? trigger.to : undefined
  return (
    <div className="flex flex-col gap-2">
      <select
        className={INPUT}
        name="trigger-type"
        aria-label={t('automation.trigger')}
        value={trigger.type}
        onChange={(e) => {
          const ty = e.target.value as AutomationTrigger['type']
          onChange(ty === 'dateReached' ? { type: ty, daysBefore: 0 } : { type: ty })
        }}
      >
        <option value="rowAdded">{t('automation.trigger.rowAdded')}</option>
        <option value="fieldChanged">{t('automation.trigger.fieldChanged')}</option>
        <option value="dateReached">{t('automation.trigger.dateReached')}</option>
      </select>
      {trigger.type === 'fieldChanged' && (
        <div className="flex flex-col gap-1.5">
          <select
            className={INPUT}
            name="trigger-field"
            aria-label={t('automation.field')}
            value={fieldId ?? ''}
            onChange={(e) => onChange({ type: 'fieldChanged', fieldId: e.target.value || undefined })}
          >
            <option value="">{t('automation.pickField')}</option>
            {fields.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
          {field && (
            <div className="flex flex-wrap items-center gap-2 text-xs text-ink">
              <label className="flex items-center gap-1">
                <input
                  type="checkbox"
                  name="trigger-to-on"
                  checked={to !== undefined}
                  onChange={(e) =>
                    onChange({
                      type: 'fieldChanged',
                      fieldId: field.id,
                      ...(e.target.checked ? { to: field.type === 'checkbox' ? true : field.type === 'number' ? 0 : (field.options?.[0]?.id ?? '') } : {}),
                    })
                  }
                />
                {t('automation.trigger.becomes')}
              </label>
              {to !== undefined && (
                <TypedValue field={field} value={to} members={members} name="trigger-to" onChange={(v) => onChange({ type: 'fieldChanged', fieldId: field.id, to: v })} />
              )}
            </div>
          )}
        </div>
      )}
      {trigger.type === 'dateReached' && (
        <div className="flex flex-wrap items-center gap-2">
          {dateFields.length === 0 ? (
            <p className="text-xs text-sub">{t('automation.noDateFields')}</p>
          ) : (
            <>
              <select
                className={`${INPUT} w-auto`}
                name="trigger-date-field"
                aria-label={t('automation.field')}
                value={fieldId ?? ''}
                onChange={(e) => onChange({ ...trigger, fieldId: e.target.value || undefined } as never)}
              >
                <option value="">{t('automation.pickField')}</option>
                {dateFields.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
              <label className="flex items-center gap-1 text-xs text-ink">
                <input
                  type="number"
                  name="trigger-days-before"
                  aria-label={t('automation.daysBefore')}
                  className={`${SMALL} w-16`}
                  min={0}
                  max={30}
                  value={trigger.type === 'dateReached' ? (trigger.daysBefore ?? 0) : 0}
                  onChange={(e) => onChange({ ...trigger, daysBefore: Math.max(0, Math.min(30, Math.trunc(Number(e.target.value) || 0))) } as never)}
                />
                {t('automation.daysBefore')}
              </label>
            </>
          )}
        </div>
      )}
    </div>
  )
}

function ConditionEditor({
  condition,
  fields,
  members,
  onChange,
}: {
  condition: ViewFilter | null
  fields: CollectionField[]
  members?: MemberDTO[]
  onChange: (c: ViewFilter | null) => void
}) {
  const t = useT()
  const byId = new Map(fields.map((f) => [f.id, f]))
  if (condition && !isFlatAndFilter(condition)) {
    return (
      <div className="flex items-center gap-2 text-xs text-sub">
        <span>{t('automation.conditionKept')}</span>
        <button type="button" onClick={() => onChange(null)} className="rounded px-1.5 py-0.5 text-sub hover:bg-hover hover:text-ink">
          {t('automation.conditionClear')}
        </button>
      </div>
    )
  }
  const items = (condition?.items ?? []) as FilterCondition[]
  const setItems = (next: FilterCondition[]) => onChange(next.length ? { mode: 'and', items: next } : null)
  const setAt = (i: number, c: FilterCondition) => setItems(items.map((x, j) => (j === i ? c : x)))
  return (
    <div className="flex flex-col gap-1.5">
      {items.length === 0 && <p className="text-xs text-sub">{t('automation.conditionNone')}</p>}
      {items.map((c, i) => {
        const f = byId.get(c.fieldId)
        const ops = f ? opsForType(f.type) : (['contains'] as FilterOp[])
        return (
          <div key={i} className="flex flex-wrap items-center gap-1.5">
            <select
              className={`${SMALL} min-w-0 flex-1`}
              name={`condition-field-${i}`}
              aria-label={t('automation.field')}
              value={c.fieldId}
              onChange={(e) => {
                const nf = byId.get(e.target.value)
                setAt(i, { fieldId: e.target.value, op: nf ? opsForType(nf.type)[0] : 'contains' })
              }}
            >
              {fields.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </select>
            <select className={SMALL} name={`condition-op-${i}`} aria-label={t('automation.conditionOp')} value={c.op} onChange={(e) => setAt(i, { ...c, op: e.target.value as FilterOp })}>
              {ops.map((op) => (
                <option key={op} value={op}>
                  {t(OP_KEY[op])}
                </option>
              ))}
            </select>
            {f && c.op !== 'empty' && c.op !== 'notEmpty' && (
              <TypedValue field={f} value={c.value} members={members} name={`condition-value-${i}`} onChange={(v) => setAt(i, { ...c, value: v })} />
            )}
            <button
              type="button"
              onClick={() => setItems(items.filter((_, j) => j !== i))}
              aria-label={t('filter.remove')}
              className="rounded p-1 text-sub hover:bg-hover hover:text-red-600"
            >
              <XIcon size={13} />
            </button>
          </div>
        )
      })}
      {fields.length > 0 && items.length < VIEW_FILTER_MAX_ITEMS && (
        <button
          type="button"
          onClick={() => setItems([...items, { fieldId: fields[0].id, op: opsForType(fields[0].type)[0] }])}
          className="flex items-center gap-1 self-start rounded px-1.5 py-1 text-xs text-sub hover:bg-hover hover:text-ink"
        >
          <PlusIcon size={12} /> {t('automation.conditionAdd')}
        </button>
      )}
    </div>
  )
}

/** People picker: 'me' (who triggered), 'creator' and members, as checkboxes. */
function PeopleChecks({
  value,
  members,
  withSpecial,
  name,
  onChange,
}: {
  value: string[]
  members?: MemberDTO[]
  withSpecial: boolean
  name: string
  onChange: (v: string[]) => void
}) {
  const t = useT()
  const cur = new Set(value)
  const opts: { id: string; label: string }[] = [
    ...(withSpecial
      ? [
          { id: 'me', label: t('automation.value.me') },
          { id: 'creator', label: t('automation.value.creator') },
        ]
      : []),
    ...(members ?? []).map((m) => ({ id: m.id, label: m.name })),
  ]
  return (
    <div className="flex max-h-32 flex-wrap gap-x-3 gap-y-1 overflow-y-auto">
      {opts.map((o) => (
        <label key={o.id} className="flex items-center gap-1 text-xs text-ink">
          <input
            type="checkbox"
            name={`${name}-${o.id}`}
            checked={cur.has(o.id)}
            onChange={() => {
              const next = new Set(cur)
              if (next.has(o.id)) next.delete(o.id)
              else next.add(o.id)
              onChange(opts.filter((x) => next.has(x.id)).map((x) => x.id).slice(0, 20))
            }}
          />
          {o.label}
        </label>
      ))}
    </div>
  )
}

function PersonFieldSelect({ fields, value, onChange }: { fields: CollectionField[]; value: unknown; onChange: (id: string | undefined) => void }) {
  const t = useT()
  const people = fields.filter((f) => f.type === 'person')
  if (!people.length) return <p className="text-xs text-sub">{t('automation.noPersonFields')}</p>
  return (
    <select className={INPUT} name="person-field" aria-label={t('automation.personField')} value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value || undefined)}>
      <option value="">{t('automation.pickField')}</option>
      {people.map((f) => (
        <option key={f.id} value={f.id}>
          {f.name}
        </option>
      ))}
    </select>
  )
}

function ActionEditor({
  wsId,
  draft,
  fields,
  members,
  onChange,
}: {
  wsId: string
  draft: ActionDraft
  fields: CollectionField[]
  members?: MemberDTO[]
  onChange: (d: ActionDraft) => void
}) {
  const t = useT()
  const connections = useAgentConnections(draft.type === 'assignAgent' ? wsId : undefined)
  const type = draft.type as ActionType
  switch (type) {
    case 'setFields':
      return (
        <ActionValuesEditor
          fields={fields}
          props={(draft.props as Record<string, unknown>) ?? {}}
          members={members}
          mode="automation"
          onChange={(props) => onChange({ ...draft, props })}
        />
      )
    case 'assign':
      return (
        <div className="flex flex-col gap-1.5">
          <PersonFieldSelect fields={fields} value={draft.fieldId} onChange={(id) => onChange({ ...draft, fieldId: id })} />
          <PeopleChecks
            name="assign-to"
            value={Array.isArray(draft.to) ? (draft.to as string[]) : []}
            members={members}
            withSpecial
            onChange={(to) => onChange({ ...draft, to })}
          />
        </div>
      )
    case 'notify': {
      const target = draft.fieldId !== undefined ? 'field' : draft.creator ? 'creator' : 'people'
      return (
        <div className="flex flex-col gap-1.5">
          <div className="flex flex-wrap gap-3 text-xs text-ink">
            {(['field', 'creator', 'people'] as const).map((k) => (
              <label key={k} className="flex items-center gap-1">
                <input
                  type="radio"
                  name={`notify-target-${String(draft._k)}`}
                  checked={target === k}
                  onChange={() =>
                    onChange({
                      type: 'notify',
                      message: draft.message,
                      _k: draft._k,
                      ...(k === 'field' ? { fieldId: '' } : k === 'creator' ? { creator: true } : { userIds: [] }),
                    } as ActionDraft)
                  }
                />
                {t(`automation.notify.${k}` as TKey)}
              </label>
            ))}
          </div>
          {target === 'field' && <PersonFieldSelect fields={fields} value={draft.fieldId} onChange={(id) => onChange({ ...draft, fieldId: id ?? '' })} />}
          {target === 'people' && (
            <PeopleChecks
              name="notify-people"
              value={Array.isArray(draft.userIds) ? (draft.userIds as string[]) : []}
              members={members}
              withSpecial={false}
              onChange={(userIds) => onChange({ ...draft, userIds })}
            />
          )}
          <input
            className={INPUT}
            name="notify-message"
            aria-label={t('automation.notify.message')}
            maxLength={500}
            placeholder={t('automation.notify.message')}
            value={typeof draft.message === 'string' ? draft.message : ''}
            onChange={(e) => onChange({ ...draft, message: e.target.value })}
          />
        </div>
      )
    }
    case 'webhook':
      return <WebhookPicker wsId={wsId} draft={draft} onChange={onChange} />
    case 'addRow':
      return <AddRowEditor wsId={wsId} draft={draft} mode="automation" onChange={onChange} />
    case 'assignAgent': {
      const list = connections.data ?? []
      return (
        <div className="flex flex-col gap-1.5">
          <PersonFieldSelect fields={fields} value={draft.fieldId} onChange={(id) => onChange({ ...draft, fieldId: id })} />
          {connections.data && !list.length ? (
            <p className="text-xs text-sub">{t('automation.noConnections')}</p>
          ) : (
            <select
              className={INPUT}
              name="agent-connection"
              aria-label={t('automation.connection')}
              value={typeof draft.connection === 'string' ? draft.connection : ''}
              onChange={(e) => onChange({ ...draft, connection: e.target.value || undefined })}
            >
              <option value="">{t('automation.pickConnection')}</option>
              {list.map((c) => (
                <option key={c.ref} value={c.ref}>
                  {c.userName} · {c.client}
                </option>
              ))}
            </select>
          )}
        </div>
      )
    }
  }
}

function newDraft(type: ActionType): ActionDraft {
  switch (type) {
    case 'setFields':
      return keyed({ type, props: {} } as ActionDraft)
    case 'assign':
      return keyed({ type, to: ['me'] } as ActionDraft)
    case 'notify':
      return keyed({ type, creator: true } as ActionDraft)
    default:
      return keyed({ type } as ActionDraft)
  }
}

/** A clean action from a draft (empty strings, empty lists and `_` keys dropped); the schema decides. */
function cleanAction(d: ActionDraft): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(d)) {
    if (k.startsWith('_') || v === undefined || v === '') continue
    if (k === 'props' && d.type === 'addRow' && v && typeof v === 'object' && !Object.keys(v).length) continue
    if (k === 'userIds' && Array.isArray(v) && !v.length) continue
    out[k] = v
  }
  return out
}

type TriggerDraft = Partial<AutomationTrigger> & { type: AutomationTrigger['type'] }

export function AutomationEditor({
  wsId,
  collectionId,
  fields,
  members,
  initial,
  onDone,
}: {
  wsId: string
  collectionId: string
  fields: CollectionField[]
  members?: MemberDTO[]
  /** null: a new rule */
  initial: AutomationDTO | null
  onDone: () => void
}) {
  const t = useT()
  const hooksOff = useFeatureOff('automations-webhooks') // the webhook action is off on this server (docs/adr/2507-*)
  const create = useCreateAutomation(collectionId)
  const update = useUpdateAutomation(collectionId)
  const [name, setName] = useState(initial?.name ?? '')
  const [trigger, setTrigger] = useState<TriggerDraft>(initial?.trigger ?? { type: 'rowAdded' })
  const [condition, setCondition] = useState<ViewFilter | null>(initial?.condition ?? null)
  const [drafts, setDrafts] = useState<ActionDraft[]>(() => (initial?.actions ?? []).map((a) => keyed({ ...a } as ActionDraft)))
  const [addType, setAddType] = useState<ActionType>('setFields')
  const [error, setError] = useState<string | null>(null)
  const busy = create.isPending || update.isPending

  const setAt = (i: number, d: ActionDraft) => setDrafts((list) => list.map((x, j) => (j === i ? { ...d, _k: x._k } : x)))
  const move = (i: number, by: -1 | 1) =>
    setDrafts((list) => {
      const j = i + by
      if (j < 0 || j >= list.length) return list
      const next = [...list]
      ;[next[i], next[j]] = [next[j], next[i]]
      return next
    })

  const save = () => {
    if (!name.trim()) return setError(t('automation.needName'))
    if (!drafts.length) return setError(t('automation.needAction'))
    // an empty "becomes" or condition value would save a rule that never matches
    if (trigger.type === 'fieldChanged' && (trigger.to === '' || Number.isNaN(trigger.to))) return setError(t('automation.incompleteTrigger'))
    const conds = condition && isFlatAndFilter(condition) ? (condition.items as FilterCondition[]) : []
    if (conds.some((c) => c.op !== 'empty' && c.op !== 'notEmpty' && (c.value === undefined || c.value === '' || Number.isNaN(c.value))))
      return setError(t('automation.incompleteCondition'))
    for (let i = 0; i < drafts.length; i++) {
      const d = drafts[i]
      const noTarget = d.type === 'notify' && !d.fieldId && !d.creator && !(Array.isArray(d.userIds) && d.userIds.length)
      if (noTarget) return setError(t('automation.incompleteAction', { n: i + 1 }))
    }
    const input = {
      name: name.trim(),
      trigger,
      condition: condition && condition.items.length ? condition : null,
      actions: drafts.map(cleanAction),
    }
    const r = automationInputSchema.safeParse(input)
    if (!r.success) {
      const path = r.error.issues[0]?.path ?? []
      if (path[0] === 'actions' && typeof path[1] === 'number') return setError(t('automation.incompleteAction', { n: path[1] + 1 }))
      if (path[0] === 'trigger') return setError(t('automation.incompleteTrigger'))
      return setError(t('automation.invalid'))
    }
    setError(null)
    const done = { onSuccess: onDone, onError: (e: Error) => setError(e.message) }
    if (initial) update.mutate({ id: initial.id, patch: r.data as AutomationInput }, done)
    else create.mutate(r.data as AutomationInput, done)
  }

  return (
    <div className="flex flex-col gap-4 text-sm" data-automation-editor>
      <label>
        <span className={LABEL}>{t('automation.name')}</span>
        <input className={INPUT} name="automation-name" maxLength={80} value={name} placeholder={t('automation.namePlaceholder')} onChange={(e) => setName(e.target.value)} />
      </label>

      <section>
        <span className={LABEL}>{t('automation.trigger')}</span>
        <TriggerEditor trigger={trigger} fields={fields} members={members} onChange={setTrigger} />
      </section>

      <section>
        <span className={LABEL}>{t('automation.condition')}</span>
        <ConditionEditor condition={condition} fields={fields} members={members} onChange={setCondition} />
      </section>

      <section>
        <span className={LABEL}>{t('automation.actions')}</span>
        <ol className="flex flex-col gap-2">
          {drafts.map((d, i) => (
            <li key={String(d._k ?? i)} className="rounded-md border border-line p-2" data-automation-action={d.type}>
              <div className="mb-2 flex items-center gap-1">
                <span className="text-xs font-medium text-ink">
                  {i + 1}. {t(automationActionKey(d.type as ActionType))}
                </span>
                <span className="ml-auto flex items-center gap-0.5">
                  <button
                    type="button"
                    disabled={i === 0}
                    onClick={() => move(i, -1)}
                    aria-label={t('button.moveUp')}
                    title={t('button.moveUp')}
                    className="rounded px-1.5 text-sub hover:bg-hover hover:text-ink disabled:opacity-30"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    disabled={i === drafts.length - 1}
                    onClick={() => move(i, 1)}
                    aria-label={t('button.moveDown')}
                    title={t('button.moveDown')}
                    className="rounded px-1.5 text-sub hover:bg-hover hover:text-ink disabled:opacity-30"
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    onClick={() => setDrafts((list) => list.filter((_, j) => j !== i))}
                    aria-label={t('button.removeAction')}
                    title={t('button.removeAction')}
                    className="rounded p-1 text-sub hover:bg-hover hover:text-red-600"
                  >
                    <TrashIcon size={13} />
                  </button>
                </span>
              </div>
              <ActionEditor wsId={wsId} draft={d} fields={fields} members={members} onChange={(nd) => setAt(i, nd)} />
            </li>
          ))}
        </ol>
        {drafts.length < AUTOMATION_ACTIONS_MAX && (
          <div className="mt-2 flex items-center gap-1.5">
            <select
              className={`${INPUT} w-auto text-xs`}
              name="new-automation-action-type"
              aria-label={t('button.actionType')}
              value={addType}
              onChange={(e) => setAddType(e.target.value as ActionType)}
            >
              {ACTION_TYPES.filter((ty) => ty !== 'webhook' || !hooksOff).map((ty) => (
                <option key={ty} value={ty}>
                  {t(automationActionKey(ty))}
                </option>
              ))}
            </select>
            <button
              type="button"
              data-automation-add-action
              onClick={() => setDrafts((list) => [...list, newDraft(addType)])}
              className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-sub hover:bg-hover hover:text-ink"
            >
              <PlusIcon size={12} /> {t('button.addAction')}
            </button>
          </div>
        )}
      </section>

      {error && (
        <p className="text-xs text-red-600" role="alert" data-automation-error>
          {error}
        </p>
      )}
      <div className="flex items-center justify-end gap-2">
        <button type="button" onClick={onDone} className="rounded-md px-3 py-1.5 text-sm text-sub hover:bg-hover hover:text-ink">
          {t('button.cancel')}
        </button>
        <button
          type="button"
          data-automation-save
          disabled={busy}
          onClick={save}
          className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-60"
        >
          {t('button.save')}
        </button>
      </div>
    </div>
  )
}
