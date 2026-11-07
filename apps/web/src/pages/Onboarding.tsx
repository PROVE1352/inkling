import { useState } from 'react'
import { useNavigate } from 'react-router'
import {
  createWorkspaceSchema,
  joinWorkspaceSchema,
} from '@inkling/shared'
import {
  ApiError,
  useCreateWorkspace,
  useJoinWorkspace,
  useLogout,
} from '../api'
import { Spinner } from '../components/Spinner'
import { DeletedWorkspacesList } from '../components/WorkspaceDanger'
import { useT } from '../i18n'

// With zero workspaces: create or join the first one.
export function Onboarding() {
  const t = useT()
  const navigate = useNavigate()
  const logout = useLogout()

  const create = useCreateWorkspace()
  const join = useJoinWorkspace()

  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const [nameError, setNameError] = useState<string | null>(null)
  const [codeError, setCodeError] = useState<string | null>(null)

  const submitCreate = (e: React.FormEvent) => {
    e.preventDefault()
    setNameError(null)
    const parsed = createWorkspaceSchema.safeParse({ name })
    if (!parsed.success) {
      setNameError(t('onboarding.nameRequired'))
      return
    }
    create.mutate(parsed.data, {
      onSuccess: (ws) => navigate(`/w/${ws.id}`, { replace: true }),
      onError: (err) =>
        setNameError(err instanceof ApiError ? err.message : t('onboarding.createFailed')),
    })
  }

  const submitJoin = (e: React.FormEvent) => {
    e.preventDefault()
    setCodeError(null)
    const parsed = joinWorkspaceSchema.safeParse({ inviteCode: code })
    if (!parsed.success) {
      setCodeError(t('onboarding.codeRequired'))
      return
    }
    join.mutate(parsed.data, {
      onSuccess: (ws) => navigate(`/w/${ws.id}`, { replace: true }),
      onError: (err) => {
        if (err instanceof ApiError && err.code === 'INVALID_CODE') {
          setCodeError(t('onboarding.invalidCode'))
        } else {
          setCodeError(err instanceof ApiError ? err.message : t('join.failed'))
        }
      },
    })
  }

  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-6 bg-app px-4 py-12">
      <div className="flex flex-col items-center gap-2">
        <img src="/icon.svg" alt="Inkling" className="h-12 w-12" />
        <h1 className="text-xl font-bold text-ink">{t('onboarding.title')}</h1>
        <p className="text-sm text-sub">{t('onboarding.subtitle')}</p>
      </div>

      <div className="grid w-full max-w-2xl gap-4 sm:grid-cols-2">
        <form
          onSubmit={submitCreate}
          className="flex flex-col gap-3 rounded-lg border border-line bg-app p-6"
        >
          <h2 className="text-sm font-semibold text-ink">{t('onboarding.createTitle')}</h2>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('onboarding.namePlaceholder')}
            className="rounded-md border border-line bg-app px-3 py-2 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          />
          {nameError && <p className="text-xs text-red-600">{nameError}</p>}
          <button
            type="submit"
            disabled={create.isPending}
            className="flex items-center justify-center gap-2 rounded-md bg-accent px-3 py-2 text-sm font-medium text-white transition-colors duration-150 hover:opacity-90 disabled:opacity-60"
          >
            {create.isPending && (
              <Spinner size={16} className="border-white/40 border-t-white" />
            )}
            {t('common.create')}
          </button>
        </form>

        <form
          onSubmit={submitJoin}
          className="flex flex-col gap-3 rounded-lg border border-line bg-app p-6"
        >
          <h2 className="text-sm font-semibold text-ink">{t('onboarding.joinTitle')}</h2>
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder={t('onboarding.codePlaceholder')}
            className="rounded-md border border-line bg-app px-3 py-2 text-sm uppercase tracking-wider text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          />
          {codeError && <p className="text-xs text-red-600">{codeError}</p>}
          <button
            type="submit"
            disabled={join.isPending}
            className="flex items-center justify-center gap-2 rounded-md border border-line px-3 py-2 text-sm font-medium text-ink transition-colors duration-150 hover:bg-hover disabled:opacity-60"
          >
            {join.isPending && <Spinner size={16} />}
            {t('join.submit')}
          </button>
        </form>
      </div>

      {/* Owners who deleted their last workspace can bring it back from here (docs/adr/0910-*). */}
      <DeletedWorkspacesList compact />

      <button
        type="button"
        onClick={() => logout.mutate(undefined, { onSuccess: () => navigate('/login') })}
        className="text-xs text-sub hover:text-ink hover:underline"
      >
        {t('onboarding.logout')}
      </button>
    </div>
  )
}
