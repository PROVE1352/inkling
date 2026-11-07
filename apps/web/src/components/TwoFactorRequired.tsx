import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import type { WorkspaceDTO } from '@inkling/shared'
import { qk, TWO_FACTOR_REQUIRED_EVENT, useTwoFactorState, useWorkspaces } from '../api'
import { fmtDate, useT } from '../i18n'
import { LockIcon, XIcon } from './Icons'
import { TwoFactorSettings } from './TwoFactorSettings'
import { WorkspaceAvatar } from './WorkspaceAvatar'

// Workspace policy "require two-step verification" (docs/adr/1112-*): the banner during the grace
// period and the setup screen once the workspace refuses requests. Both are driven by
// WorkspaceDTO.twoFactor from the workspace list, which the server always answers.

/** Refetch the workspace list when any request answers 403 TWO_FACTOR_REQUIRED (grace ran out while open). */
export function useTwoFactorRequiredListener(): void {
  const qc = useQueryClient()
  useEffect(() => {
    const on = () => void qc.invalidateQueries({ queryKey: qk.workspaces })
    window.addEventListener(TWO_FACTOR_REQUIRED_EVENT, on)
    return () => window.removeEventListener(TWO_FACTOR_REQUIRED_EVENT, on)
  }, [qc])
}

export function useWorkspaceTwoFactor(wsId: string): { ws: WorkspaceDTO | undefined; state: string } {
  const workspaces = useWorkspaces()
  const ws = workspaces.data?.find((w) => w.id === wsId)
  return { ws, state: ws?.twoFactor?.state ?? 'off' }
}

/** Thin banner above the page during the grace period. Dismissable for this visit. */
export function TwoFactorBanner({ wsId }: { wsId: string }) {
  const t = useT()
  const { ws, state } = useWorkspaceTwoFactor(wsId)
  const [hidden, setHidden] = useState<string | null>(null)
  if (state !== 'grace' || !ws?.twoFactor?.deadline || hidden === wsId) return null
  return (
    <div
      role="status"
      // pr-14 keeps the dismiss button clear of the fixed notification bell (top right)
      className="flex shrink-0 flex-wrap items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 py-1.5 pl-4 pr-14 text-xs text-ink"
    >
      <LockIcon size={13} className="shrink-0 text-amber-600" />
      <span>{t('wsTwoFactor.banner', { name: ws.name, date: fmtDate(ws.twoFactor.deadline) })}</span>
      <Link
        to={`/w/${wsId}/settings#security`}
        className="rounded-md px-2 py-0.5 text-accent transition-colors duration-150 hover:bg-hover"
      >
        {t('wsTwoFactor.bannerAction')}
      </Link>
      <button
        type="button"
        onClick={() => setHidden(wsId)}
        aria-label={t('emailVerify.dismiss')}
        className="ml-auto rounded-md p-0.5 text-sub transition-colors duration-150 hover:bg-hover hover:text-ink"
      >
        <XIcon size={14} />
      </button>
    </div>
  )
}

/**
 * Full-screen stand-in for the workspace once its requirement blocks the caller. Renders from the
 * workspace list and the account's own 2FA routes only (no workspace request would succeed), and
 * embeds the regular setup so the person never has to leave.
 */
export function TwoFactorGate({ ws }: { ws: WorkspaceDTO }) {
  const t = useT()
  const qc = useQueryClient()
  const state = useTwoFactorState()
  const workspaces = useWorkspaces()
  const others = (workspaces.data ?? []).filter((w) => w.id !== ws.id && w.twoFactor?.state !== 'blocked')
  return (
    <div className="flex h-full justify-center overflow-y-auto bg-app px-4 py-10">
      <div className="w-full max-w-lg">
        <div className="mb-5 flex items-center gap-3">
          <WorkspaceAvatar name={ws.name} icon={ws.icon} size={32} />
          <div className="min-w-0">
            <h1 className="truncate text-lg font-semibold text-ink">{t('wsTwoFactor.gateTitle')}</h1>
            <p className="truncate text-xs text-sub">{ws.name}</p>
          </div>
        </div>
        <p className="mb-5 text-sm text-sub">{t('wsTwoFactor.gateBody')}</p>
        <TwoFactorSettings />
        {state.data?.enabled && (
          <button
            type="button"
            onClick={() => void qc.invalidateQueries({ queryKey: qk.workspaces })}
            className="mt-4 rounded-md bg-accent px-3 py-1.5 text-sm text-white transition duration-150 hover:opacity-90"
          >
            {t('wsTwoFactor.gateContinue')}
          </button>
        )}
        {others.length > 0 && (
          <p className="mt-6 text-xs text-sub">
            {t('wsTwoFactor.gateOther')}{' '}
            {others.map((w, i) => (
              <span key={w.id}>
                {i > 0 && ', '}
                <Link to={`/w/${w.id}`} className="text-accent hover:underline">
                  {w.name}
                </Link>
              </span>
            ))}
          </p>
        )}
      </div>
    </div>
  )
}
