// Automations of a collection (docs/adr/2240-* .. 2243-*): the rules, their on/off switch, a rule
// that turned itself off after failures, the editor, and each rule's recent runs. The server runs
// the rules (as their author); this screen only sets them up. Without edit rights it reads only.
import { useState } from 'react'
import type { AutomationDTO, AutomationRunDTO, CollectionField, MemberDTO } from '@inkling/shared'
import { AUTOMATIONS_MAX_PER_COLLECTION, AUTOMATION_DISABLE_AFTER, summarizeAutomation } from '@inkling/shared'
import { useT, fmtRelative } from '../../i18n'
import { askConfirm } from '../../lib/confirm'
import { useAutomationRuns, useAutomations, useDeleteAutomation, useUpdateAutomation } from '../../lib/automationsApi'
import { Modal } from '../Modal'
import { Spinner } from '../Spinner'
import { EditIcon, HistoryIcon, PlusIcon, TrashIcon } from '../Icons'
import { AutomationEditor, automationActionKey } from './AutomationEditor'

function RunRow({ run, rule }: { run: AutomationRunDTO; rule: AutomationDTO }) {
  const t = useT()
  const failed = run.status === 'failed'
  const act = run.failedAction !== null ? rule.actions[run.failedAction] : undefined
  return (
    <li className="flex flex-col gap-0.5 px-3 py-1.5 text-xs" data-automation-run={run.status}>
      <div className="flex items-center gap-2">
        <span
          className={`shrink-0 rounded px-1.5 text-[11px] ${
            run.status === 'ok'
              ? 'bg-green-100 text-green-800 dark:bg-green-500/25 dark:text-green-100'
              : failed
                ? 'bg-red-100 text-red-800 dark:bg-red-500/25 dark:text-red-100'
                : 'bg-gray-200 text-gray-700 dark:bg-gray-600/50 dark:text-gray-100'
          }`}
        >
          {t(`automation.status.${run.status}` as never)}
        </span>
        <span className="min-w-0 flex-1 truncate text-ink">{run.rowTitle === null ? t('automation.runNoRow') : run.rowTitle.trim() || t('button.untitled')}</span>
        <time className="shrink-0 text-sub" dateTime={run.at} title={new Date(run.at).toLocaleString()}>
          {fmtRelative(run.at)}
        </time>
      </div>
      <div className="flex flex-wrap gap-x-3 text-[11px] text-sub">
        <span>{run.actorName ? t('automation.runBy', { name: run.actorName }) : t('automation.runByDate')}</span>
        {run.depth > 0 && <span>{t('automation.runDepth', { n: run.depth })}</span>}
      </div>
      {(failed || run.status === 'skipped') && (run.error || run.failedAction !== null) && (
        <p className="text-[11px] text-red-600">
          {run.failedAction !== null
            ? t('automation.runFailedAt', {
                n: run.failedAction + 1,
                kind: act ? t(automationActionKey(act.type)) : '?',
                message: run.error ?? '',
              })
            : run.error}
        </p>
      )}
    </li>
  )
}

function RunsPanel({ collectionId, rule, onBack }: { collectionId: string; rule: AutomationDTO; onBack: () => void }) {
  const t = useT()
  const runs = useAutomationRuns(collectionId, rule.id)
  return (
    <div className="flex flex-col gap-3" data-automation-runs>
      <div className="flex items-center gap-2">
        <button type="button" onClick={onBack} className="rounded-md px-2 py-1 text-xs text-sub hover:bg-hover hover:text-ink">
          ← {t('automation.back')}
        </button>
        <span className="min-w-0 truncate text-sm font-medium text-ink">{rule.name}</span>
      </div>
      {runs.isLoading ? (
        <Spinner size={16} />
      ) : runs.isError ? (
        <p className="text-xs text-red-600">{(runs.error as Error).message}</p>
      ) : !runs.data?.length ? (
        <p className="text-xs text-sub">{t('automation.noRuns')}</p>
      ) : (
        <ul className="max-h-[50vh] divide-y divide-line overflow-y-auto rounded-md border border-line">
          {runs.data.map((r) => (
            <RunRow key={r.id} run={r} rule={rule} />
          ))}
        </ul>
      )}
    </div>
  )
}

