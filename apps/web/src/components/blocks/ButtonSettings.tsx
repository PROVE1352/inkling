// Settings form of a button block (docs/adr/2244-*): label, color and up to BUTTON_ACTIONS_MAX
// actions. Drafts may be half filled while editing; saving validates them with the shared schema so
// what lands in the block is exactly what `parseButtonActions` keeps.
import { useMemo, useState } from 'react'
import type { AutomationAction, ButtonAction, ButtonColor, CollectionField, PageMetaDTO } from '@inkling/shared'
import { BUTTON_ACTIONS_MAX, BUTTON_ACTIONS_MAX_CHARS, BUTTON_COLORS, buttonActionSchema, buttonActionsJson, isOpenableUrl } from '@inkling/shared'
import { useMembers, usePages } from '../../api'
import { useT, type TKey } from '../../i18n'
import { useCollectionDef } from '../../lib/collectionApi'
import { useRowTemplates } from '../../lib/rowTemplatesApi'
import { useWebhookTargets } from '../../lib/automationsApi'
import { ActionValuesEditor } from '../collection/ActionValuesEditor'
import { PlusIcon, TrashIcon } from '../Icons'

export type ButtonActionType = ButtonAction['type']
/** An action (of a button or an automation) while it is being set up: any of its keys may be missing. */
export type ActionDraft = { type: ButtonActionType | AutomationAction['type'] } & Record<string, unknown>

export const BUTTON_ACTION_TYPES: ButtonActionType[] = ['addRow', 'setFields', 'open', 'webhook']

const INPUT =
  'w-full rounded-md border border-line bg-app px-2 py-1 text-sm text-ink outline-none focus:border-accent disabled:opacity-70'
const LABEL = 'mb-0.5 block text-[11px] font-medium text-sub'

/** Swatch classes of the button colors (BlockNote's color names). */
export const BUTTON_COLOR_CLASS: Record<ButtonColor, string> = {
  default: 'border border-line bg-app text-ink hover:bg-hover',
  gray: 'bg-gray-200 text-gray-800 hover:bg-gray-300 dark:bg-gray-600/50 dark:text-gray-100',
  brown: 'bg-amber-200/70 text-amber-950 hover:bg-amber-200 dark:bg-amber-900/50 dark:text-amber-100',
  red: 'bg-red-100 text-red-800 hover:bg-red-200 dark:bg-red-500/25 dark:text-red-100',
  orange: 'bg-orange-100 text-orange-800 hover:bg-orange-200 dark:bg-orange-500/25 dark:text-orange-100',
  yellow: 'bg-yellow-100 text-yellow-900 hover:bg-yellow-200 dark:bg-yellow-500/25 dark:text-yellow-100',
  green: 'bg-green-100 text-green-800 hover:bg-green-200 dark:bg-green-500/25 dark:text-green-100',
  blue: 'bg-blue-100 text-blue-800 hover:bg-blue-200 dark:bg-blue-500/25 dark:text-blue-100',
  purple: 'bg-purple-100 text-purple-800 hover:bg-purple-200 dark:bg-purple-500/25 dark:text-purple-100',
  pink: 'bg-pink-100 text-pink-800 hover:bg-pink-200 dark:bg-pink-500/25 dark:text-pink-100',
}

export const actionTypeKey = (type: ButtonActionType): TKey => `button.action.${type}` as TKey

let draftSeq = 0
/** A stable React key for a draft (`_k`; keys starting with `_` never reach the saved action). */
export const keyed = (d: ActionDraft): ActionDraft => ({ ...d, _k: ++draftSeq })

function newDraft(type: ButtonActionType): ActionDraft {
  switch (type) {
    case 'setFields':
      return keyed({ type, props: {} })
    case 'open':
      return keyed({ type, url: '' })
    default:
      return keyed({ type })
  }
}

/** A valid action from a draft (empty optional strings dropped), or null. */
export function actionFromDraft(d: ActionDraft): ButtonAction | null {
  const clean: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(d)) {
    if (v === undefined || v === '' || k.startsWith('_')) continue
    if (k === 'props' && v && typeof v === 'object' && !Object.keys(v).length && d.type !== 'setFields') continue
    clean[k] = v
  }
  if (clean.type === 'open') {
    if (clean.pageId) delete clean.url
    else if (typeof clean.url !== 'string' || !isOpenableUrl(clean.url)) return null
    else clean.url = (clean.url as string).trim()
  }
  if (clean.type === 'setFields' && !Object.keys((clean.props as object) ?? {}).length) return null
  const r = buttonActionSchema.safeParse(clean)
  return r.success ? r.data : null
}

