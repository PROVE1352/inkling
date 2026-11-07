import { useState } from 'react'
import { ApiError } from '../api'
import { PlugIcon } from '../components/Icons'
import { Spinner } from '../components/Spinner'
import { askConfirm } from '../lib/confirm'
import {
  useAdminPlugins,
  useApprovePlugin,
  useDisablePlugin,
  usePluginsEnabled,
  useRemovePlugin,
  type AdminPluginDTO,
} from './api'
import { PLUGIN_STRINGS as S } from './strings'
import { fmtDateTime, t } from '../i18n'

// Admin → Plugins (experimental). Lists PLUGINS_DIR, shows requested permissions, and approves
// exactly the reviewed content hash. Renders nothing unless the `plugins` experiment is on.

const outlineBtn =
  'rounded-md border border-line px-3 py-1.5 text-xs text-sub transition-colors duration-150 hover:bg-hover hover:text-ink disabled:opacity-50'

const STATUS_CLS: Record<string, string> = {
  enabled: 'bg-emerald-500/10 text-emerald-600',
  disabled: 'bg-sub/10 text-sub',
  'not-approved': 'bg-amber-500/10 text-amber-600',
  'needs-reapproval': 'bg-amber-500/10 text-amber-600',
  invalid: 'bg-red-500/10 text-red-600',
  missing: 'bg-red-500/10 text-red-600',
}

const fmt = (iso: string | null) => (iso ? fmtDateTime(iso) : '—')
const errText = (err: unknown) => (err instanceof ApiError ? err.message : t('plugins.requestFailed'))

function PluginRow({ p }: { p: AdminPluginDTO }) {
  const approve = useApprovePlugin()
  const disable = useDisablePlugin()
  const remove = useRemovePlugin()
  const m = p.manifest
  const [granted, setGranted] = useState<Set<string>>(
    () => new Set(p.install?.approvedHash === p.hash ? (p.install?.approvedPermissions ?? m?.permissions) : m?.permissions),
  )
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null)
  const busy = approve.isPending || disable.isPending || remove.isPending

  const onApprove = async () => {
    if (!m || !p.hash) return
    const perms = m.permissions.filter((x) => granted.has(x))
    if (!(await askConfirm(S.adminConfirmApprove(m.name, perms), S.adminConfirmLabel))) return
    setMsg(null)
    approve.mutate(
      { id: p.id, hash: p.hash, permissions: perms },
      {
        onError: (err) =>
          setMsg({ text: err instanceof ApiError && err.code === 'PLUGIN_CHANGED' ? S.adminChanged : errText(err), error: true }),
      },
    )
  }
  const onRemove = async () => {
    if (!(await askConfirm(S.adminConfirmRemove(m?.name ?? p.id), S.adminRemoveLabel))) return
    remove.mutate(p.id, { onError: (err) => setMsg({ text: errText(err), error: true }) })
  }

  return (
    <li className="rounded-lg border border-line p-3">
      <div className="flex flex-wrap items-center gap-2">
        <PlugIcon size={15} className="text-sub" />
        <span className="text-sm font-medium text-ink">{m?.name ?? p.id}</span>
        {m && <span className="text-xs text-sub">v{m.version}</span>}
        <code className="rounded bg-side px-1 text-[11px] text-sub">{p.id}</code>
        <span className={`rounded px-1.5 py-0.5 text-[11px] ${STATUS_CLS[p.status] ?? ''}`}>
          {S.status[p.status] ?? p.status}
        </span>
      </div>
      {m?.description && <p className="mt-1 text-xs text-sub">{m.description}</p>}
      {m?.author && <p className="mt-0.5 text-[11px] text-sub">{m.author}</p>}
      {p.error && <p className="mt-1 text-xs text-red-600">{p.error}</p>}

      {m && (
        <div className="mt-2 grid gap-2 text-xs sm:grid-cols-2">
          <div>
            <div className="mb-1 font-medium text-sub">{S.adminRequested}</div>
            {m.permissions.length === 0 && <div className="text-sub">—</div>}
            {m.permissions.map((perm) => (
              <label key={perm} className="flex items-start gap-2 py-0.5">
                <input
                  type="checkbox"
                  checked={granted.has(perm)}
                  onChange={(e) => {
                    const next = new Set(granted)
                    if (e.target.checked) next.add(perm)
                    else next.delete(perm)
                    setGranted(next)
                  }}
                  className="mt-0.5"
                />
                <span>
                  <code className="text-ink">{perm}</code>
                  <span className="ml-1 text-sub">{S.permissionHelp[perm] ?? ''}</span>
                </span>
              </label>
            ))}
          </div>
          <div className="space-y-1 text-sub">
            {!!m.commands?.length && (
              <div>
                <span className="font-medium">{S.adminCommands}: </span>
                {m.commands.map((c) => c.title).join(', ')}
              </div>
            )}
            {!!m.blocks?.length && (
              <div>
                <span className="font-medium">{S.adminBlocks}: </span>
                {m.blocks.map((b) => b.title).join(', ')}
              </div>
            )}
            <div className="break-all">
              <span className="font-medium">{S.adminHash}: </span>
              <code className="text-[11px]">{p.hash?.slice(0, 16)}…</code>
            </div>
            {p.install?.approvedAt && <div>{S.adminApprovedBy(p.install.approvedByName, fmt(p.install.approvedAt))}</div>}
          </div>
        </div>
      )}

      <div className="mt-2 flex flex-wrap gap-2">
        {m && p.hash && p.status !== 'enabled' && (
          <button type="button" className={outlineBtn} disabled={busy} onClick={() => void onApprove()}>
            {p.status === 'needs-reapproval' ? S.adminReapprove : S.adminApprove}
          </button>
        )}
        {p.status === 'enabled' && (
          <button
            type="button"
            className={outlineBtn}
            disabled={busy}
            onClick={() => disable.mutate(p.id, { onError: (err) => setMsg({ text: errText(err), error: true }) })}
          >
            {S.adminDisable}
          </button>
        )}
        {p.install && (
          <button type="button" className={outlineBtn} disabled={busy} onClick={() => void onRemove()}>
            {S.adminRemove}
          </button>
        )}
      </div>
      {msg && <p className={`mt-1 text-xs ${msg.error ? 'text-red-600' : 'text-emerald-600'}`}>{msg.text}</p>}
    </li>
  )
}

export function AdminPluginsSection() {
  const enabled = usePluginsEnabled()
  const q = useAdminPlugins(enabled)
  if (!enabled) return null
  // Own top margin (not a wrapper div in Admin.tsx) so nothing is left behind when the flag is off.
  return (
    <section className="mt-10 mb-10">
      <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold text-ink">{S.adminTitle}</h2>
      {q.data && <p className="mb-3 text-xs text-sub">{S.adminIntro(q.data.pluginsDir)}</p>}
      {q.isLoading && <Spinner />}
      {q.isError && <p className="text-xs text-red-600">{errText(q.error)}</p>}
      {q.data && q.data.plugins.length === 0 && <p className="text-sm text-sub">{S.adminEmpty}</p>}
      {q.data && q.data.plugins.length > 0 && (
        <ul className="space-y-2">
          {q.data.plugins.map((p) => (
            <PluginRow key={`${p.id}:${p.hash ?? ''}`} p={p} />
          ))}
        </ul>
      )}
    </section>
  )
}
