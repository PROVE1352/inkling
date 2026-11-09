import { useMemo, useState } from 'react'
import type { RevertChangeDTO, RevertResultDTO } from '@inkling/shared'
import { ApiError } from '../api'
import { tMaybe, useT } from '../i18n'
import { relativeTime } from '../lib/time'
import { toast } from '../lib/toast'
import { type RevertTarget, useCanRevertWorkspace, useRevertPreview, useRunRevert } from '../revertApi'
import { Modal } from './Modal'
import { Spinner } from './Spinner'

// Revert one logged change, or everything one agent changed on this page / in the workspace in a
// period (docs/adr/1620-* .. 1624-*). Always a preview first (what applies, what overlaps later
// edits and stays, what cannot be reverted here), then one click; the result replaces the preview.

export interface RevertSource {
  seq: string
  pageId: string
  pageTitle?: string | null
  headingPath: string
  via: string | null
  actor: { id: string; name: string } | null
  changedAt: string
  /** The change is itself a revert: offered as "undo the revert". */
  isRevert?: boolean
}

type Scope = 'change' | 'page' | 'workspace'
type Period = 'today' | 'day' | 'week' | 'month'

function sinceOf(p: Period): string {
  const now = new Date()
  if (p === 'today') return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString()
  const hours = p === 'day' ? 24 : p === 'week' ? 24 * 7 : 24 * 30
  return new Date(now.getTime() - hours * 3_600_000).toISOString()
}

const selectCls =
  'rounded-md border border-line bg-app px-2 py-1 text-xs text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent'

export function RevertDialog({ wsId, source, onClose }: { wsId: string; source: RevertSource | null; onClose: () => void }) {
  const t = useT()
  const canWorkspace = useCanRevertWorkspace(wsId)
  const [scope, setScope] = useState<Scope>('change')
  const [period, setPeriod] = useState<Period>('today')
  const [result, setResult] = useState<RevertResultDTO | null>(null)
  // The period is fixed when chosen (not on every render), so the preview key is stable.
  const since = useMemo(() => sinceOf(period), [period])
  const target = useMemo<RevertTarget | null>(() => {
    if (!source || result) return null
    if (scope === 'change' || !source.via) return { kind: 'change', seq: source.seq }
    if (scope === 'page') return { kind: 'page', pageId: source.pageId, via: source.via, actorId: source.actor?.id, since }
    return { kind: 'workspace', wsId, via: source.via, actorId: source.actor?.id, since }
  }, [source, scope, since, wsId, result])
  const preview = useRevertPreview(target)
  const run = useRunRevert()

  const close = () => {
    setResult(null)
    setScope('change')
    onClose()
  }
  const shown = result ?? preview.data ?? null
  const runnable = !!preview.data && preview.data.totals.applied + preview.data.totals.partial > 0
  const doRun = () => {
    if (!target) return
    run.mutate(target, {
      onSuccess: (r) => {
        setResult(r)
        toast({ message: t('revert.done', { applied: r.totals.applied + r.totals.partial }) })
      },
      onError: (err) => toast({ message: err instanceof ApiError ? err.message : t('revert.failed') }),
    })
  }

  return (
    <Modal open={!!source} onClose={close} title={source?.isRevert ? t('revert.titleUndo') : t('revert.title')} size="lg">
      {source && (
        <div className="flex flex-col gap-3" data-testid="revert-dialog">
          <p className="text-xs text-sub">
            <span className="font-medium text-ink">{source.actor?.name ?? t('activity.someone')}</span>
            {source.via && <> · {t('activity.via', { client: source.via })}</>}
            {source.headingPath && <> · {source.headingPath}</>} · {relativeTime(source.changedAt)}
          </p>
          {source.via && !result && (
            <fieldset className="flex flex-col gap-1.5 rounded-md border border-line p-2.5 text-xs" data-testid="revert-scope">
              <legend className="px-1 text-[11px] font-medium text-sub">{t('revert.scope')}</legend>
              <label className="flex items-center gap-2">
                <input type="radio" name="revert-scope" checked={scope === 'change'} onChange={() => setScope('change')} />
                {t('revert.scopeChange')}
              </label>
              <label className="flex items-center gap-2">
                <input type="radio" name="revert-scope" checked={scope === 'page'} onChange={() => setScope('page')} />
                {t('revert.scopePage', { client: source.via })}
              </label>
              {canWorkspace && (
                <label className="flex items-center gap-2">
                  <input type="radio" name="revert-scope" checked={scope === 'workspace'} onChange={() => setScope('workspace')} />
                  {t('revert.scopeWorkspace', { client: source.via })}
                </label>
              )}
              {scope !== 'change' && (
                <label className="mt-1 flex items-center gap-2 pl-5">
                  <span className="text-sub">{t('revert.period')}</span>
                  <select value={period} onChange={(e) => setPeriod(e.target.value as Period)} className={selectCls} aria-label={t('revert.period')}>
                    <option value="today">{t('revert.periodToday')}</option>
                    <option value="day">{t('revert.periodDay')}</option>
                    <option value="week">{t('revert.periodWeek')}</option>
                    <option value="month">{t('revert.periodMonth')}</option>
                  </select>
                </label>
              )}
            </fieldset>
          )}

          {!shown && preview.isLoading ? (
            <div className="flex justify-center py-6">
              <Spinner size={18} />
            </div>
          ) : !shown && preview.isError ? (
            <p className="py-4 text-center text-xs text-red-600">
              {preview.error instanceof ApiError ? preview.error.message : t('revert.previewFailed')}
            </p>
          ) : shown ? (
            <RevertSummary r={shown} />
          ) : null}

          <div className="flex items-center justify-end gap-2">
            {run.isPending && <Spinner size={12} />}
            <button type="button" onClick={close} className="rounded-md px-3 py-1.5 text-xs text-sub hover:bg-hover">
              {result ? t('common.close') : t('suggestions.cancel')}
            </button>
            {!result && (
              <button
                type="button"
                onClick={doRun}
                disabled={!runnable || run.isPending}
                data-testid="revert-run"
                className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
              >
                {source.isRevert && scope === 'change' ? t('revert.runUndo') : t('revert.run')}
              </button>
            )}
          </div>
        </div>
      )}
    </Modal>
  )
}

