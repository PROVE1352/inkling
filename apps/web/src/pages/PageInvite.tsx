import { useState } from 'react'
import { Navigate, useNavigate, useParams } from 'react-router'
import { ApiError, useLogout, useMe } from '../api'
import { useAcceptPageInvite, usePageInvite } from '../pageAccessApi'
import { levelLabel } from '../lib/pageAccess'
import { FullScreenSpinner, Spinner } from '../components/Spinner'
import { useT } from '../i18n'

// /invite/page/:token — an invitation to one page tree for an address without an account
// (docs/adr/1253-*). Signed-out visitors go to /login carrying next (sign up from there), then come
// back here; accepting makes them a guest of that page and opens it.
export function PageInvite() {
  const t = useT()
  const { token = '' } = useParams()
  const navigate = useNavigate()
  const me = useMe()
  const preview = usePageInvite(token, !!me.data)
  const accept = useAcceptPageInvite(token)
  const logout = useLogout()
  const [error, setError] = useState<string | null>(null)

  if (me.isLoading) return <FullScreenSpinner />
  const here = `/invite/page/${token}`
  if (me.isError || !me.data) return <Navigate to={`/login?next=${encodeURIComponent(here)}`} replace />

  const submit = () => {
    setError(null)
    accept.mutate(undefined, {
      onSuccess: (r) => navigate(`/w/${r.workspaceId}/p/${r.pageId}`, { replace: true }),
      onError: (err) => {
        if (err instanceof ApiError && err.code === 'INVITE_EMAIL_MISMATCH') setError(t('pageInvite.emailMismatch'))
        else setError(err instanceof ApiError ? err.message : t('pageInvite.failed'))
      },
    })
  }
  const switchAccount = () =>
    logout.mutate(undefined, {
      onSettled: () => navigate(`/login?next=${encodeURIComponent(here)}`, { replace: true }),
    })

  const inv = preview.data
  return (
    <div className="flex min-h-full items-center justify-center bg-app px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-2">
          <img src="/icon.svg" alt="Inkling" className="h-12 w-12" />
          <h1 className="text-xl font-bold text-ink">Inkling</h1>
        </div>

        <div className="flex flex-col items-center gap-4 rounded-lg border border-line bg-app p-6 text-center">
          {preview.isLoading ? (
            <div className="py-6">
              <Spinner size={24} />
            </div>
          ) : preview.isError || !inv ? (
            <>
              <p className="text-sm text-ink">{t('pageInvite.invalid')}</p>
              <p className="text-xs text-sub">{t('pageInvite.invalidHint')}</p>
              <button
                type="button"
                onClick={() => navigate('/', { replace: true })}
                className="mt-1 rounded-md border border-line px-3 py-2 text-sm text-sub transition duration-150 hover:bg-hover hover:text-ink active:scale-[.98]"
              >
                {t('verify.toHome')}
              </button>
            </>
          ) : (
            <>
              <p className="text-base font-semibold text-ink">{t('pageInvite.title')}</p>
              <p className="text-sm text-ink">
                {inv.invitedBy
                  ? t('pageInvite.body', { inviter: inv.invitedBy, page: inv.pageTitle || t('common.untitled'), workspace: inv.workspaceName })
                  : t('pageInvite.bodyNoInviter', { page: inv.pageTitle || t('common.untitled'), workspace: inv.workspaceName })}
              </p>
              <div className="flex flex-col gap-1 text-xs text-sub">
                <span>{t('pageInvite.level', { level: levelLabel(inv.level) })}</span>
                <span>{t('pageInvite.guestNote')}</span>
              </div>
              {!inv.emailMatches && (
                <p className="rounded-md border border-line bg-hover/40 px-3 py-2 text-xs text-ink">
                  {t('pageInvite.emailMismatch')}
                </p>
              )}
              {error && <p className="text-xs text-red-600">{error}</p>}
              <div className="mt-1 flex w-full gap-2">
                {inv.emailMatches ? (
                  <>
                    <button
                      type="button"
                      onClick={() => navigate('/', { replace: true })}
                      className="flex-1 rounded-md border border-line px-3 py-2 text-sm text-sub transition duration-150 hover:bg-hover hover:text-ink active:scale-[.98]"
                    >
                      {t('common.cancel')}
                    </button>
                    <button
                      type="button"
                      onClick={submit}
                      disabled={accept.isPending}
                      className="flex flex-1 items-center justify-center gap-2 rounded-md bg-accent px-3 py-2 text-sm font-medium text-white transition duration-150 hover:opacity-90 active:scale-[.98] disabled:opacity-60"
                    >
                      {accept.isPending && <Spinner size={16} className="border-white/40 border-t-white" />}
                      {t('pageInvite.accept')}
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={switchAccount}
                    disabled={logout.isPending}
                    className="flex-1 rounded-md border border-line px-3 py-2 text-sm text-ink transition duration-150 hover:bg-hover active:scale-[.98] disabled:opacity-60"
                  >
                    {t('pageInvite.signOut')}
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
