import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { ApiError, api, qk } from '../../api'
import { useT } from '../../i18n'

/**
 * Admin › Users: an account's deletion date (ACCOUNT_LIFETIME_DAYS, docs/adr/2515-*) and "Lift
 * expiry" (PATCH /api/admin/users/:id/expiry with null). Moving the date is an API-only operation.
 */
export function AdminExpiry({ userId, expiresAt }: { userId: string; expiresAt: string }) {
  const t = useT()
  const qc = useQueryClient()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const d = new Date(expiresAt)
  const p = (n: number) => String(n).padStart(2, '0')
  const date = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`

  const lift = async () => {
    if (!window.confirm(t('accountLifecycle.liftConfirm', { date }))) return
    setBusy(true)
    setError(null)
    try {
      await api(`/api/admin/users/${userId}/expiry`, { method: 'PATCH', body: JSON.stringify({ expiresAt: null }) })
      await qc.invalidateQueries({ queryKey: qk.adminUsers })
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('accountLifecycle.liftFailed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <span className="inline-flex items-center gap-1" data-testid="admin-expiry">
      <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[11px] text-amber-600">{t('accountLifecycle.adminExpires', { date })}</span>
      <button
        type="button"
        disabled={busy}
        onClick={lift}
        className="rounded px-1.5 py-0.5 text-[11px] text-accent hover:bg-hover disabled:opacity-50"
      >
        {t('accountLifecycle.lift')}
      </button>
      {error && <span className="text-[11px] text-red-600">{error}</span>}
    </span>
  )
}
