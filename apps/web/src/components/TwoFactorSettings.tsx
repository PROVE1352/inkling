import { useState } from 'react'
import {
  ApiError,
  useAuthMode,
  useMe,
  useTwoFactorDisable,
  useTwoFactorEnable,
  useTwoFactorRecoveryCodes,
  useTwoFactorSetup,
  useTwoFactorState,
} from '../api'
import { useT } from '../i18n'
import { delegatedDisplayName } from '../pages/Login'
import { Group, Row } from './SettingsRows'

// Settings → Two-step verification (TOTP, docs/adr/1061-*). Setup shows the key and the otpauth://
// link as text (no QR library in the bundle); the app's code confirms it, then ten recovery codes
// are shown once. Turning off or replacing the recovery codes asks for the password and a code.

type Mode =
  | { kind: 'idle' }
  | { kind: 'password' }
  | { kind: 'scan'; secret: string; uri: string }
  | { kind: 'codes'; codes: string[] }
  | { kind: 'manage'; action: 'disable' | 'regenerate' }

const input =
  'w-full rounded-md border border-line bg-app px-2 py-1.5 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50'
const btn =
  'rounded-md border border-line px-2 py-1 text-xs text-ink transition-colors duration-150 hover:bg-hover disabled:opacity-40'
const primary =
  'rounded-md bg-accent px-3 py-1 text-xs font-medium text-white transition-colors duration-150 hover:opacity-90 disabled:opacity-50'

function CopyButton({ text }: { text: string }) {
  const t = useT()
  const [done, setDone] = useState(false)
  return (
    <button
      type="button"
      className={btn}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text)
          setDone(true)
          window.setTimeout(() => setDone(false), 1500)
        } catch {
          // No clipboard permission: the text is selectable.
        }
      }}
    >
      {done ? t('twofa.copied') : t('twofa.copy')}
    </button>
  )
}