/** The collection a page is a row of, or null. */
export function rowCollectionOf(pages: PageMetaDTO[] | undefined, pageId: string | null | undefined): string | null {
  if (!pages || !pageId) return null
  const p = pages.find((x) => x.id === pageId)
  const parent = p?.parentId ? pages.find((x) => x.id === p.parentId) : undefined
  return parent?.kind === 'collection' ? parent.id : null
}

function useFields(collectionId: string | undefined): CollectionField[] {
  return useCollectionDef(collectionId).data?.fields ?? []
}

function CollectionPicker({ wsId, value, onChange }: { wsId: string; value: string; onChange: (id: string) => void }) {
  const t = useT()
  const pages = usePages(wsId)
  const cols = useMemo(
    () => (pages.data ?? []).filter((p) => p.kind === 'collection' && !p.deletedAt).sort((a, b) => a.title.localeCompare(b.title)),
    [pages.data],
  )
  if (pages.data && !cols.length) return <p className="text-xs text-sub">{t('button.noCollections')}</p>
  return (
    <select className={INPUT} name="collection" aria-label={t('button.collection')} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{t('button.choose')}</option>
      {cols.map((c) => (
        <option key={c.id} value={c.id}>
          {c.title || t('button.untitled')}
        </option>
      ))}
    </select>
  )
}

function TemplatePicker({ collectionId, value, onChange }: { collectionId: string; value: unknown; onChange: (v: string | null | undefined) => void }) {
  const t = useT()
  const tpls = useRowTemplates(collectionId)
  const cur = value === undefined ? '' : value === null ? '__empty' : String(value)
  return (
    <select
      className={INPUT}
      name="template"
      aria-label={t('button.template')}
      value={cur}
      onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value === '__empty' ? null : e.target.value)}
    >
      <option value="">{t('button.templateDefault')}</option>
      <option value="__empty">{t('button.templateNone')}</option>
      {(tpls.data?.templates ?? []).map((tpl) => (
        <option key={tpl.id} value={tpl.id}>
          {tpl.name}
        </option>
      ))}
    </select>
  )
}

/** addRow: target collection, template, title and values (shared with the automation editor). */
export function AddRowEditor({
  wsId,
  draft,
  mode,
  onChange,
}: {
  wsId: string
  draft: ActionDraft
  mode: 'button' | 'automation'
  onChange: (d: ActionDraft) => void
}) {
  const t = useT()
  const collectionId = typeof draft.collectionId === 'string' ? draft.collectionId : ''
  const fields = useFields(collectionId || undefined)
  const members = useMembers(wsId)
  return (
    <div className="flex flex-col gap-2">
      <label>
        <span className={LABEL}>{t('button.collection')}</span>
        <CollectionPicker
          wsId={wsId}
          value={collectionId}
          onChange={(id) => onChange({ type: 'addRow', collectionId: id || undefined, title: draft.title })}
        />
      </label>
      {collectionId && (
        <>
          <label>
            <span className={LABEL}>{t('button.template')}</span>
            <TemplatePicker collectionId={collectionId} value={draft.templateId} onChange={(v) => onChange({ ...draft, templateId: v })} />
          </label>
          <label>
            <span className={LABEL}>{t('button.rowTitle')}</span>
            <input
              className={INPUT}
              name="row-title"
              maxLength={300}
              value={typeof draft.title === 'string' ? draft.title : ''}
              placeholder={t('button.rowTitleHint')}
              onChange={(e) => onChange({ ...draft, title: e.target.value })}
            />
          </label>
          <div>
            <span className={LABEL}>{t('button.values')}</span>
            <ActionValuesEditor
              fields={fields}
              props={(draft.props as Record<string, unknown>) ?? {}}
              members={members.data}
              mode={mode}
              onChange={(props) => onChange({ ...draft, props })}
            />
          </div>
        </>
      )}
    </div>
  )
}

