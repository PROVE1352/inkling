import type { CollectionField, RollupFn } from '@inkling/shared'
import { UNIQUE_ID_PREFIX_RE, compileFormulas, formatUniqueId, formulaResultType, rollupFnSchema } from '@inkling/shared'
import { useT } from '../../i18n'
import type { MessageKey } from '../../i18n/en'
import { usePages } from '../../api'
import { useCollectionDef } from '../../lib/collectionApi'
import { ROLLUP_LABEL, S } from './strings'

const SELECT =
  'min-w-0 flex-1 rounded border border-line bg-app px-1.5 py-1 text-sm text-ink outline-none focus-visible:border-accent'

/** Which rollup functions make sense for a target property type. */
function fnsFor(type: CollectionField['type'] | 'title' | undefined): RollupFn[] {
  switch (type) {
    case 'number':
      return ['count', 'sum', 'avg', 'min', 'max', 'showUnique']
    case 'date':
      return ['count', 'earliest', 'latest', 'showUnique']
    case 'checkbox':
      return ['count', 'percentChecked']
    case 'relation':
    case 'rollup':
      return ['count']
    default:
      return ['count', 'showUnique']
  }
}

export function RelationEditor({
  wsId,
  pageId,
  field,
  onChange,
}: {
  wsId: string
  pageId: string
  field: CollectionField
  onChange: (patch: Partial<CollectionField>) => void
}) {
  const pages = usePages(wsId)
  const cols = (pages.data ?? []).filter((p) => p.kind === 'collection' && !p.deletedAt)
  const rel = field.relation
  return (
    <div className="mt-2 flex flex-col gap-1.5 rounded-md border border-line p-2">
      <label className="flex items-center gap-2 text-xs text-sub">
        <span className="w-28 shrink-0">{S.relationTarget}</span>
        <select
          value={rel?.targetPageId ?? ''}
          onChange={(e) =>
            onChange({
              relation: e.target.value
                ? { targetPageId: e.target.value, twoWay: rel?.twoWay ?? false }
                : undefined,
            })
          }
          className={SELECT}
        >
          <option value="">{S.relationPickTarget}</option>
          {cols.map((c) => (
            <option key={c.id} value={c.id}>
              {(c.title || S.untitled) + (c.id === pageId ? ` ${S.relationThis}` : '')}
            </option>
          ))}
        </select>
      </label>
      {rel?.targetPageId && (
        <label className="flex items-center gap-2 text-xs text-ink">
          <input
            type="checkbox"
            checked={!!rel.twoWay}
            onChange={(e) => onChange({ relation: { ...rel, twoWay: e.target.checked } })}
          />
          {rel.pairFieldId ? S.relationPaired : S.relationTwoWay}
        </label>
      )}
    </div>
  )
}

