import { useEffect, useRef, useState } from 'react'
import type {
  CollectionField,
  CollectionViewDTO,
  FieldType,
  FilterOp,
  MemberDTO,
  ViewConfig,
} from '@inkling/shared'
import { t, type TKey } from '../../i18n'
import { PlusIcon, XIcon } from '../Icons'
import { S } from './strings'

// Dictionary keys, translated at render (never call t() at module level).
const OP_LABEL_KEY: Record<FilterOp, TKey> = {
  contains: 'filter.opContains',
  eq: 'filter.opEq',
  ne: 'filter.opNe',
  empty: 'filter.opEmpty',
  notEmpty: 'filter.opNotEmpty',
  gt: 'filter.opGt',
  lt: 'filter.opLt',
}

function opsForType(type: FieldType): FilterOp[] {
  switch (type) {
    case 'number':
    case 'date':
      return ['eq', 'ne', 'gt', 'lt', 'empty', 'notEmpty']
    case 'select':
    case 'person':
      return ['eq', 'ne', 'empty', 'notEmpty']
    case 'multiSelect':
      return ['contains', 'empty', 'notEmpty']
    case 'checkbox':
      return ['eq']
    case 'relation':
      return ['empty', 'notEmpty']
    case 'rollup':
      return ['eq', 'ne', 'gt', 'lt', 'contains', 'empty', 'notEmpty']
    default:
      return ['contains', 'eq', 'ne', 'empty', 'notEmpty']
  }
}

function needsValue(op: FilterOp): boolean {
  return op !== 'empty' && op !== 'notEmpty'
}

