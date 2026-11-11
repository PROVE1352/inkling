import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiError, api, triggerDownload } from '../../api'
import { useT } from '../../i18n'
import { Modal } from '../Modal'
import { Row } from '../SettingsRows'
import { Spinner } from '../Spinner'
import { DownloadIcon } from '../Icons'
import * as offline from '../../lib/offline/runtime'

/** GET /api/me/delete-preview (server: account/routes.ts DeletePreviewDTO). */
interface DeletePreview {
  deleted: { id: string; name: string; pages: number; files: number }[]
  transferred: { id: string; name: string; to: { id: string; name: string } }[]
  kept: { id: string; name: string }[]
  privatePages: number
  pages: number
  files: number
  needs: { password: boolean; code: boolean; recentSignIn: boolean }
  confirm: string
  lastAdmin: boolean
}

const btn =
  'flex items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition duration-150 disabled:opacity-60'
const btnDanger = `${btn} bg-red-600 text-white hover:opacity-90 active:scale-[.98]`
const btnPlain = `${btn} border border-line text-ink hover:bg-hover`
const input =
  'w-full rounded-md border border-line bg-app px-3 py-2 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent'

/**
 * Settings › Account › Delete account (docs/adr/2514-*): what goes and what stays, "cannot be
 * undone", export links, the password (and 2FA code) or a recent sign-in, and the sign-in email or
 * ID typed as confirmation. Leaving works on every server.
 */
export function DeleteAccount() {
  const t = useT()
  const [open, setOpen] = useState(false)
  return (
    <>
      <Row title={t('accountLifecycle.deleteTitle')} desc={t('accountLifecycle.deleteDesc')}>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="rounded-md border border-red-500/40 px-2 py-1 text-xs text-red-600 transition-colors duration-150 hover:bg-red-500/10"
        >
          {t('accountLifecycle.deleteButton')}
        </button>
      </Row>
      {open && <DeleteAccountModal onClose={() => setOpen(false)} />}
    </>
  )
}

/**
 * The deletion dialog itself. Settings › Account opens it from its row; the consent screen opens it
 * through AccountDeletionSlot with `beforeConsent`: the export buttons are left out there (export is
 * not on the consent gate's exception list, so it would answer CONSENT_REQUIRED) and a line says so.
 */
export function DeleteAccountModal({ onClose, beforeConsent = false }: { onClose: () => void; beforeConsent?: boolean }) {
  const t = useT()
  const qc = useQueryClient()
  const preview = useQuery({
    queryKey: ['me', 'delete-preview'],
    queryFn: () => api<DeletePreview>('/api/me/delete-preview'),
    staleTime: 0,
  })
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const p = preview.data

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!p) return
    setBusy(true)
    setError(null)
    try {
      await api('/api/me', {
        method: 'DELETE',
        body: JSON.stringify({ confirm, ...(p.needs.password ? { password } : {}), ...(p.needs.code ? { code } : {}) }),
      })
      // the session is gone with the account: start over at the sign-in screen
      qc.clear()
      await offline.wipeOffline().catch(() => undefined)
      window.location.assign('/login?deleted=1')
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('accountLifecycle.deleteFailed'))
      setBusy(false)
    }
  }

  return (
    <Modal open onClose={onClose} title={t('accountLifecycle.deleteTitle')} size="md">
      {preview.isLoading || !p ? (
        <div className="flex justify-center py-6">
          {preview.isError ? <p className="text-sm text-red-600">{t('accountLifecycle.deleteFailed')}</p> : <Spinner size={20} />}
        </div>
      ) : p.lastAdmin ? (
        <div className="flex flex-col gap-4" data-testid="delete-account-last-admin">
          <p className="text-sm text-sub">{t('errors.LAST_ADMIN')}</p>
          <div className="flex justify-end">
            <button type="button" className={btnPlain} onClick={onClose}>
              {t('common.close')}
            </button>
          </div>
        </div>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-4" data-testid="delete-account">
          <p className="text-sm font-medium text-red-600">{t('accountLifecycle.irreversible')}</p>
          <section className="flex flex-col gap-2 text-sm">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-sub">{t('accountLifecycle.goes')}</h3>
            <ul className="flex flex-col gap-1 text-ink">
              {p.deleted.map((w) => (
                <li key={w.id} className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate">
                    {t('accountLifecycle.goesWorkspace', { name: w.name, pages: w.pages, files: w.files })}
                  </span>
                  {!beforeConsent && (
                    <button
                      type="button"
                      onClick={() => triggerDownload(`/api/workspaces/${w.id}/export`)}
                      className="flex shrink-0 items-center gap-1 rounded-md border border-line px-2 py-0.5 text-xs text-ink hover:bg-hover"
                    >
                      <DownloadIcon size={12} /> {t('accountLifecycle.export')}
                    </button>
                  )}
                </li>
              ))}
              {p.privatePages > 0 && <li>{t('accountLifecycle.goesPrivate', { count: p.privatePages })}</li>}
              <li>{t('accountLifecycle.goesAccount')}</li>
            </ul>
            {beforeConsent && p.deleted.length > 0 && <p className="text-xs text-sub">{t('legal.deleteNoExport')}</p>}
          </section>
          {(p.transferred.length > 0 || p.kept.length > 0) && (
            <section className="flex flex-col gap-2 text-sm">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-sub">{t('accountLifecycle.stays')}</h3>
              <ul className="flex flex-col gap-1 text-ink">
                {p.transferred.map((w) => (
                  <li key={w.id}>{t('accountLifecycle.staysTransferred', { name: w.name, to: w.to.name })}</li>
                ))}
                {p.kept.map((w) => (
                  <li key={w.id}>{t('accountLifecycle.staysKept', { name: w.name })}</li>
                ))}
              </ul>
            </section>
          )}
          {p.needs.recentSignIn && <p className="text-xs text-sub">{t('accountLifecycle.recentSignIn')}</p>}
          {p.needs.password && (
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-sub">{t('settings.currentPassword')}</span>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" className={input} />
            </label>
          )}
          {p.needs.code && (
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-sub">{t('accountLifecycle.code')}</span>
              <input type="text" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" inputMode="numeric" className={input} />
            </label>
          )}
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-sub">{t('accountLifecycle.confirmLabel', { text: p.confirm })}</span>
            <input
              type="text"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              className={input}
            />
          </label>
          {error && <p className="text-xs text-red-600">{error}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" className={btnPlain} onClick={onClose}>
              {t('common.cancel')}
            </button>
            <button
              type="submit"
              className={btnDanger}
              disabled={busy || confirm.trim().toLowerCase() !== p.confirm.toLowerCase() || (p.needs.password && !password) || (p.needs.code && !code)}
            >
              {busy && <Spinner size={14} className="border-white/40 border-t-white" />}
              {t('accountLifecycle.deleteConfirm')}
            </button>
          </div>
        </form>
      )}
    </Modal>
  )
}
