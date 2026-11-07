import { useState, type ReactNode } from 'react'
import { ApiError } from '../api'
import { DatabaseIcon, DownloadIcon, LockIcon } from '../components/Icons'
import { Pager, paginate } from '../components/Pager'
import { Spinner } from '../components/Spinner'
import { backupDownloadUrl, useAdminBackups, useRunBackup, type BackupRunInfo } from './api'
import { BACKUP_STRINGS as S } from './strings'
import { fmtDateTime } from '../i18n'

// Admin → Backups: sidecar status, read-only settings, set list with download, "Back up now".
// Restoring is intentionally CLI only (deploy/restore.sh) — see docs/BACKUP.md.

const PER_PAGE = 5

const outlineBtn =
  'rounded-md border border-line px-3 py-1.5 text-xs text-sub transition-colors duration-150 hover:bg-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-50'

const fmtTime = (iso?: string | null) => (iso ? fmtDateTime(iso) : S.never)

function fmtBytes(n?: number): string {
  if (!n || n <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)))
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

function Badge({ children, cls }: { children: ReactNode; cls: string }) {
  return <span className={`rounded px-1.5 py-0.5 text-[11px] ${cls}`}>{children}</span>
}

const okCls = 'bg-emerald-500/10 text-emerald-600'
const badCls = 'bg-red-500/10 text-red-600'
const mutedCls = 'bg-sub/10 text-sub'

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-md border border-line px-3 py-2">
      <span className="text-[11px] font-medium uppercase tracking-wide text-sub">{label}</span>
      <div className="text-sm text-ink">{children}</div>
    </div>
  )
}

function CheckResult({ info }: { info?: BackupRunInfo }) {
  if (!info) return <span className="text-sub">{S.never}</span>
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Badge cls={info.ok === false ? badCls : okCls}>{info.ok === false ? S.failed : S.ok}</Badge>
        <span className="text-xs text-sub">{fmtTime(info.at)}</span>
      </div>
      {info.message && <p className="mt-1 break-words text-xs text-sub">{info.message}</p>}
    </>
  )
}

