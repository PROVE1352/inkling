import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import { api, ApiError, useLogout, useMe } from '../../api'
import { getLocaleChoice, useT } from '../../i18n'
import { Spinner } from '../Spinner'
import { InstanceBadge } from '../InstanceBadge'
import { AccountDeletionSlot, ACCOUNT_DELETION_READY } from './AccountDeletionSlot'
import { ConsentItems } from './ConsentItems'
import { LegalLanguageSelect, LegalLinks } from './LegalLinks'
import { submitConsent, useLegal } from './legalApi'

/**
 * The consent screen (docs/adr/2519-*): instead of the app, for a signed-in person who has not agreed
 * to the current version of this server's documents (an account made without the sign-up form, or
 * documents changed since). The same notice and tick boxes as the sign-up form; agree, sign out
 * without agreeing, or delete the account.
 */
export function ConsentScreen() {
  const t = useT()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const me = useMe()
  const legal = useLegal(true)
  const logout = useLogout()
  const [checked, setChecked] = useState<Set<string>>(() => new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const shownVersion = useRef<string | null>(null)

  useEffect(() => {
    const v = legal.data?.version
    if (!v) return
    if (shownVersion.current && shownVersion.current !== v) {
      setChecked(new Set())
      setError(t('legal.versionChanged'))
    }
    shownVersion.current = v
  }, [legal.data?.version, t])

  const data = legal.data
  const ready = !!data && data.items.every((i) => !i.required || checked.has(i.id))

  const agree = async () => {
    if (!data || !ready || busy) return
    setBusy(true)
    setError(null)
    try {
      await submitConsent({ consents: data.items.filter((i) => checked.has(i.id)).map((i) => i.id), legalVersion: data.version })
      // A language picked on this screen stayed in this browser (saving it is not allowed before the
      // consent): save it now, or the next /auth/me would switch back to the saved one.
      const choice = getLocaleChoice()
      if (me.data && (me.data.locale ?? null) !== choice) {
        await api('/api/auth/me/locale', { method: 'PATCH', body: JSON.stringify({ locale: choice }) }).catch(() => {})
      }
      await qc.invalidateQueries()
    } catch (err) {
      if (err instanceof ApiError && err.code === 'CONSENT_REQUIRED') void legal.refetch()
      setError(err instanceof ApiError ? err.message : t('legal.agreeFailed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-full justify-center overflow-y-auto break-keep bg-app px-4 py-10">
      <div className="w-full max-w-lg">
        <div className="mb-5 flex flex-col items-center gap-2 text-center">
          <img src="/icon.svg" alt="Inkling" className="h-10 w-10" />
          <InstanceBadge placement="auth" />
          <h1 className="text-lg font-semibold text-ink">{t('legal.consentTitle')}</h1>
          <p className="text-xs leading-relaxed text-sub">{t('legal.consentDesc')}</p>
        </div>

        <div className="flex flex-col gap-4 rounded-lg border border-line bg-app p-5">
          {legal.isLoading ? (
            <div className="flex justify-center py-6">
              <Spinner size={20} />
            </div>
          ) : !data ? (
            <p role="alert" className="text-sm text-red-600">
              {t('legal.loadFailed')}
            </p>
          ) : (
            <ConsentItems
              legal={data}
              checked={checked}
              onToggle={(id, on) =>
                setChecked((prev) => {
                  const next = new Set(prev)
                  if (on) next.add(id)
                  else next.delete(id)
                  return next
                })
              }
              missingText={t('legal.missingContinue')}
            />
          )}

          {error && (
            <p role="alert" className="text-xs text-red-600">
              {error}
            </p>
          )}

          <button
            type="button"
            onClick={() => void agree()}
            disabled={!ready || busy}
            className="flex items-center justify-center gap-2 rounded-md bg-accent px-3 py-2 text-sm font-medium text-white transition-colors duration-150 hover:opacity-90 disabled:opacity-60"
          >
            {busy && <Spinner size={16} className="border-white/40 border-t-white" />}
            {t('legal.agree')}
          </button>

          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3 text-xs">
            <button
              type="button"
              disabled={logout.isPending}
              onClick={() => logout.mutate(undefined, { onSettled: () => navigate('/login', { replace: true }) })}
              className="rounded-md px-2 py-1 text-sub transition-colors duration-150 hover:bg-hover hover:text-ink"
            >
              {t('legal.signOut')}
            </button>
            {ACCOUNT_DELETION_READY && (
              <button
                type="button"
                aria-expanded={deleting}
                onClick={() => setDeleting((v) => !v)}
                className="rounded-md px-2 py-1 text-red-600 transition-colors duration-150 hover:bg-hover"
              >
                {t('legal.deleteAccount')}
              </button>
            )}
          </div>
          {ACCOUNT_DELETION_READY && deleting && <AccountDeletionSlot />}
        </div>

        <div className="mt-5 flex flex-col items-center gap-3">
          <LegalLinks />
          <LegalLanguageSelect />
        </div>
      </div>
    </div>
  )
}

