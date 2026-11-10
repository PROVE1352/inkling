import { useEffect, useState, type ReactNode } from 'react'
import { Link, Navigate, useLocation, useNavigate } from 'react-router'
import { slackLinkCodeSchema } from '@inkling/shared'
import { ApiError, useLogout, useMe } from '../api'
import { useConfirmSlackLink, useSlackLinkPreview } from '../slackApi'
import { FullScreenSpinner, Spinner } from '../components/Spinner'
import { useT } from '../i18n'

// /slack/link#code=… — links the Slack account that typed `/inkling link` to the signed-in Inkling
// account (docs/adr/1800-* .. 1806-*). The one-time code is read from the URL fragment only: a
// fragment is never sent to the server in a request line, so it stays out of access logs.
//
// Sign-in: the code is moved into this tab's sessionStorage and the fragment is dropped from the
// address bar once signed in. A signed-out visitor goes to /login?next=/slack/link (the code is not
// put into next, so it never reaches a query string or the OIDC returnTo) and finds the code again
// in sessionStorage on the way back. When storage is unavailable the page asks them to sign in and
// open the link from Slack again.

const STASH_KEY = 'inkling.slackLinkCode'
const HERE = '/slack/link'

function codeFromHash(hash: string): string | null {
  const raw = new URLSearchParams(hash.replace(/^#/, '')).get('code')
  if (!raw) return null
  const parsed = slackLinkCodeSchema.safeParse({ code: raw })
  return parsed.success ? parsed.data.code : null
}

function readStash(): string | null {
  try {
    return window.sessionStorage.getItem(STASH_KEY)
  } catch {
    return null
  }
}

function writeStash(code: string | null): boolean {
  try {
    if (code) window.sessionStorage.setItem(STASH_KEY, code)
    else window.sessionStorage.removeItem(STASH_KEY)
    return true
  } catch {
    return false
  }
}

function Card({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-full items-center justify-center bg-app px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-2">
          <img src="/icon.svg" alt="Inkling" className="h-12 w-12" />
          <h1 className="text-xl font-bold text-ink">Inkling</h1>
        </div>
        <div className="flex flex-col items-center gap-4 rounded-lg border border-line bg-app p-6 text-center">
          {children}
        </div>
      </div>
    </div>
  )
}

const secondaryBtn =
  'flex-1 rounded-md border border-line px-3 py-2 text-sm text-sub transition duration-150 hover:bg-hover hover:text-ink active:scale-[.98] disabled:opacity-60'
const primaryBtn =
  'flex flex-1 items-center justify-center gap-2 rounded-md bg-accent px-3 py-2 text-sm font-medium text-white transition duration-150 hover:opacity-90 active:scale-[.98] disabled:opacity-60'

export function SlackLink() {
  const t = useT()
  const location = useLocation()
  const navigate = useNavigate()
  const me = useMe()
  const logout = useLogout()
  const confirm = useConfirmSlackLink()

  // Read once: the fragment wins over an older stashed code.
  const [{ code, stashed }] = useState(() => {
    const fromHash = codeFromHash(window.location.hash)
    if (fromHash) return { code: fromHash, stashed: writeStash(fromHash) }
    const old = readStash()
    return { code: old, stashed: old !== null }
  })
  const [done, setDone] = useState<string | null>(null)
  const [error, setError] = useState<{ title: string; hint?: string } | null>(null)

  const signedIn = !!me.data
  const preview = useSlackLinkPreview(code, signedIn && !done)
  const previewStatus = preview.error instanceof ApiError ? preview.error.status : null

  // Signed in: drop the code from the address bar (history, Referer). Signed out, the redirect to
  // /login below replaces this entry anyway.
  useEffect(() => {
    if (signedIn && location.hash) navigate({ pathname: location.pathname, search: location.search }, { replace: true })
  }, [signedIn, location.hash, location.pathname, location.search, navigate])

  // An unknown / expired / used code is of no further use.
  useEffect(() => {
    if (previewStatus === 404) writeStash(null)
  }, [previewStatus])

  if (me.isLoading) return <FullScreenSpinner />

  const goHome = (
    <button type="button" onClick={() => navigate('/', { replace: true })} className={`${secondaryBtn} mt-1 flex-none`}>
      {t('verify.toHome')}
    </button>
  )

  if (!code && !done) {
    return (
      <Card>
        <p className="text-sm text-ink">{t('slack.linkNoCode')}</p>
        <p className="text-xs text-sub">{t('slack.linkNewHint')}</p>
        {goHome}
      </Card>
    )
  }

  if (!signedIn) {
    const login = `/login?next=${encodeURIComponent(HERE)}`
    // The code waits in sessionStorage; without storage it cannot survive the sign-in detour.
    if (stashed) return <Navigate to={login} replace />
    return (
      <Card>
        <p className="text-base font-semibold text-ink">{t('slack.linkTitle')}</p>
        <p className="text-sm text-ink">{t('slack.linkSignInFirst')}</p>
        <Link to={login} replace className={`${primaryBtn} w-full flex-none`}>
          {t('auth.signIn')}
        </Link>
      </Card>
    )
  }

  if (done) {
    return (
      <Card>
        <p className="text-base font-semibold text-ink">{t('slack.linkDone')}</p>
        <Link to={`/w/${done}`} replace className={`${primaryBtn} w-full flex-none`}>
          {t('slack.linkOpenWorkspace')}
        </Link>
      </Card>
    )
  }

  if (preview.isLoading) {
    return (
      <Card>
        <div className="py-6">
          <Spinner size={24} />
        </div>
      </Card>
    )
  }

  const inv = preview.data
  if (preview.isError || !inv) {
    const title =
      previewStatus === 404
        ? t('slack.linkExpired')
        : previewStatus === 403
          ? t('slack.linkNotMemberGeneric')
          : preview.error instanceof ApiError
            ? preview.error.message
            : t('slack.linkFailed')
    const hint = previewStatus === 403 ? t('slack.linkNotMemberHint') : t('slack.linkNewHint')
    return (
      <Card>
        <p className="text-sm text-ink">{title}</p>
        <p className="text-xs text-sub">{hint}</p>
        {goHome}
      </Card>
    )
  }

  const submit = () => {
    setError(null)
    confirm.mutate(code!, {
      onSuccess: (r) => {
        writeStash(null)
        setDone(r.workspaceId)
      },
      onError: (err) => {
        if (err instanceof ApiError && err.status === 403) {
          setError({ title: t('slack.linkNotMember', { workspace: inv.workspaceName }), hint: t('slack.linkNotMemberHint') })
        } else if (err instanceof ApiError && err.status === 404) {
          writeStash(null)
          setError({ title: t('slack.linkExpired'), hint: t('slack.linkNewHint') })
        } else {
          setError({ title: err instanceof ApiError ? err.message : t('slack.linkFailed') })
        }
      },
    })
  }
  const cancel = () => {
    writeStash(null)
    navigate('/', { replace: true })
  }
  const switchAccount = () =>
    logout.mutate(undefined, {
      onSettled: () => navigate(`/login?next=${encodeURIComponent(HERE)}`, { replace: true }),
    })

  return (
    <Card>
      <p className="text-base font-semibold text-ink">{t('slack.linkTitle')}</p>
      <p className="text-sm text-ink">
        {t('slack.linkBody', {
          slackUser: inv.slackUserId,
          team: inv.teamName ?? 'Slack',
          workspace: inv.workspaceName,
        })}
      </p>
      <p className="text-xs text-sub">{t('slack.linkSignedInAs', { email: me.data!.email })}</p>
      {error && (
        <div role="alert" className="flex flex-col gap-1">
          <p className="text-xs text-red-600">{error.title}</p>
          {error.hint && <p className="text-xs text-sub">{error.hint}</p>}
        </div>
      )}
      <div className="mt-1 flex w-full gap-2">
        <button type="button" onClick={cancel} disabled={confirm.isPending} className={secondaryBtn}>
          {t('common.cancel')}
        </button>
        <button type="button" onClick={submit} disabled={confirm.isPending} className={primaryBtn}>
          {confirm.isPending && <Spinner size={16} className="border-white/40 border-t-white" />}
          {t('slack.linkConfirm')}
        </button>
      </div>
      <button
        type="button"
        onClick={switchAccount}
        disabled={logout.isPending || confirm.isPending}
        className="text-xs text-sub underline-offset-2 hover:text-ink hover:underline disabled:opacity-60"
      >
        {t('slack.linkOtherAccount')}
      </button>
    </Card>
  )
}
