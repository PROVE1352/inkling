import { useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { useLayout } from '../components/AppLayout'
import { Kbd, shortcutGroups } from '../components/ShortcutsModal'
import { NavButtons } from '../components/NavButtons'
import { ThemeToggle } from '../components/ThemeToggle'
import { MenuIcon } from '../components/Icons'
import { ALT, MOD, NEW_PAGE_KEY, combo, isMac, isStandalone, modKey } from '../lib/platform'
import {
  DEFAULT_PREFS,
  ZOOM_MAX,
  ZOOM_MIN,
  setPref,
  usePrefs,
  type LaunchPage,
  type NewPageLocation,
} from '../lib/prefs'
import { setTheme, useTheme, type Theme } from '../lib/theme'
import { ApiError, useAuthMode, useChangePassword, useMe, useResendVerification } from '../api'
import { IcalSettings } from '../components/IcalSettings'
import { NotificationSettings } from '../components/NotificationSettings'
import { DeletedWorkspacesList } from '../components/WorkspaceDanger'
import { LanguageSelect } from '../components/LanguageSelect'
import { useT, type TKey } from '../i18n'
import { delegatedDisplayName } from './Login'
import { Group, Row, Select, Toggle } from '../components/SettingsRows'

// Settings (/w/:wsId/settings) — grouped rows like Obsidian's settings (title/description + control on the right).
// Everything is saved on this device only (lib/prefs), except the account section. Changes apply immediately.

/** Account — email verification status and changing your own password (the only group stored on the server) */
function AccountGroup() {
  const t = useT()
  const me = useMe()
  const mode = useAuthMode()
  const change = useChangePassword()
  const resend = useResendVerification()
  const [cur, setCur] = useState('')
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null)
  const [verifyMsg, setVerifyMsg] = useState<string | null>(null)

  const user = me.data
  if (!user) return null
  const delegated = user.origin === 'delegated'
  const delegatedName = delegatedDisplayName(mode.data?.delegatedName)
  const input =
    'w-full rounded-md border border-line bg-app px-2 py-1.5 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50'

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    setMsg(null)
    if (pw.length < 8) return setMsg({ text: t('reset.newPasswordTooShort'), error: true })
    if (pw !== pw2) return setMsg({ text: t('reset.mismatch'), error: true })
    change.mutate(
      { currentPassword: cur, newPassword: pw },
      {
        onSuccess: () => {
          setCur('')
          setPw('')
          setPw2('')
          setMsg({ text: t('settings.passwordChanged') })
        },
        onError: (err) =>
          setMsg({ text: err instanceof ApiError ? err.message : t('settings.changeFailed'), error: true }),
      },
    )
  }

  return (
    <Group title={t('settings.account')}>
      <Row
        title={user.email}
        desc={
          delegated
            ? t('settings.delegatedAccount', { name: delegatedName })
            : !mode.data?.mailEnabled
              ? t('settings.mailDisabled')
              : user.emailVerified
                ? t('settings.emailVerified')
                : verifyMsg ?? t('settings.emailNotVerified')
        }
      >
        {!delegated && mode.data?.mailEnabled && !user.emailVerified && (
          <button
            type="button"
            disabled={resend.isPending}
            onClick={() =>
              resend.mutate(undefined, {
                onSuccess: (r) =>
                  setVerifyMsg(r.alreadyVerified ? t('emailVerify.already') : t('settings.verifySent')),
                onError: (err) =>
                  setVerifyMsg(err instanceof ApiError ? err.message : t('auth.mailFailed')),
              })
            }
            className="rounded-md border border-line px-2 py-1 text-xs text-ink transition-colors duration-150 hover:bg-hover disabled:opacity-50"
          >
            {t('login.resendVerify')}
          </button>
        )}
      </Row>
      <form onSubmit={submit} className="px-4 py-3">
        <div className="text-sm text-ink">{t('settings.changePassword')}</div>
        <div className="mt-0.5 text-xs leading-relaxed text-sub">
          {delegated
            ? t('settings.delegatedPassword', { name: delegatedName })
            : t('settings.changePasswordHint')}
        </div>
        <fieldset disabled={delegated || change.isPending} className="mt-3 grid gap-2 sm:grid-cols-3">
          <input
            type="password"
            value={cur}
            onChange={(e) => setCur(e.target.value)}
            placeholder={t('settings.currentPassword')}
            aria-label={t('settings.currentPassword')}
            autoComplete="current-password"
            className={input}
          />
          <input
            type="password"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            placeholder={t('settings.newPassword')}
            aria-label={t('reset.newPassword')}
            autoComplete="new-password"
            className={input}
          />
          <input
            type="password"
            value={pw2}
            onChange={(e) => setPw2(e.target.value)}
            placeholder={t('reset.confirmPassword')}
            aria-label={t('reset.confirmPassword')}
            autoComplete="new-password"
            className={input}
          />
        </fieldset>
        <div className="mt-2 flex items-center gap-3">
          <button
            type="submit"
            disabled={delegated || change.isPending || !cur || !pw}
            className="rounded-md border border-line px-3 py-1 text-xs text-ink transition-colors duration-150 hover:bg-hover disabled:opacity-40"
          >
            {t('reset.submit')}
          </button>
          {msg && (
            <span className={`text-xs ${msg.error ? 'text-red-600' : 'text-emerald-600'}`}>{msg.text}</span>
          )}
        </div>
      </form>
    </Group>
  )
}

