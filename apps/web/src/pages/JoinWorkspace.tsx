import { useState } from 'react'
import { WorkspaceAvatar } from '../components/WorkspaceAvatar'
import { Navigate, useNavigate, useParams } from 'react-router'
import {
  ApiError,
  useInvitePreview,
  useJoinWorkspace,
  useMe,
} from '../api'
import { FullScreenSpinner, Spinner } from '../components/Spinner'
import { useT } from '../i18n'

// /join/:code — outside RequireAuth. Signed-out visitors go to /login carrying next.
export function JoinWorkspace() {
  const t = useT()
  const { code = '' } = useParams()
  const navigate = useNavigate()
  const me = useMe()
  const preview = useInvitePreview(me.data ? code : '')
  const join = useJoinWorkspace()
  const [error, setError] = useState<string | null>(null)

  if (me.isLoading) return <FullScreenSpinner />
  // Attach next so sign-in returns to this link.
  if (me.isError || !me.data) {
    return <Navigate to={`/login?next=${encodeURIComponent(`/join/${code}`)}`} replace />
  }

  const submit = () => {
    setError(null)
    join.mutate(
      { inviteCode: code },
      {
        onSuccess: (ws) => navigate(`/w/${ws.id}`, { replace: true }),
        onError: (err) => {
          if (err instanceof ApiError && err.code === 'INVALID_CODE') {
            setError(t('join.invalidLink'))
          } else {
            setError(err instanceof ApiError ? err.message : t('join.failed'))
          }
        },
      },
    )
  }

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
          ) : preview.isError || !preview.data ? (
            <>
              <p className="text-sm text-ink">{t('join.invalidLink')}</p>
              <p className="text-xs text-sub">
                {t('join.invalidLinkHint')}
              </p>
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
              <WorkspaceAvatar name={preview.data.name} icon={preview.data.icon} size={48} />
              <div className="flex flex-col gap-1">
                <p className="text-base font-semibold text-ink">
                  {preview.data.name}
                </p>
                <p className="text-xs text-sub">{t('join.members', { count: preview.data.memberCount })}</p>
              </div>
              <p className="text-sm text-sub">{t('join.confirm')}</p>
              {error && <p className="text-xs text-red-600">{error}</p>}
              <div className="mt-1 flex w-full gap-2">
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
                  disabled={join.isPending}
                  className="flex flex-1 items-center justify-center gap-2 rounded-md bg-accent px-3 py-2 text-sm font-medium text-white transition duration-150 hover:opacity-90 active:scale-[.98] disabled:opacity-60"
                >
                  {join.isPending && (
                    <Spinner size={16} className="border-white/40 border-t-white" />
                  )}
                  {t('join.submit')}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
