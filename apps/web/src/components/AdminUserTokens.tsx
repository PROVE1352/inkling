import { useState } from 'react'
import { useAdminRevokeUserTokens, useAdminUserTokens } from '../apiTokens'
import { useT } from '../i18n'

/**
 * Admin › Users: a member's personal API tokens (docs/adr/1201-*). Loaded on demand (one request per
 * opened row, not per listed user); "Revoke all" cuts every script of that account at once.
 */
export function AdminUserTokens({ userId, name, className }: { userId: string; name: string; className: string }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const tokens = useAdminUserTokens(userId, open)
  const revoke = useAdminRevokeUserTokens()
  if (!open) {
    return (
      <button type="button" className={className} onClick={() => setOpen(true)} data-testid="admin-user-tokens">
        {t('admin.tokens')}
      </button>
    )
  }
  const n = tokens.data?.length ?? 0
  if (tokens.isLoading) return <span className="px-1 text-xs text-sub">…</span>
  if (n === 0) return <span className="px-1 text-xs text-sub">{t('admin.tokensNone')}</span>
  return (
    <button
      type="button"
      className={`${className} text-red-600`}
      disabled={revoke.isPending}
      title={tokens.data?.map((x) => `${x.name} (${x.prefix}…)`).join('\n')}
      onClick={() => {
        if (window.confirm(t('admin.tokensRevokeConfirm', { name }))) revoke.mutate(userId)
      }}
    >
      {t('admin.tokensRevokeAll', { count: n })}
    </button>
  )
}