export function RollupEditor({
  field,
  draft,
  pageId,
  onChange,
}: {
  field: CollectionField
  draft: CollectionField[]
  pageId: string
  onChange: (patch: Partial<CollectionField>) => void
}) {
  const relations = draft.filter((f) => f.type === 'relation' && f.relation?.targetPageId)
  const cfg = field.rollup
  const rel = relations.find((f) => f.id === cfg?.relationFieldId)
  const targetId = rel?.relation?.targetPageId
  const def = useCollectionDef(targetId && targetId !== pageId ? targetId : undefined)
  const targetFields = targetId === pageId ? draft : (def.data?.fields ?? [])
  const usable = targetFields.filter((f) => f.id !== field.id)
  const tType = cfg?.targetFieldId === 'title' ? 'title' : usable.find((f) => f.id === cfg?.targetFieldId)?.type
  const fns = fnsFor(tType)

  if (relations.length === 0) {
    return <p className="mt-2 text-xs text-sub">{S.rollupNeedsRelation}</p>
  }
  const set = (p: Partial<NonNullable<CollectionField['rollup']>>) => {
    const next = {
      relationFieldId: cfg?.relationFieldId ?? relations[0].id,
      targetFieldId: cfg?.targetFieldId ?? 'title',
      fn: cfg?.fn ?? ('count' as RollupFn),
      ...p,
    }
    const allowed = fnsFor(
      next.targetFieldId === 'title' ? 'title' : usable.find((f) => f.id === next.targetFieldId)?.type,
    )
    if (!allowed.includes(next.fn)) next.fn = allowed[0]
    onChange({ rollup: next })
  }
  return (
    <div className="mt-2 flex flex-col gap-1.5 rounded-md border border-line p-2">
      <label className="flex items-center gap-2 text-xs text-sub">
        <span className="w-20 shrink-0">{S.rollupRelation}</span>
        <select
          value={cfg?.relationFieldId ?? ''}
          onChange={(e) => set({ relationFieldId: e.target.value, targetFieldId: 'title' })}
          className={SELECT}
        >
          {!cfg && <option value="">—</option>}
          {relations.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-2 text-xs text-sub">
        <span className="w-20 shrink-0">{S.rollupProperty}</span>
        <select
          value={cfg?.targetFieldId ?? 'title'}
          onChange={(e) => set({ targetFieldId: e.target.value })}
          className={SELECT}
          disabled={!cfg}
        >
          <option value="title">{S.rollupTitle}</option>
          {usable.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-2 text-xs text-sub">
        <span className="w-20 shrink-0">{S.rollupFunction}</span>
        <select
          value={cfg?.fn ?? 'count'}
          onChange={(e) => set({ fn: rollupFnSchema.parse(e.target.value) })}
          className={SELECT}
          disabled={!cfg}
        >
          {fns.map((fn) => (
            <option key={fn} value={fn}>
              {ROLLUP_LABEL[fn]}
            </option>
          ))}
        </select>
      </label>
    </div>
  )
}

/**
 * Formula expression with a live check against the fields being edited (docs/adr/1823-*): the same
 * parser the server runs when the fields are saved, so a message here is the one the save would give.
 */
export function FormulaEditor({
  field,
  draft,
  onChange,
}: {
  field: CollectionField
  draft: CollectionField[]
  onChange: (patch: Partial<CollectionField>) => void
}) {
  const t = useT()
  const expression = field.formula?.expression ?? ''
  const compiled = expression.trim() ? compileFormulas(draft) : null
  const error = compiled?.byId.get(field.id)?.error ?? null
  const type = compiled && !error ? formulaResultType(draft, field.id, compiled) : null
  return (
    <div className="mt-2 flex flex-col gap-1.5 rounded-md border border-line p-2">
      <label className="flex flex-col gap-1 text-xs text-sub">
        <span>{t('formula.expression')}</span>
        <textarea
          value={expression}
          onChange={(e) => onChange({ formula: { expression: e.target.value.slice(0, 2000) } })}
          placeholder={t('formula.placeholder')}
          rows={2}
          spellCheck={false}
          className="min-w-0 resize-y rounded border border-line bg-app px-1.5 py-1 font-mono text-sm text-ink outline-none focus-visible:border-accent"
        />
      </label>
      {error ? (
        <p className="text-xs text-red-600">
          {t(`formula.err.${error.code}` as MessageKey)}: {error.message}
        </p>
      ) : type ? (
        <p className="text-xs text-sub">{t('formula.result', { type: t(`formula.type.${type}` as MessageKey) })}</p>
      ) : null}
      <p className="text-[11px] leading-snug text-sub">{t('formula.help')}</p>
    </div>
  )
}

/** A unique ID prefix the server accepts: letters and digits (any script), at most 12, or none. */
export function uniqueIdPrefixValid(prefix: string): boolean {
  return UNIQUE_ID_PREFIX_RE.test(prefix.trim())
}

/** ID property: the prefix shown before the number (TASK-12; docs/adr/2140-*). */
export function UniqueIdEditor({
  field,
  onChange,
}: {
  field: CollectionField
  onChange: (patch: Partial<CollectionField>) => void
}) {
  const t = useT()
  const prefix = field.uniqueId?.prefix ?? ''
  const ok = uniqueIdPrefixValid(prefix)
  return (
    <div className="mt-2 flex flex-col gap-1.5 rounded-md border border-line p-2">
      <label className="flex items-center gap-2 text-xs text-sub">
        <span className="w-20 shrink-0">{t('fields.uniqueIdPrefix')}</span>
        <input
          value={prefix}
          maxLength={12}
          onChange={(e) => onChange({ uniqueId: { prefix: e.target.value.replace(/\s/g, '') } })}
          placeholder="TASK"
          aria-invalid={!ok || undefined}
          className={`${SELECT} font-mono ${ok ? '' : 'border-red-500'}`}
        />
      </label>
      <p className={`text-xs ${ok ? 'text-sub' : 'text-red-600'}`}>
        {ok ? t('fields.uniqueIdPrefixHelp', { example: formatUniqueId({ uniqueId: { prefix: prefix.trim() } }, 12) }) : t('fields.uniqueIdPrefixInvalid')}
      </p>
      <p className="text-[11px] text-sub">{t('fields.automatic')}</p>
    </div>
  )
}