export function AdminBackupsSection() {
  const q = useAdminBackups()
  const run = useRunBackup()
  const [page, setPage] = useState(1)
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null)

  const data = q.data
  const st = data?.status ?? null
  const cfg = st?.config
  const busy = !!(data?.pending || st?.running)
  const canRun =
    !!data?.configured && !!st && cfg?.enabled !== false && !data.stale && !busy && !run.isPending

  const onRun = () => {
    setMsg(null)
    run.mutate(undefined, {
      onSuccess: () => setMsg({ text: S.queuedHint }),
      onError: (err) =>
        setMsg({ text: err instanceof ApiError ? err.message : S.runFailed, error: true }),
    })
  }

  const view = paginate(data?.sets ?? [], page, PER_PAGE)
  const runLabel = st?.running ? S.running : data?.pending || run.isPending ? S.queued : S.runNow

  return (
    <section className="mb-10">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
          <DatabaseIcon size={15} className="text-sub" />
          {S.title}
        </h2>
        {data?.configured && (
          <button type="button" onClick={onRun} disabled={!canRun} className={`${outlineBtn} ml-auto flex items-center gap-1.5`}>
            {busy && <Spinner size={12} />}
            {runLabel}
          </button>
        )}
      </div>
      <p className="mb-3 text-xs text-sub">{S.intro}</p>
      {msg && <p className={`mb-3 text-xs ${msg.error ? 'text-red-600' : 'text-emerald-600'}`}>{msg.text}</p>}

      {q.isLoading && <Spinner />}
      {q.error && (
        <p className="text-xs text-red-600">{q.error instanceof ApiError ? q.error.message : S.runFailed}</p>
      )}
      {data && !data.configured && <p className="text-sm text-sub">{S.notConfigured}</p>}

      {data?.configured && (
        <>
          {data.alert && (
            <div role="alert" className="mb-3 rounded-lg border border-red-500/40 bg-red-500/5 p-3">
              <div className="text-sm font-semibold text-red-600">
                {S.alertKind[data.alert.kind] ?? S.alertTitle}
              </div>
              <p className="mt-1 break-words text-xs text-ink">{data.alert.message}</p>
              <p className="mt-1 text-[11px] text-sub">{fmtTime(data.alert.at)}</p>
            </div>
          )}
          {!st && <p className="mb-3 text-sm text-sub">{S.notStarted}</p>}
          {cfg?.enabled === false && <p className="mb-3 text-sm text-sub">{S.disabled}</p>}

          <div className="mb-4 grid gap-2 sm:grid-cols-2">
            <Row label={S.lastSuccess}>
              {st?.lastSuccess ? (
                <>
                  {fmtTime(st.lastSuccess.at)}
                  <span className="ml-2 text-xs text-sub">
                    {fmtBytes(st.lastSuccess.sizeBytes)}
                    {st.lastSuccess.kind ? ` · ${S.kind[st.lastSuccess.kind] ?? st.lastSuccess.kind}` : ''}
                    {st.lastSuccess.durationSec != null ? ` · ${st.lastSuccess.durationSec}s` : ''}
                  </span>
                </>
              ) : (
                <span className="text-sub">{S.never}</span>
              )}
            </Row>
            <Row label={S.lastFailure}>
              {st?.lastFailure ? (
                <>
                  {fmtTime(st.lastFailure.at)}
                  {st.lastFailure.message && (
                    <p className="mt-1 break-words text-xs text-sub">{st.lastFailure.message}</p>
                  )}
                </>
              ) : (
                <span className="text-sub">{S.none}</span>
              )}
            </Row>
            <Row label={S.nextRun}>
              {st?.nextRunAt ? fmtTime(st.nextRunAt) : <span className="text-sub">{S.manualOnly}</span>}
            </Row>
            <Row label={S.retention}>
              {S.retentionValue(cfg?.keepDaily ?? 0, cfg?.keepWeekly ?? 0, cfg?.keepMonthly ?? 0, data.sets.length)}
            </Row>
            <Row label={S.verification}>
              <CheckResult info={st?.lastVerify} />
            </Row>
            <Row label={S.restoreTest}>
              <CheckResult info={st?.lastRestoreTest} />
            </Row>
            <Row label={S.remote}>
              {!cfg?.remote ? (
                <span className="text-sub">{S.remoteOff}</span>
              ) : cfg.remoteTool === 'missing' ? (
                <span className="text-red-600">{S.remoteMissingTool}</span>
              ) : (
                <>
                  <code className="rounded bg-side px-1 text-xs">{cfg.remote}</code>
                  <CheckResult info={st?.remote} />
                </>
              )}
            </Row>
            <Row label={S.encryption}>
              <span className="flex items-center gap-1.5">
                {cfg?.encrypted && <LockIcon size={13} className="text-sub" />}
                {cfg?.encrypted ? S.encryptionOn : S.encryptionOff}
              </span>
            </Row>
          </div>

          <details className="mb-4 rounded-md border border-line px-3 py-2">
            <summary className="cursor-pointer text-xs font-medium text-sub">{S.settings}</summary>
            <dl className="mt-2 grid grid-cols-[auto,1fr] gap-x-4 gap-y-1 text-xs">
              <dt className="text-sub">{S.setting.schedule}</dt>
              <dd><code>{cfg?.schedule ?? S.none}</code></dd>
              <dt className="text-sub">{S.setting.timezone}</dt>
              <dd>{cfg?.timezone ?? S.none}</dd>
              <dt className="text-sub">{S.setting.restoreTest}</dt>
              <dd>{S.restoreTestEvery(cfg?.restoreTestDays ?? 0)}</dd>
              <dt className="text-sub">{S.setting.minFree}</dt>
              <dd>{cfg?.minFreeMb != null ? `${cfg.minFreeMb} MB` : S.none}</dd>
              <dt className="text-sub">{S.setting.cipher}</dt>
              <dd className="break-all"><code>{cfg?.cipher ?? S.none}</code></dd>
              <dt className="text-sub">{S.setting.remote}</dt>
              <dd className="break-all"><code>{cfg?.remote || S.none}</code></dd>
            </dl>
            <p className="mt-2 text-[11px] text-sub">{S.settingsHint}</p>
          </details>

          <h3 className="mb-2 text-xs font-semibold text-ink">{S.sets}</h3>
          {view.items.length === 0 ? (
            <p className="text-sm text-sub">{S.noSets}</p>
          ) : (
            <>
              <ul className="flex flex-col gap-2">
                {view.items.map((s) => (
                  <li key={s.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-line px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm text-ink">{fmtTime(s.createdAt)}</span>
                        <Badge cls={mutedCls}>{S.kind[s.kind] ?? s.kind}</Badge>
                        {s.encrypted && (
                          <Badge cls={mutedCls}>
                            <span className="inline-flex items-center gap-1">
                              <LockIcon size={10} />
                              {S.encryptedBadge}
                            </span>
                          </Badge>
                        )}
                        {st?.lastRestoreTest?.setId === s.id && (
                          <Badge cls={st.lastRestoreTest.ok === false ? badCls : okCls}>{S.restoreTest}</Badge>
                        )}
                      </div>
                      <div className="mt-0.5 flex flex-wrap gap-x-3 text-[11px] text-sub">
                        <code>{s.id}</code>
                        <span>{fmtBytes(s.totalBytes)}</span>
                        {s.migration && (
                          <span>
                            {S.migration} {s.migration}
                          </span>
                        )}
                      </div>
                    </div>
                    <a
                      href={backupDownloadUrl(s.id)}
                      download
                      title={S.downloadHint(s.encrypted)}
                      className={`${outlineBtn} flex items-center gap-1`}
                    >
                      <DownloadIcon size={12} />
                      {S.download}
                    </a>
                  </li>
                ))}
              </ul>
              <Pager page={view.page} pageCount={view.pageCount} onChange={setPage} />
            </>
          )}
          <p className="mt-3 text-[11px] text-sub">
            {S.restoreCli} <code className="rounded bg-side px-1">./deploy/restore.sh --dry-run &lt;set-id&gt;</code>
          </p>
        </>
      )}
    </section>
  )
}