export function TwoFactorSettings() {
  const t = useT()
  const me = useMe()
  const mode = useAuthMode()
  const local = me.data?.origin !== 'delegated'
  const state = useTwoFactorState(!!me.data && local)
  const setup = useTwoFactorSetup()
  const enable = useTwoFactorEnable()
  const disable = useTwoFactorDisable()
  const regenerate = useTwoFactorRecoveryCodes()

  const [m, setM] = useState<Mode>({ kind: 'idle' })
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null)

  if (!me.data) return null
  const s = state.data
  const reset = (next: Mode = { kind: 'idle' }) => {
    setM(next)
    setPassword('')
    setCode('')
  }
  const fail = (err: unknown) =>
    setMsg({ text: err instanceof ApiError ? err.message : t('twofa.failed'), error: true })

  const desc = !local
    ? t('twofa.delegated', { name: delegatedDisplayName(mode.data?.delegatedName) })
    : s?.enabled
      ? t('twofa.descOn', { count: s.recoveryCodesLeft })
      : s && !s.available
        ? t('twofa.unavailable')
        : t('twofa.descOff')

  const busy = setup.isPending || enable.isPending || disable.isPending || regenerate.isPending

  return (
    <Group title={t('twofa.title')}>
      <Row title={t('twofa.title')} desc={desc}>
        {local && s && m.kind === 'idle' && !s.enabled && s.available && (
          <button
            type="button"
            className={btn}
            onClick={() => {
              setMsg(null)
              reset({ kind: 'password' })
            }}
          >
            {t('twofa.turnOn')}
          </button>
        )}
        {local && s?.enabled && m.kind === 'idle' && (
          <>
            <button
              type="button"
              className={btn}
              onClick={() => {
                setMsg(null)
                reset({ kind: 'manage', action: 'regenerate' })
              }}
            >
              {t('twofa.newRecoveryCodes')}
            </button>
            <button
              type="button"
              className={btn}
              onClick={() => {
                setMsg(null)
                reset({ kind: 'manage', action: 'disable' })
              }}
            >
              {t('twofa.turnOff')}
            </button>
          </>
        )}
      </Row>

      {m.kind === 'password' && (
        <form
          className="px-4 py-3"
          onSubmit={(e) => {
            e.preventDefault()
            setMsg(null)
            setup.mutate(password, {
              onSuccess: (r) => reset({ kind: 'scan', secret: r.secret, uri: r.uri }),
              onError: fail,
            })
          }}
        >
          <div className="text-xs text-sub">{t('twofa.passwordPrompt')}</div>
          <div className="mt-2 flex flex-col gap-2 sm:flex-row">
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={t('settings.currentPassword')}
              aria-label={t('settings.currentPassword')}
              autoComplete="current-password"
              autoFocus
              className={input}
            />
            <div className="flex shrink-0 gap-2">
              <button type="submit" className={primary} disabled={busy || !password}>
                {t('twofa.continue')}
              </button>
              <button type="button" className={btn} onClick={() => reset()}>
                {t('twofa.cancel')}
              </button>
            </div>
          </div>
        </form>
      )}

      {m.kind === 'scan' && (
        <form
          className="flex flex-col gap-3 px-4 py-3"
          onSubmit={(e) => {
            e.preventDefault()
            setMsg(null)
            enable.mutate(code.trim(), {
              onSuccess: (r) => {
                reset({ kind: 'codes', codes: r.recoveryCodes })
                setMsg({ text: t('twofa.turnedOn') })
              },
              onError: (err) => {
                setCode('')
                fail(err)
              },
            })
          }}
        >
          <p className="text-xs leading-relaxed text-sub">{t('twofa.step1')}</p>
          <div>
            <div className="mb-1 text-[11px] font-medium text-sub">{t('twofa.secretLabel')}</div>
            <div className="flex items-center gap-2">
              <code
                className="min-w-0 flex-1 select-all break-all rounded bg-side px-2 py-1.5 font-mono text-sm tracking-wider text-ink"
                data-testid="totp-secret"
              >
                {m.secret.replace(/(.{4})/g, '$1 ').trim()}
              </code>
              <CopyButton text={m.secret} />
            </div>
          </div>
          <div>
            <div className="mb-1 text-[11px] font-medium text-sub">{t('twofa.uriLabel')}</div>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 select-all break-all rounded bg-side px-2 py-1.5 font-mono text-[11px] text-ink">
                {m.uri}
              </code>
              <CopyButton text={m.uri} />
            </div>
          </div>
          <p className="text-xs leading-relaxed text-sub">{t('twofa.step2')}</p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="123456"
              aria-label={t('twofa.codeLabel')}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              className={`${input} font-mono tracking-[0.3em] sm:max-w-[10rem]`}
            />
            <div className="flex shrink-0 gap-2">
              <button type="submit" className={primary} disabled={busy || code.trim().length !== 6}>
                {t('twofa.enable')}
              </button>
              <button type="button" className={btn} onClick={() => reset()}>
                {t('twofa.cancel')}
              </button>
            </div>
          </div>
        </form>
      )}

      {m.kind === 'codes' && (
        <div className="px-4 py-3">
          <div className="text-sm text-ink">{t('twofa.recoveryTitle')}</div>
          <p className="mt-0.5 text-xs leading-relaxed text-sub">{t('twofa.recoveryDesc')}</p>
          <ul
            className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 rounded-md bg-side px-3 py-2 font-mono text-sm text-ink"
            data-testid="recovery-codes"
          >
            {m.codes.map((c) => (
              <li key={c} className="select-all">
                {c}
              </li>
            ))}
          </ul>
          <div className="mt-3 flex gap-2">
            <CopyButton text={m.codes.join('\n')} />
            <button type="button" className={primary} onClick={() => reset()}>
              {t('twofa.recoveryDone')}
            </button>
          </div>
        </div>
      )}

      {m.kind === 'manage' && (
        <form
          className="px-4 py-3"
          onSubmit={(e) => {
            e.preventDefault()
            setMsg(null)
            const body = { password, code: code.trim() }
            if (m.action === 'disable') {
              disable.mutate(body, {
                onSuccess: () => {
                  reset()
                  setMsg({ text: t('twofa.turnedOff') })
                },
                onError: fail,
              })
            } else {
              regenerate.mutate(body, {
                onSuccess: (r) => reset({ kind: 'codes', codes: r.recoveryCodes }),
                onError: fail,
              })
            }
          }}
        >
          <div className="text-xs text-sub">{t('twofa.manageDesc')}</div>
          <div className="mt-2 grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={t('settings.currentPassword')}
              aria-label={t('settings.currentPassword')}
              autoComplete="current-password"
              autoFocus
              className={input}
            />
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder={t('twofa.codeOrRecovery')}
              aria-label={t('twofa.codeOrRecovery')}
              autoComplete="one-time-code"
              className={`${input} font-mono`}
            />
            <div className="flex gap-2">
              <button type="submit" className={primary} disabled={busy || !password || !code.trim()}>
                {m.action === 'disable' ? t('twofa.turnOff') : t('twofa.newRecoveryCodes')}
              </button>
              <button type="button" className={btn} onClick={() => reset()}>
                {t('twofa.cancel')}
              </button>
            </div>
          </div>
        </form>
      )}

      {msg && (
        <div className={`px-4 py-2 text-xs ${msg.error ? 'text-red-600' : 'text-emerald-600'}`}>{msg.text}</div>
      )}
    </Group>
  )
}