export function ViewSettings({
  view,
  fields,
  members,
  onUpdateConfig,
}: {
  view: CollectionViewDTO
  fields: CollectionField[]
  members?: MemberDTO[]
  onUpdateConfig: (config: ViewConfig) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const config = view.config
  const byId = new Map(fields.map((f) => [f.id, f]))

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const id = window.setTimeout(() => document.addEventListener('mousedown', onDown), 0)
    return () => {
      window.clearTimeout(id)
      document.removeEventListener('mousedown', onDown)
    }
  }, [open])

  const patch = (p: Partial<ViewConfig>) => onUpdateConfig({ ...config, ...p })

  // ---- sort ----
  const sorts = config.sorts ?? []
  const addSort = () => {
    const used = new Set(sorts.map((s) => s.fieldId))
    const f = fields.find((x) => !used.has(x.id))
    if (f) patch({ sorts: [...sorts, { fieldId: f.id, dir: 'asc' as const }] })
  }
  const setSort = (i: number, p: Partial<{ fieldId: string; dir: 'asc' | 'desc' }>) =>
    patch({ sorts: sorts.map((s, j) => (j === i ? { ...s, ...p } : s)) })
  const removeSort = (i: number) => patch({ sorts: sorts.filter((_, j) => j !== i) })

  // ---- filter ----
  const filters = config.filters ?? []
  const addFilter = () => {
    const f = fields[0]
    if (!f) return
    patch({ filters: [...filters, { fieldId: f.id, op: opsForType(f.type)[0] }] })
  }
  const setFilter = (
    i: number,
    p: Partial<{ fieldId: string; op: FilterOp; value: string | number | boolean }>,
  ) => patch({ filters: filters.map((flt, j) => (j === i ? { ...flt, ...p } : flt)) })
  const removeFilter = (i: number) =>
    patch({ filters: filters.filter((_, j) => j !== i) })

  // ---- hidden fields ----
  const hidden = new Set(config.hiddenFields ?? [])
  const toggleHidden = (id: string) => {
    const next = new Set(hidden)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    patch({ hiddenFields: [...next] })
  }

  const selectFields = fields.filter((f) => f.type === 'select')
  const dateFields = fields.filter((f) => f.type === 'date')

  const renderFilterValue = (
    i: number,
    field: CollectionField,
    op: FilterOp,
    value: string | number | boolean | undefined,
  ) => {
    if (!needsValue(op)) return null
    const cls =
      'rounded border border-line bg-app px-1.5 py-1 text-xs text-ink outline-none focus-visible:border-accent'
    if (field.type === 'select' || field.type === 'multiSelect') {
      return (
        <select
          value={String(value ?? '')}
          onChange={(e) => setFilter(i, { value: e.target.value })}
          className={cls}
        >
          <option value="">{t('filter.choose')}</option>
          {(field.options ?? []).map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
      )
    }
    if (field.type === 'person') {
      return (
        <select
          value={String(value ?? '')}
          onChange={(e) => setFilter(i, { value: e.target.value })}
          className={cls}
        >
          <option value="">{t('filter.choose')}</option>
          {(members ?? []).map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      )
    }
    if (field.type === 'checkbox') {
      return (
        <select
          value={value ? 'true' : 'false'}
          onChange={(e) => setFilter(i, { value: e.target.value === 'true' })}
          className={cls}
        >
          <option value="true">{t('filter.checked')}</option>
          <option value="false">{t('filter.unchecked')}</option>
        </select>
      )
    }
    return (
      <input
        type={field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'}
        value={value === undefined ? '' : String(value)}
        onChange={(e) =>
          setFilter(i, {
            value: field.type === 'number' ? Number(e.target.value) : e.target.value,
          })
        }
        className={`${cls} w-28`}
      />
    )
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="rounded-md px-2 py-1 text-xs text-sub hover:bg-hover hover:text-ink"
      >
        {t('viewSettings.button')}
      </button>
      {open && (
        // Phones: the 320 px panel hung from the button's right edge ran off the left of a 375 px screen
        // once the toolbar wrapped (docs/adr/1354-*); there it spans the screen with a 16 px gutter,
        // just under the button (top: auto keeps its place in the flow).
        <div className="absolute right-0 top-full z-40 mt-1 max-h-[75vh] w-80 overflow-y-auto rounded-md border border-line bg-app p-3 shadow-xl max-sm:fixed max-sm:inset-x-4 max-sm:top-auto max-sm:w-auto">
          {/* sort */}
          <section className="mb-3">
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-sub">
              {t('sort.title')}
            </div>
            {sorts.length === 0 && <p className="text-xs text-sub">{t('common.none')}</p>}
            <div className="flex flex-col gap-1.5">
              {sorts.map((s, i) => (
                <div key={i} className="flex items-center gap-1.5">
                  <select
                    value={s.fieldId}
                    onChange={(e) => setSort(i, { fieldId: e.target.value })}
                    className="min-w-0 flex-1 rounded border border-line bg-app px-1.5 py-1 text-xs text-ink outline-none focus-visible:border-accent"
                  >
                    {fields.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name}
                      </option>
                    ))}
                  </select>
                  <select
                    value={s.dir}
                    onChange={(e) =>
                      setSort(i, { dir: e.target.value as 'asc' | 'desc' })
                    }
                    className="rounded border border-line bg-app px-1.5 py-1 text-xs text-ink outline-none focus-visible:border-accent"
                  >
                    <option value="asc">{t('sort.asc')}</option>
                    <option value="desc">{t('sort.desc')}</option>
                  </select>
                  <button
                    type="button"
                    onClick={() => removeSort(i)}
                    aria-label={t('sort.remove')}
                    className="rounded p-1 text-sub hover:bg-hover hover:text-red-600"
                  >
                    <XIcon size={13} />
                  </button>
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={addSort}
              className="mt-1.5 flex items-center gap-1 rounded px-1.5 py-1 text-xs text-sub hover:bg-hover hover:text-ink"
            >
              <PlusIcon size={12} /> {t('sort.add')}
            </button>
          </section>

          {/* filter */}
          <section className="mb-3 border-t border-line pt-3">
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-sub">
              {t('filter.title')}
            </div>
            {filters.length === 0 && <p className="text-xs text-sub">{t('common.none')}</p>}
            <div className="flex flex-col gap-1.5">
              {filters.map((flt, i) => {
                const field = byId.get(flt.fieldId)
                const ops = field ? opsForType(field.type) : (['contains'] as FilterOp[])
                return (
                  <div key={i} className="flex flex-wrap items-center gap-1.5">
                    <select
                      value={flt.fieldId}
                      onChange={(e) => {
                        const nf = byId.get(e.target.value)
                        setFilter(i, {
                          fieldId: e.target.value,
                          op: nf ? opsForType(nf.type)[0] : 'contains',
                          value: undefined,
                        })
                      }}
                      className="min-w-0 flex-1 rounded border border-line bg-app px-1.5 py-1 text-xs text-ink outline-none focus-visible:border-accent"
                    >
                      {fields.map((f) => (
                        <option key={f.id} value={f.id}>
                          {f.name}
                        </option>
                      ))}
                    </select>
                    <select
                      value={flt.op}
                      onChange={(e) =>
                        setFilter(i, { op: e.target.value as FilterOp })
                      }
                      className="rounded border border-line bg-app px-1.5 py-1 text-xs text-ink outline-none focus-visible:border-accent"
                    >
                      {ops.map((op) => (
                        <option key={op} value={op}>
                          {t(OP_LABEL_KEY[op])}
                        </option>
                      ))}
                    </select>
                    {field && renderFilterValue(i, field, flt.op, flt.value)}
                    <button
                      type="button"
                      onClick={() => removeFilter(i)}
                      aria-label={t('filter.remove')}
                      className="rounded p-1 text-sub hover:bg-hover hover:text-red-600"
                    >
                      <XIcon size={13} />
                    </button>
                  </div>
                )
              })}
            </div>
            <button
              type="button"
              onClick={addFilter}
              className="mt-1.5 flex items-center gap-1 rounded px-1.5 py-1 text-xs text-sub hover:bg-hover hover:text-ink"
            >
              <PlusIcon size={12} /> {t('filter.add')}
            </button>
          </section>

          {/* group (board) */}
          {view.type === 'board' && (
            <section className="mb-3 border-t border-line pt-3">
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-sub">
                {t('group.by')}
              </div>
              <select
                value={config.groupByFieldId ?? ''}
                onChange={(e) =>
                  patch({ groupByFieldId: e.target.value || undefined })
                }
                className="w-full rounded border border-line bg-app px-1.5 py-1 text-xs text-ink outline-none focus-visible:border-accent"
              >
                <option value="">{t('group.pickField')}</option>
                {selectFields.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
            </section>
          )}

          {/* date property (calendar) */}
          {view.type === 'calendar' && (
            <section className="mb-3 border-t border-line pt-3">
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-sub">
                {t('viewSettings.dateBy')}
              </div>
              <select
                value={config.dateFieldId ?? ''}
                onChange={(e) => patch({ dateFieldId: e.target.value || undefined })}
                className="w-full rounded border border-line bg-app px-1.5 py-1 text-xs text-ink outline-none focus-visible:border-accent"
              >
                <option value="">{t('viewSettings.pickDateField')}</option>
                {dateFields.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
            </section>
          )}

          {/* gallery: card preview / size / shown properties */}
          {view.type === 'gallery' && (
            <section className="mb-3 border-t border-line pt-3">
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-sub">
                {S.cardCover}
              </div>
              <select
                value={config.cardCover ?? 'cover'}
                onChange={(e) =>
                  patch({ cardCover: e.target.value as NonNullable<ViewConfig['cardCover']> })
                }
                className="mb-2 w-full rounded border border-line bg-app px-1.5 py-1 text-xs text-ink outline-none focus-visible:border-accent"
              >
                <option value="cover">{S.coverPage}</option>
                <option value="firstImage">{S.coverFirstImage}</option>
                <option value="none">{S.coverNone}</option>
              </select>
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-sub">
                {S.cardSize}
              </div>
              <div className="mb-2 flex gap-1">
                {(['sm', 'md', 'lg'] as const).map((sz) => (
                  <button
                    key={sz}
                    type="button"
                    onClick={() => patch({ cardSize: sz })}
                    className={`flex-1 rounded border px-2 py-1 text-xs ${
                      (config.cardSize ?? 'md') === sz
                        ? 'border-accent bg-accent-soft text-accent'
                        : 'border-line text-sub hover:bg-hover'
                    }`}
                  >
                    {sz === 'sm' ? S.sizeSm : sz === 'md' ? S.sizeMd : S.sizeLg}
                  </button>
                ))}
              </div>
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-sub">
                {S.cardProps}
              </div>
              <div className="flex flex-col gap-0.5">
                {fields.map((f) => {
                  const shown = config.cardFieldIds ?? []
                  const on = shown.includes(f.id)
                  return (
                    <label
                      key={f.id}
                      className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-xs text-ink hover:bg-hover"
                    >
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() =>
                          patch({
                            cardFieldIds: on ? shown.filter((x) => x !== f.id) : [...shown, f.id],
                          })
                        }
                      />
                      {f.name}
                    </label>
                  )
                })}
              </div>
            </section>
          )}

          {/* timeline: start / end date fields */}
          {view.type === 'timeline' && (
            <section className="mb-3 border-t border-line pt-3">
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-sub">
                {S.timelineStart}
              </div>
              <select
                value={config.startFieldId ?? ''}
                onChange={(e) => patch({ startFieldId: e.target.value || undefined })}
                className="mb-2 w-full rounded border border-line bg-app px-1.5 py-1 text-xs text-ink outline-none focus-visible:border-accent"
              >
                <option value="">—</option>
                {dateFields.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-sub">
                {S.timelineEnd}
              </div>
              <select
                value={config.endFieldId ?? ''}
                onChange={(e) => patch({ endFieldId: e.target.value || undefined })}
                className="w-full rounded border border-line bg-app px-1.5 py-1 text-xs text-ink outline-none focus-visible:border-accent"
              >
                <option value="">{S.timelineSameAsStart}</option>
                {dateFields
                  .filter((f) => f.id !== config.startFieldId)
                  .map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
              </select>
            </section>
          )}

          {/* hidden fields */}
          <section className="border-t border-line pt-3">
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-sub">
              {t('viewSettings.visibleFields')}
            </div>
            <div className="flex flex-col gap-0.5">
              {fields.map((f) => (
                <label
                  key={f.id}
                  className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-xs text-ink hover:bg-hover"
                >
                  <input
                    type="checkbox"
                    checked={!hidden.has(f.id)}
                    onChange={() => toggleHidden(f.id)}
                  />
                  {f.name}
                </label>
              ))}
            </div>
          </section>
        </div>
      )}
    </div>
  )
}