/** Picks a registered webhook (never a URL typed here). */
export function WebhookPicker({ wsId, draft, onChange }: { wsId: string; draft: ActionDraft; onChange: (d: ActionDraft) => void }) {
  const t = useT()
  const targets = useWebhookTargets(wsId)
  const list = targets.data ?? []
  if (targets.isError) return <p className="text-xs text-red-600">{(targets.error as Error).message}</p>
  if (targets.data && !list.length) return <p className="text-xs text-sub">{t('button.noWebhooks')}</p>
  return (
    <div className="flex flex-col gap-2">
      <label>
        <span className={LABEL}>{t('button.webhook')}</span>
        <select
          className={INPUT}
          name="webhook"
          aria-label={t('button.webhook')}
          value={typeof draft.webhookId === 'string' ? draft.webhookId : ''}
          onChange={(e) => onChange({ ...draft, webhookId: e.target.value || undefined })}
        >
          <option value="">{t('button.choose')}</option>
          {list.map((w) => (
            <option key={w.id} value={w.id} disabled={!w.enabled}>
              {w.kind === 'generic' ? 'JSON' : w.kind === 'slack' ? 'Slack' : 'Discord'} · {w.label}
              {w.enabled ? '' : ` (${t('button.webhookOff')})`}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span className={LABEL}>{t('button.webhookMessage')}</span>
        <input
          className={INPUT}
          name="webhook-message"
          maxLength={500}
          value={typeof draft.message === 'string' ? draft.message : ''}
          placeholder={t('button.webhookMessageHint')}
          onChange={(e) => onChange({ ...draft, message: e.target.value })}
        />
      </label>
    </div>
  )
}

function OpenEditor({ wsId, draft, onChange }: { wsId: string; draft: ActionDraft; onChange: (d: ActionDraft) => void }) {
  const t = useT()
  const pages = usePages(wsId)
  const asPage = draft.pageId !== undefined
  const url = typeof draft.url === 'string' ? draft.url : ''
  const list = useMemo(
    () => (pages.data ?? []).filter((p) => !p.deletedAt).sort((a, b) => a.title.localeCompare(b.title)),
    [pages.data],
  )
  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-3 text-xs text-ink">
        <label className="flex items-center gap-1">
          <input type="radio" name={`open-kind-${String(draft._k)}`} checked={asPage} onChange={() => onChange({ type: 'open', pageId: '' })} />
          {t('button.openPage')}
        </label>
        <label className="flex items-center gap-1">
          <input type="radio" name={`open-kind-${String(draft._k)}`} checked={!asPage} onChange={() => onChange({ type: 'open', url: '' })} />
          {t('button.openUrl')}
        </label>
      </div>
      {asPage ? (
        <select
          className={INPUT}
          name="open-page"
          aria-label={t('button.openPage')}
          value={typeof draft.pageId === 'string' ? draft.pageId : ''}
          onChange={(e) => onChange({ type: 'open', pageId: e.target.value })}
        >
          <option value="">{t('button.choose')}</option>
          {list.map((p) => (
            <option key={p.id} value={p.id}>
              {p.title || t('button.untitled')}
            </option>
          ))}
        </select>
      ) : (
        <>
          <input
            className={INPUT}
            name="open-url"
            aria-label={t('button.openUrl')}
            inputMode="url"
            maxLength={2000}
            value={url}
            placeholder="https://"
            onChange={(e) => onChange({ type: 'open', url: e.target.value })}
          />
          {url.trim() !== '' && !isOpenableUrl(url) && <p className="text-[11px] text-red-600">{t('button.badUrl')}</p>}
        </>
      )}
    </div>
  )
}

function ActionEditor({
  wsId,
  draft,
  rowCollectionId,
  onChange,
}: {
  wsId: string
  draft: ActionDraft
  rowCollectionId: string | null
  onChange: (d: ActionDraft) => void
}) {
  const t = useT()
  const rowFields = useFields(draft.type === 'setFields' && rowCollectionId ? rowCollectionId : undefined)
  const members = useMembers(wsId)
  switch (draft.type) {
    case 'addRow':
      return <AddRowEditor wsId={wsId} draft={draft} mode="button" onChange={onChange} />
    case 'setFields':
      if (!rowCollectionId) return <p className="text-xs text-sub">{t('button.notRowHint')}</p>
      return (
        <ActionValuesEditor
          fields={rowFields}
          props={(draft.props as Record<string, unknown>) ?? {}}
          members={members.data}
          mode="button"
          onChange={(props) => onChange({ ...draft, props })}
        />
      )
    case 'open':
      return <OpenEditor wsId={wsId} draft={draft} onChange={onChange} />
    case 'webhook':
      return <WebhookPicker wsId={wsId} draft={draft} onChange={onChange} />
    default:
      return null
  }
}

export function ButtonSettingsForm({
  wsId,
  initial,
  rowCollectionId,
  onSave,
  onCancel,
}: {
  wsId: string
  initial: { label: string; color: ButtonColor; actions: ButtonAction[] }
  /** The collection the button's page is a row of (setFields edits its values), null otherwise. */
  rowCollectionId: string | null
  onSave: (label: string, color: ButtonColor, actionsJson: string) => void
  onCancel?: () => void
}) {
  const t = useT()
  const [label, setLabel] = useState(initial.label)
  const [color, setColor] = useState<ButtonColor>(initial.color)
  const [drafts, setDrafts] = useState<ActionDraft[]>(() => initial.actions.map((a) => keyed({ ...a } as ActionDraft)))
  const [addType, setAddType] = useState<ButtonActionType>('addRow')
  const [error, setError] = useState<string | null>(null)

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
    const out: ButtonAction[] = []
    for (let i = 0; i < drafts.length; i++) {
      const a = actionFromDraft(drafts[i])
      if (!a) {
        setError(t('button.incomplete', { n: i + 1 }))
        return
      }
      out.push(a)
    }
    if (!out.length) {
      setError(t('button.needAction'))
      return
    }
    const json = buttonActionsJson(out)
    if (json.length > BUTTON_ACTIONS_MAX_CHARS) {
      setError(t('button.tooLarge'))
      return
    }
    setError(null)
    onSave(label.trim().slice(0, 200), color, json)
  }

  return (
    <div className="flex w-full flex-col gap-3 rounded-lg border border-line bg-app p-3 text-sm" data-button-form>
      <div className="flex flex-wrap items-end gap-3">
        <label className="min-w-40 flex-1">
          <span className={LABEL}>{t('button.label')}</span>
          <input
            className={INPUT}
            name="button-label"
            maxLength={200}
            value={label}
            placeholder={t('button.labelPlaceholder')}
            onChange={(e) => setLabel(e.target.value)}
          />
        </label>
        <div>
          <span className={LABEL}>{t('button.color')}</span>
          <div className="flex flex-wrap gap-1" role="radiogroup" aria-label={t('button.color')}>
            {BUTTON_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={color === c}
                aria-label={c}
                title={c}
                onClick={() => setColor(c)}
                className={`h-6 w-6 rounded-md ${BUTTON_COLOR_CLASS[c]} ${color === c ? 'ring-2 ring-accent ring-offset-1' : ''}`}
              />
            ))}
          </div>
        </div>
      </div>

      <div>
        <span className={LABEL}>{t('button.actions')}</span>
        {drafts.length === 0 && <p className="text-xs text-sub">{t('button.noActions')}</p>}
        <ol className="flex flex-col gap-2">
          {drafts.map((d, i) => (
            <li key={String(d._k ?? i)} className="rounded-md border border-line p-2" data-button-action={d.type}>
              <div className="mb-2 flex items-center gap-1">
                <span className="text-xs font-medium text-ink">
                  {i + 1}. {t(actionTypeKey(d.type as ButtonActionType))}
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
              <ActionEditor wsId={wsId} draft={d} rowCollectionId={rowCollectionId} onChange={(nd) => setAt(i, nd)} />
            </li>
          ))}
        </ol>
        {drafts.length < BUTTON_ACTIONS_MAX && (
          <div className="mt-2 flex items-center gap-1.5">
            <select
              className={`${INPUT} w-auto text-xs`}
              name="new-action-type"
              aria-label={t('button.actionType')}
              value={addType}
              onChange={(e) => setAddType(e.target.value as ButtonActionType)}
            >
              {BUTTON_ACTION_TYPES.map((ty) => (
                <option key={ty} value={ty}>
                  {t(actionTypeKey(ty))}
                </option>
              ))}
            </select>
            <button
              type="button"
              data-button-add-action
              onClick={() => setDrafts((list) => [...list, newDraft(addType)])}
              className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-sub hover:bg-hover hover:text-ink"
            >
              <PlusIcon size={12} /> {t('button.addAction')}
            </button>
          </div>
        )}
      </div>

      {error && (
        <p className="text-xs text-red-600" role="alert">
          {error}
        </p>
      )}
      <div className="flex items-center justify-end gap-2">
        {onCancel && (
          <button type="button" onClick={onCancel} className="rounded-md px-3 py-1.5 text-sm text-sub hover:bg-hover hover:text-ink">
            {t('button.cancel')}
          </button>
        )}
        <button
          type="button"
          data-button-save
          onClick={save}
          className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:opacity-90"
        >
          {t('button.save')}
        </button>
      </div>
    </div>
  )
}