const THEME_LABEL_KEY: Record<Theme, TKey> = { light: 'theme.light', dark: 'theme.dark', system: 'theme.system' }

export function Settings() {
  const t = useT()
  const { wsId } = useParams()
  const navigate = useNavigate()
  const { onToggleSidebar } = useLayout()
  const prefs = usePrefs()
  const { theme } = useTheme()
  const mcpUrl = `${window.location.origin}/mcp`
  const [copied, setCopied] = useState(false)

  // Came from inside the app: go to the previous screen; opened by URL: go to the workspace home (same as Admin).
  const goBack = () => {
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0
    if (idx > 0) navigate(-1)
    else navigate(wsId ? `/w/${wsId}` : '/')
  }

  const copyMcp = async () => {
    try {
      await navigator.clipboard.writeText(mcpUrl)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      // No permission — the user selects and copies it manually
    }
  }

  const zoomBtn =
    'rounded-md border border-line px-2 py-0.5 text-sm text-ink transition-colors duration-150 hover:bg-hover disabled:opacity-40'

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line pl-3 pr-14">
        <button
          type="button"
          onClick={onToggleSidebar}
          aria-label={t('settings.toggleSidebar')}
          className="rounded-md p-1.5 text-sub transition-colors duration-150 hover:bg-hover hover:text-ink"
        >
          <MenuIcon size={18} />
        </button>
        <NavButtons />
        {!isStandalone() && (
          <button
            type="button"
            onClick={goBack}
            className="rounded-md px-2 py-1 text-sm text-sub transition-colors duration-150 hover:bg-hover hover:text-ink"
          >
            ← {t('common.back')}
          </button>
        )}
        <div className="flex min-w-0 flex-1 items-center gap-1.5 text-sm font-medium text-ink">
          {t('common.settings')}
        </div>
        <ThemeToggle />
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="nd-enter mx-auto w-full max-w-2xl px-4 py-8 sm:px-6">
          <AccountGroup />
          <NotificationSettings />
          <IcalSettings />
          <DeletedWorkspacesList />

          <p className="mb-6 px-1 text-xs text-sub">
            {t('settings.deviceOnly')}
          </p>

          <Group title={t('settings.editor')}>
            <Row
              id="readableLineLength"
              title={t('settings.readableLineLength')}
              desc={t('settings.readableLineLengthDesc')}
            >
              <Toggle
                label={t('settings.readableLineLength')}
                checked={prefs.readableLineLength}
                onChange={(v) => setPref('readableLineLength', v)}
              />
            </Row>
            <Row id="spellcheck" title={t('settings.spellcheck')} desc={t('settings.spellcheckDesc')}>
              <Toggle
                label={t('settings.spellcheck')}
                checked={prefs.spellcheck}
                onChange={(v) => setPref('spellcheck', v)}
              />
            </Row>
            <Row
              id="wordCount"
              title={t('settings.wordCount')}
              desc={t('settings.wordCountDesc')}
            >
              <Toggle
                label={t('settings.wordCount')}
                checked={prefs.wordCount}
                onChange={(v) => setPref('wordCount', v)}
              />
            </Row>
          </Group>

          <Group title={t('settings.filesLinks')}>
            <Row
              id="launchPage"
              title={t('settings.launchPage')}
              desc={t('settings.launchPageDesc')}
            >
              <Select<LaunchPage>
                label={t('settings.launchPage')}
                value={prefs.launchPage}
                onChange={(v) => setPref('launchPage', v)}
                options={[
                  { value: 'last', label: t('settings.launchLast') },
                  { value: 'home', label: t('settings.launchHome') },
                ]}
              />
            </Row>
            <Row
              id="newPageLocation"
              title={t('settings.newPageLocation')}
              desc={t('settings.newPageLocationDesc', { key: NEW_PAGE_KEY })}
            >
              <Select<NewPageLocation>
                label={t('settings.newPageLocation')}
                value={prefs.newPageLocation}
                onChange={(v) => setPref('newPageLocation', v)}
                options={[
                  { value: 'root', label: t('settings.newPageRoot') },
                  { value: 'child', label: t('settings.newPageChild') },
                  { value: 'sibling', label: t('settings.newPageSibling') },
                ]}
              />
            </Row>
            <Row
              id="linkPreview"
              title={t('settings.linkPreview')}
              desc={t('settings.linkPreviewDesc')}
            >
              <Toggle
                label={t('settings.linkPreview')}
                checked={prefs.linkPreview}
                onChange={(v) => setPref('linkPreview', v)}
              />
            </Row>
          </Group>

          <Group title={t('settings.trash')}>
            <Row
              id="confirmDelete"
              title={t('settings.confirmDelete')}
              desc={t('settings.confirmDeleteDesc')}
            >
              <Toggle
                label={t('settings.confirmDelete')}
                checked={prefs.confirmDelete}
                onChange={(v) => setPref('confirmDelete', v)}
              />
            </Row>
          </Group>

          <Group title={t('settings.appearance')}>
            <Row id="language" title={t('lang.label')} desc={t('lang.description')}>
              <LanguageSelect />
            </Row>
            <Row id="zoom" title={t('settings.zoom')} desc={t('settings.zoomDesc')}>
              <button
                type="button"
                aria-label={t('settings.zoomOut')}
                disabled={prefs.zoom <= ZOOM_MIN}
                onClick={() => setPref('zoom', Math.max(ZOOM_MIN, prefs.zoom - 5))}
                className={zoomBtn}
              >
                −
              </button>
              <input
                type="range"
                min={ZOOM_MIN}
                max={ZOOM_MAX}
                step={5}
                value={prefs.zoom}
                aria-label={t('settings.zoom')}
                onChange={(e) => setPref('zoom', Number(e.target.value))}
                className="w-24 accent-[var(--color-accent)] sm:w-32"
              />
              <button
                type="button"
                aria-label={t('settings.zoomIn')}
                disabled={prefs.zoom >= ZOOM_MAX}
                onClick={() => setPref('zoom', Math.min(ZOOM_MAX, prefs.zoom + 5))}
                className={zoomBtn}
              >
                +
              </button>
              <span className="w-10 text-right text-sm tabular-nums text-ink" data-zoom-value>
                {prefs.zoom}%
              </span>
              <button
                type="button"
                onClick={() => setPref('zoom', DEFAULT_PREFS.zoom)}
                disabled={prefs.zoom === DEFAULT_PREFS.zoom}
                className="rounded-md px-2 py-0.5 text-xs text-sub transition-colors duration-150 hover:bg-hover hover:text-ink disabled:opacity-40"
              >
                {t('common.reset')}
              </button>
            </Row>
            <Row id="theme" title={t('settings.theme')} desc={t('settings.themeDesc')}>
              <Select<Theme>
                label={t('settings.theme')}
                value={theme}
                onChange={(v) => setTheme(v)}
                options={(['light', 'dark', 'system'] as Theme[]).map((th) => ({
                  value: th,
                  label: t(THEME_LABEL_KEY[th]),
                }))}
              />
            </Row>
          </Group>

          <Group title={t('settings.connections')}>
            <Row
              title={t('settings.mcpServer')}
              desc={
                <>
                  {t('settings.mcpDesc')}{' '}
                  <code className="break-all rounded bg-side px-1 py-0.5 text-[11px] text-ink">
                    {mcpUrl}
                  </code>
                </>
              }
            >
              <button
                type="button"
                onClick={copyMcp}
                className="rounded-md border border-line px-2 py-1 text-xs text-ink transition-colors duration-150 hover:bg-hover"
              >
                {copied ? t('common.copied') : t('settings.copyUrl')}
              </button>
              <button
                type="button"
                onClick={() => navigate('/settings/connections')}
                className="rounded-md border border-line px-2 py-1 text-xs text-ink transition-colors duration-150 hover:bg-hover"
              >
                {t('settings.manageConnections')}
              </button>
            </Row>
          </Group>

          <Group title={t('settings.shortcuts')}>
            <div className="px-4 py-3">
              <div className="grid gap-5 sm:grid-cols-2">
                {shortcutGroups().map((g) => (
                  <div key={g.title}>
                    <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-sub">
                      {g.title}
                    </div>
                    <div className="flex flex-col gap-1.5">
                      {g.rows.map((r) => (
                        <div
                          key={r.label}
                          className="flex items-center justify-between gap-2 text-sm"
                        >
                          <span className="min-w-0 truncate text-ink">
                            {r.label}
                            {r.hint && <span className="ml-1 text-xs text-sub">({r.hint})</span>}
                          </span>
                          <span className="flex shrink-0 items-center gap-1">
                            {r.keys.map((k) => (
                              <Kbd key={k}>{k}</Kbd>
                            ))}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
              <p className="mt-4 text-xs text-sub">
                {t('settings.shortcutsNoCustom')}{' '}
                {isMac
                  ? t('settings.shortcutsMacHint', { key: modKey('N'), alt: combo(MOD, ALT, 'N') })
                  : t('settings.shortcutsWinHint', { key: NEW_PAGE_KEY })}
              </p>
            </div>
          </Group>
        </div>
      </div>
    </div>
  )
}
