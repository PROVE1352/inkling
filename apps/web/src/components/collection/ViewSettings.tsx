import { useEffect, useRef, useState } from 'react'
import type {
  CollectionField,
  CollectionViewDTO,
  FieldType,
  FilterCondition,
  FilterGroup,
  FilterOp,
  MemberDTO,
  ViewConfig,
  ViewFilter,
  ViewFilterItem,
} from '@inkling/shared'
import {
  VIEW_FILTER_MAX_ITEMS,
  formatUniqueId,
  isFilterGroup,
  isPersonLikeType,
  isTimestampType,
  subItemsField,
  viewFilterOf,
  viewFilterPatch,
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
    // timestamps compare by their UTC day (YYYY-MM-DD); an ID by its number ("TASK-12" or 12)
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

  // ---- filter (tree: all/any, NOT, one level of groups; docs/adr/2142-*) ----
  const tree: ViewFilter = viewFilterOf(config) ?? { mode: 'and', items: [] }
  // a plain AND list is saved as the legacy `filters` (0.16 clients keep applying it)
  // "any" only shows (and only means something) with two or more items: a level left with one goes
  // back to "all", so it is not saved as an OR tree that 0.16 clients would ignore
  const setTree = (next: ViewFilter) =>
    patch(
      viewFilterPatch({
        mode: next.items.length > 1 ? next.mode : 'and',
        items: next.items.map((i) => (isFilterGroup(i) && i.items.length <= 1 && i.mode !== 'and' ? { ...i, mode: 'and' } : i)),
      }),
    )
  const newCondition = (): FilterCondition | null => {
    const f = fields[0]
    return f ? { fieldId: f.id, op: opsForType(f.type)[0] } : null
  }
  const setItem = (i: number, item: ViewFilterItem) =>
    setTree({ ...tree, items: tree.items.map((x, j) => (j === i ? item : x)) })
  const removeItem = (i: number) => setTree({ ...tree, items: tree.items.filter((_, j) => j !== i) })
  const addFilter = () => {
    const c = newCondition()
    if (c && tree.items.length < VIEW_FILTER_MAX_ITEMS) setTree({ ...tree, items: [...tree.items, c] })
  }
  const addGroup = () => {
    const c = newCondition()
    if (c && tree.items.length < VIEW_FILTER_MAX_ITEMS)
      setTree({ ...tree, items: [...tree.items, { mode: 'or', items: [c] }] })
  }

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
    field: CollectionField,
    op: FilterOp,
    value: string | number | boolean | undefined,
    setValue: (value: string | number | boolean) => void,
  ) => {
    if (!needsValue(op)) return null
    const cls =
      'rounded border border-line bg-app px-1.5 py-1 text-xs text-ink outline-none focus-visible:border-accent'
    if (field.type === 'select' || field.type === 'multiSelect') {
      return (
        <select
          value={String(value ?? '')}
          onChange={(e) => setValue(e.target.value)}
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
    if (isPersonLikeType(field.type)) {
      return (
        <select
          value={String(value ?? '')}
          onChange={(e) => setValue(e.target.value)}
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
          onChange={(e) => setValue(e.target.value === 'true')}
          className={cls}
        >
          <option value="true">{t('filter.checked')}</option>
          <option value="false">{t('filter.unchecked')}</option>
        </select>
      )
    }
    return (
      <input
        type={field.type === 'number' ? 'number' : field.type === 'date' || isTimestampType(field.type) ? 'date' : 'text'}
        value={value === undefined ? '' : String(value)}
        // an ID is typed as shown ("TASK-12"); the filter reads the number out of it
        placeholder={field.type === 'uniqueId' ? formatUniqueId(field, 12) : undefined}
        onChange={(e) => setValue(field.type === 'number' ? Number(e.target.value) : e.target.value)}
        className={`${cls} w-28`}
      />
    )
  }

  const SMALL_SELECT =
    'rounded border border-line bg-app px-1.5 py-1 text-xs text-ink outline-none focus-visible:border-accent'
  const notButton = (on: boolean | undefined, toggle: () => void) => (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={!!on}
      title={t('filter.notTitle')}
      className={`rounded border px-1.5 py-1 text-[11px] ${
        on ? 'border-accent bg-accent-soft text-accent' : 'border-line text-sub hover:bg-hover'
      }`}
    >
      {t('filter.not')}
    </button>
  )
  const modeSelect = (mode: 'and' | 'or', set: (m: 'and' | 'or') => void) => (
    <select value={mode} onChange={(e) => set(e.target.value as 'and' | 'or')} className={SMALL_SELECT}>
      <option value="and">{t('filter.all')}</option>
      <option value="or">{t('filter.any')}</option>
    </select>
  )
  const conditionRow = (
    key: string | number,
    flt: FilterCondition,
    set: (c: FilterCondition) => void,
    remove: () => void,
  ) => {
    const field = byId.get(flt.fieldId)
    const ops = field ? opsForType(field.type) : (['contains'] as FilterOp[])
    return (
      <div key={key} className="flex flex-wrap items-center gap-1.5">
        <select
          value={flt.fieldId}
          onChange={(e) => {
            const nf = byId.get(e.target.value)
            set({ fieldId: e.target.value, op: nf ? opsForType(nf.type)[0] : 'contains', ...(flt.not ? { not: true } : {}) })
          }}
          className="min-w-0 flex-1 rounded border border-line bg-app px-1.5 py-1 text-xs text-ink outline-none focus-visible:border-accent"
        >
          {fields.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
        {notButton(flt.not, () => {
          const { not, ...rest } = flt
          set(not ? rest : { ...rest, not: true })
        })}
        <select value={flt.op} onChange={(e) => set({ ...flt, op: e.target.value as FilterOp })} className={SMALL_SELECT}>
          {ops.map((op) => (
            <option key={op} value={op}>
              {t(OP_LABEL_KEY[op])}
            </option>
          ))}
        </select>
        {field && renderFilterValue(field, flt.op, flt.value, (value) => set({ ...flt, value }))}
        <button
          type="button"
          onClick={remove}
          aria-label={t('filter.remove')}
          className="rounded p-1 text-sub hover:bg-hover hover:text-red-600"
        >
          <XIcon size={13} />
        </button>
      </div>
    )
  }
  const groupBox = (i: number, g: FilterGroup) => {
    const setGroup = (next: FilterGroup) => (next.items.length ? setItem(i, next) : removeItem(i))
    return (
      <div key={i} className="rounded-md border border-line bg-side/30 p-1.5">
        <div className="mb-1 flex items-center gap-1.5 text-[11px] text-sub">
          <span className="font-medium">{t('filter.groupLabel')}</span>
          {notButton(g.not, () => {
            const { not, ...rest } = g
            setGroup(not ? rest : { ...rest, not: true })
          })}
          {g.items.length > 1 && modeSelect(g.mode, (mode) => setGroup({ ...g, mode }))}
          <button
            type="button"
            onClick={() => removeItem(i)}
            aria-label={t('filter.removeGroup')}
            title={t('filter.removeGroup')}
            className="ml-auto rounded p-1 text-sub hover:bg-hover hover:text-red-600"
          >
            <XIcon size={13} />
          </button>
        </div>
        <div className="flex flex-col gap-1.5">
          {g.items.map((c, j) =>
            conditionRow(
              j,
              c,
              (nc) => setGroup({ ...g, items: g.items.map((x, k) => (k === j ? nc : x)) }),
              () => setGroup({ ...g, items: g.items.filter((_, k) => k !== j) }),
            ),
          )}
        </div>
        <button
          type="button"
          disabled={g.items.length >= VIEW_FILTER_MAX_ITEMS}
          onClick={() => {
            const c = newCondition()
            if (c) setGroup({ ...g, items: [...g.items, c] })
          }}
          className="mt-1 flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-sub hover:bg-hover hover:text-ink disabled:opacity-40"
        >
          <PlusIcon size={11} /> {t('filter.addToGroup')}
        </button>
      </div>
    )
  }
  const parentField = subItemsField(fields)

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
            <div className="mb-1 flex items-center gap-1.5">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-sub">{t('filter.title')}</span>
              {/* all / any only means something with two or more items */}
              {tree.items.length > 1 && (
                <span className="ml-auto flex items-center gap-1 text-[11px] text-sub">
                  {t('filter.match')} {modeSelect(tree.mode, (mode) => setTree({ ...tree, mode }))}
                </span>
              )}
            </div>
            {tree.items.length === 0 && <p className="text-xs text-sub">{t('common.none')}</p>}
            <div className="flex flex-col gap-1.5">
              {tree.items.map((item, i) =>
                isFilterGroup(item)
                  ? groupBox(i, item)
                  : conditionRow(i, item, (c) => setItem(i, c), () => removeItem(i)),
              )}
            </div>
            <div className="mt-1.5 flex items-center gap-1">
              <button
                type="button"
                onClick={addFilter}
                disabled={tree.items.length >= VIEW_FILTER_MAX_ITEMS}
                className="flex items-center gap-1 rounded px-1.5 py-1 text-xs text-sub hover:bg-hover hover:text-ink disabled:opacity-40"
              >
                <PlusIcon size={12} /> {t('filter.add')}
              </button>
              <button
                type="button"
                onClick={addGroup}
                disabled={tree.items.length >= VIEW_FILTER_MAX_ITEMS}
                className="flex items-center gap-1 rounded px-1.5 py-1 text-xs text-sub hover:bg-hover hover:text-ink disabled:opacity-40"
              >
                <PlusIcon size={12} /> {t('filter.addGroup')}
              </button>
            </div>
          </section>

          {/* sub-items: tree or flat rows (table, list) */}
          {parentField && (view.type === 'table' || view.type === 'list') && (
            <section className="mb-3 border-t border-line pt-3">
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-sub">
                {t('subItems.display')}
              </div>
              <div className="flex gap-1">
                {(['nested', 'flat'] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => patch({ subItems: m })}
                    className={`flex-1 rounded border px-2 py-1 text-xs ${
                      (config.subItems ?? 'nested') === m
                        ? 'border-accent bg-accent-soft text-accent'
                        : 'border-line text-sub hover:bg-hover'
                    }`}
                  >
                    {m === 'nested' ? t('subItems.nested') : t('subItems.flat')}
                  </button>
                ))}
              </div>
            </section>
          )}

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