export function AutomationsModal({
  open,
  onClose,
  wsId,
  collectionId,
  fields,
  members,
}: {
  open: boolean
  onClose: () => void
  wsId: string
  collectionId: string
  fields: CollectionField[]
  members?: MemberDTO[]
}) {
  const t = useT()
  const list = useAutomations(collectionId, open)
  const update = useUpdateAutomation(collectionId)
  const del = useDeleteAutomation(collectionId)
  // null: the list; 'new' / a rule: the editor; { runs }: a rule's run log
  const [screen, setScreen] = useState<null | 'new' | { edit: AutomationDTO } | { runs: AutomationDTO }>(null)
  const [error, setError] = useState<string | null>(null)
  const canEdit = !!list.data?.canEdit
  const rules = list.data?.automations ?? []

  const close = () => {
    setScreen(null)
    setError(null)
    onClose()
  }

  let body
  if (screen === 'new' || (screen && 'edit' in screen)) {
    body = (
      <AutomationEditor
        key={screen === 'new' ? 'new' : screen.edit.id}
        wsId={wsId}
        collectionId={collectionId}
        fields={fields}
        members={members}
        initial={screen === 'new' ? null : screen.edit}
        onDone={() => setScreen(null)}
      />
    )
  } else if (screen && 'runs' in screen) {
    body = <RunsPanel collectionId={collectionId} rule={screen.runs} onBack={() => setScreen(null)} />
  } else {
    body = (
      <div className="flex flex-col gap-3">
        <p className="text-xs text-sub">{t('automation.intro')}</p>
        {list.isLoading ? (
          <Spinner size={16} />
        ) : list.isError ? (
          <p className="text-xs text-red-600">{(list.error as Error).message}</p>
        ) : rules.length === 0 ? (
          <p className="text-sm text-sub">{t('automation.empty')}</p>
        ) : (
          <ul className="divide-y divide-line rounded-md border border-line">
            {rules.map((rule) => (
              <li key={rule.id} className="flex items-start gap-2 px-3 py-2" data-automation-rule={rule.id}>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-ink">{rule.name}</span>
                    {rule.autoDisabledAt && (
                      <span
                        className="shrink-0 rounded bg-red-100 px-1.5 text-[11px] text-red-800 dark:bg-red-500/25 dark:text-red-100"
                        title={t('automation.autoDisabledHint', { n: AUTOMATION_DISABLE_AFTER })}
                        data-automation-auto-disabled
                      >
                        {t('automation.autoDisabled')}
                      </span>
                    )}
                  </div>
                  <p className="truncate text-xs text-sub" title={summarizeAutomation(rule, fields)}>
                    {summarizeAutomation(rule, fields)}
                  </p>
                  {rule.createdByName && <p className="text-[11px] text-sub">{t('automation.author', { name: rule.createdByName })}</p>}
                </div>
                <label className="flex shrink-0 items-center gap-1 pt-0.5 text-xs text-sub">
                  <input
                    type="checkbox"
                    name={`automation-enabled-${rule.id}`}
                    aria-label={t('automation.enabled')}
                    checked={rule.enabled}
                    disabled={!canEdit || update.isPending}
                    onChange={(e) =>
                      update.mutate({ id: rule.id, patch: { enabled: e.target.checked } }, { onError: (err) => setError((err as Error).message) })
                    }
                  />
                  {rule.enabled ? t('automation.on') : t('automation.off')}
                </label>
                <button
                  type="button"
                  onClick={() => setScreen({ runs: rule })}
                  aria-label={t('automation.runs')}
                  title={t('automation.runs')}
                  data-automation-open-runs
                  className="shrink-0 rounded-md p-1 text-sub hover:bg-hover hover:text-ink"
                >
                  <HistoryIcon size={14} />
                </button>
                {canEdit && (
                  <>
                    <button
                      type="button"
                      onClick={() => setScreen({ edit: rule })}
                      aria-label={t('automation.edit')}
                      title={t('automation.edit')}
                      className="shrink-0 rounded-md p-1 text-sub hover:bg-hover hover:text-ink"
                    >
                      <EditIcon size={14} />
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        void askConfirm(t('automation.deleteConfirm', { name: rule.name })).then(
                          (ok) => ok && del.mutate(rule.id, { onError: (err) => setError((err as Error).message) }),
                        )
                      }
                      aria-label={t('automation.delete')}
                      title={t('automation.delete')}
                      className="shrink-0 rounded-md p-1 text-sub hover:bg-hover hover:text-red-500"
                    >
                      <TrashIcon size={14} />
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
        {error && (
          <p className="text-xs text-red-600" role="alert">
            {error}
          </p>
        )}
        {list.data && !canEdit && <p className="text-xs text-sub">{t('automation.readOnly')}</p>}
        {canEdit && (
          <button
            type="button"
            data-automation-new
            disabled={rules.length >= AUTOMATIONS_MAX_PER_COLLECTION}
            onClick={() => setScreen('new')}
            className="flex items-center gap-1.5 self-start rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            <PlusIcon size={14} /> {t('automation.new')}
          </button>
        )}
      </div>
    )
  }

  return (
    <Modal open={open} onClose={close} title={t('automation.title')} size="md">
      <div data-automations-modal>{body}</div>
    </Modal>
  )
}