function RevertSummary({ r }: { r: RevertResultDTO }) {
  const t = useT()
  const tt = r.totals
  return (
    <div className="flex flex-col gap-2" data-testid={r.dryRun ? 'revert-preview' : 'revert-result'}>
      <p className="text-xs text-ink">
        {r.dryRun ? t('revert.previewHead', { pages: tt.pages }) : t('revert.resultHead', { pages: r.pages.filter((p) => p.written).length })}
      </p>
      <div className="flex flex-wrap gap-1.5 text-[11px]">
        <Chip tone="ok" label={r.dryRun ? t('revert.will.applied') : t('revert.outcome.applied')} n={tt.applied} />
        <Chip tone="ok" label={r.dryRun ? t('revert.will.partial') : t('revert.outcome.partial')} n={tt.partial} />
        <Chip tone="warn" label={t('revert.outcome.conflict')} n={tt.conflicts} />
        <Chip tone="muted" label={t('revert.outcome.noop')} n={tt.noop} />
        <Chip tone="muted" label={t('revert.outcome.unsupported')} n={tt.unsupported} />
      </div>
      {r.truncated && <p className="text-[11px] text-amber-700 dark:text-amber-300">{t('revert.truncated')}</p>}
      <ul className="flex max-h-[45vh] flex-col gap-2 overflow-y-auto pr-1">
        {r.pages.map((p) => (
          <li key={p.pageId} className="rounded-md border border-line" data-testid="revert-page">
            <div className="flex items-center gap-2 border-b border-line bg-hover/40 px-2.5 py-1 text-xs">
              <span className="min-w-0 flex-1 truncate font-medium text-ink">{p.title || t('common.untitled')}</span>
              {!r.dryRun && p.written && <span className="text-emerald-700 dark:text-emerald-300">{t('revert.written')}</span>}
              {p.error && <span className="text-red-600">{p.error.message}</span>}
            </div>
            <ul className="divide-y divide-line/60">
              {p.changes.map((c) => (
                <ChangeLine key={c.seq} c={c} dryRun={r.dryRun} />
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </div>
  )
}

function Chip({ tone, label, n }: { tone: 'ok' | 'warn' | 'muted'; label: string; n: number }) {
  if (!n) return null
  const cls =
    tone === 'ok'
      ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
      : tone === 'warn'
        ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
        : 'bg-hover text-sub'
  return (
    <span className={`rounded px-1.5 py-0.5 ${cls}`}>
      {label} {n}
    </span>
  )
}

function ChangeLine({ c, dryRun }: { c: RevertChangeDTO; dryRun: boolean }) {
  const t = useT()
  const tone =
    c.outcome === 'applied' || c.outcome === 'partial'
      ? 'text-emerald-700 dark:text-emerald-300'
      : c.outcome === 'conflict'
        ? 'text-amber-700 dark:text-amber-300'
        : 'text-sub'
  return (
    <li className="flex flex-col gap-1 px-2.5 py-1.5 text-xs" data-testid="revert-change" data-outcome={c.outcome}>
      <div className="flex flex-wrap items-baseline gap-x-1.5">
        <span className={`font-medium ${tone}`}>
          {dryRun && (c.outcome === 'applied' || c.outcome === 'partial')
            ? t(`revert.will.${c.outcome}`)
            : t(`revert.outcome.${c.outcome}` as 'revert.outcome.applied')}
        </span>
        <span className="text-ink">{c.headingPath || c.anchor || t('suggestions.intro')}</span>
        <span className="text-sub">· {tMaybe(`activity.kind.${c.kind}`) ?? c.kind}</span>
        {c.via && <span className="text-sub">· {t('activity.via', { client: c.via })}</span>}
        <span className="ml-auto text-[11px] text-sub">{relativeTime(c.changedAt)}</span>
      </div>
      {c.reason && <p className="text-[11px] text-sub">{tMaybe(`revert.reason.${c.reason}`) ?? c.reason}</p>}
      {c.plainText > 0 && <p className="text-[11px] text-amber-700 dark:text-amber-300">{t('revert.plainText', { count: c.plainText })}</p>}
      {c.conflicts.map((k, i) => (
        <div key={i} className="overflow-hidden rounded border border-amber-500/40 font-mono text-[11px] leading-relaxed">
          <div className="bg-amber-500/10 px-2 py-0.5 font-sans text-amber-700 dark:text-amber-300">
            {k.reason === 'overlap' ? t('revert.conflictOverlap') : t('revert.conflictNoSource')}
          </div>
          {k.now && <div className="whitespace-pre-wrap break-words px-2 text-ink">{t('revert.now')} {k.now}</div>}
          {k.wanted && <div className="whitespace-pre-wrap break-words px-2 text-sub">{t('revert.wanted')} {k.wanted}</div>}
        </div>
      ))}
    </li>
  )
}
