import { useState } from 'react'
import { Navigate, useLocation, useSearchParams } from 'react-router'
import { ApiError, useMe, useOAuthAuthorize, useOAuthClientInfo } from '../api'
import { FullScreenSpinner, Spinner } from '../components/Spinner'
import { useT } from '../i18n'

/**
 * OAuth consent screen for MCP connectors (/oauth/authorize).
 * Claude Code, claude.ai and others open this URL in the browser. If not signed in, the user goes
 * through the normal sign-in screen (?next=original path+query) and comes back; the allow/deny decision
 * is sent to the server, and the browser then goes to the app callback URL the server validated and
 * returned. A wrong client_id/redirect_uri shows an error and never redirects.
 */
export function OAuthAuthorize() {
  const t = useT()
  const [params] = useSearchParams()
  const location = useLocation()
  const me = useMe()
  const clientId = params.get('client_id') ?? ''
  const redirectUri = params.get('redirect_uri') ?? ''
  const info = useOAuthClientInfo(clientId, redirectUri, !!me.data, params.get('scope') ?? '')
  const authorize = useOAuthAuthorize()
  const [leaving, setLeaving] = useState<'allow' | 'deny' | null>(null)
  // Access choice (docs/adr/0935-*): null = follow the request (read+write unless the client asked
  // for read only). A read-only request cannot be widened here; the server enforces that too.
  const [accessChoice, setAccessChoice] = useState<'read' | 'write' | null>(null)
  const readOnlyRequested = info.data?.requestedAccess === 'read'
  const access: 'read' | 'write' = readOnlyRequested ? 'read' : (accessChoice ?? 'write')
  // Loopback callbacks (CLIs such as Codex, Claude Code) show instructions instead of redirecting right
  // away — if the CLI runs on a remote server over SSH, nothing listens on the browser's 127.0.0.1 and
  // the redirect ends in "can't connect".
  const [loopbackUrl, setLoopbackUrl] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  if (me.isLoading) return <FullScreenSpinner />
  if (!me.data) {
    const next = `${location.pathname}${location.search}`
    return <Navigate to={`/login?next=${encodeURIComponent(next)}`} replace />
  }

  const decide = (decision: 'allow' | 'deny') => {
    authorize.mutate(
      {
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: params.get('response_type') ?? undefined,
        code_challenge: params.get('code_challenge') ?? undefined,
        code_challenge_method: params.get('code_challenge_method') ?? undefined,
        state: params.get('state') ?? undefined,
        scope: params.get('scope') ?? undefined,
        resource: params.get('resource') ?? undefined,
        decision,
        access,
      },
      {
        onSuccess: ({ redirectTo }) => {
          setLeaving(decision)
          if (decision === 'allow' && isLoopback(redirectTo)) {
            setLoopbackUrl(redirectTo)
            return
          }
          window.location.assign(redirectTo)
        },
      },
    )
  }

  let body: React.ReactNode
  if (!clientId || !redirectUri) {
    body = <p className="text-sm text-red-600">{t('oauth.badRequest')}</p>
  } else if (info.isLoading) {
    body = (
      <div className="flex justify-center py-6">
        <Spinner size={20} />
      </div>
    )
  } else if (info.isError || !info.data) {
    body = (
      <p className="text-sm text-red-600">
        {info.error instanceof ApiError ? info.error.message : t('oauth.checkFailed')}
      </p>
    )
  } else if (loopbackUrl) {
    const cmd = `curl -s '${loopbackUrl.replace(/'/g, "'\\''")}'`
    body = (
      <>
        <p className="text-sm text-ink">{t('oauth.allowedPick')}</p>
        <a
          href={loopbackUrl}
          className="rounded-md bg-accent px-3 py-2 text-center text-sm font-medium text-white hover:opacity-90"
        >
          {t('oauth.backToLocalApp')}
        </a>
        <div className="flex flex-col gap-1.5">
          <p className="text-xs text-sub">
            {withBold(t('oauth.sshHint'))}
          </p>
          <code className="block break-all rounded-md border border-line bg-hover px-2 py-1.5 text-[11px] text-ink">
            {cmd}
          </code>
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard?.writeText(cmd).then(() => setCopied(true))
            }}
            className="rounded-md border border-line px-3 py-1.5 text-xs text-ink hover:bg-hover"
          >
            {copied ? t('common.copied') : t('oauth.copyCommand')}
          </button>
        </div>
      </>
    )
  } else if (leaving) {
    body = (
      <p className="text-sm text-sub">
        {leaving === 'allow' ? t('oauth.connected') : t('oauth.denied')} {t('oauth.returning')}
      </p>
    )
  } else {
    const name = info.data.client.name
    body = (
      <>
        <p className="text-sm text-ink">
          <strong className="font-semibold">{name}</strong>
          {t('oauth.requestSuffix')}
        </p>
        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1 text-xs font-medium text-ink">{t('oauth.accessLabel')}</legend>
          {(['write', 'read'] as const).map((opt) => (
            <label
              key={opt}
              className={`flex cursor-pointer items-start gap-2 rounded-md border px-2.5 py-2 text-xs ${
                access === opt ? 'border-accent' : 'border-line'
              } ${opt === 'write' && readOnlyRequested ? 'cursor-not-allowed opacity-50' : ''}`}
            >
              <input
                type="radio"
                name="oauth-access"
                className="mt-0.5"
                checked={access === opt}
                disabled={opt === 'write' && readOnlyRequested}
                onChange={() => setAccessChoice(opt)}
              />
              <span className="flex flex-col">
                <span className="font-medium text-ink">
                  {opt === 'write' ? t('oauth.accessWrite') : t('oauth.accessRead')}
                </span>
                <span className="text-sub">
                  {opt === 'write' ? t('oauth.accessWriteHint') : t('oauth.accessReadHint')}
                </span>
              </span>
            </label>
          ))}
          {readOnlyRequested && <p className="text-xs text-sub">{t('oauth.accessReadRequested')}</p>}
        </fieldset>
        <ul className="list-disc space-y-1 pl-5 text-xs text-sub">
          <li>{access === 'write' ? t('oauth.scopeRead') : t('oauth.scopeReadOnly')}</li>
          <li>{t('oauth.scopePrivate')}</li>
          {access === 'write' && <li>{t('oauth.scopeTrash')}</li>}
          <li>{t('oauth.scopeRevoke')}</li>
        </ul>
        <p className="text-xs text-sub">
          {t('oauth.account', { name: me.data.name, email: me.data.email, host: info.data.redirectHost })}
        </p>
        {authorize.isError && (
          <p className="text-xs text-red-600">
            {authorize.error instanceof ApiError ? authorize.error.message : t('oauth.failed')}
          </p>
        )}
        <div className="mt-1 flex gap-2">
          <button
            type="button"
            onClick={() => decide('deny')}
            disabled={authorize.isPending}
            className="flex-1 rounded-md border border-line px-3 py-2 text-sm text-ink transition-colors duration-150 hover:bg-hover disabled:opacity-60"
          >
            {t('oauth.deny')}
          </button>
          <button
            type="button"
            onClick={() => decide('allow')}
            disabled={authorize.isPending}
            className="flex flex-1 items-center justify-center gap-2 rounded-md bg-accent px-3 py-2 text-sm font-medium text-white transition-colors duration-150 hover:opacity-90 disabled:opacity-60"
          >
            {authorize.isPending && <Spinner size={16} className="border-white/40 border-t-white" />}
            {t('oauth.allow')}
          </button>
        </div>
      </>
    )
  }

  return (
    <div className="flex min-h-full items-center justify-center bg-app px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-2">
          <img src="/icon.svg" alt="Inkling" className="h-12 w-12" />
          <h1 className="text-xl font-bold text-ink">{t('oauth.title')}</h1>
        </div>
        <div className="flex flex-col gap-3 rounded-lg border border-line bg-app p-6">{body}</div>
      </div>
    </div>
  )
}

/** Renders `**text**` segments of a translated string in bold. */
function withBold(s: string): React.ReactNode {
  return s.split('**').map((part, i) => (i % 2 ? <strong key={i}>{part}</strong> : part))
}

function isLoopback(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)
  } catch {
    return false
  }
}
