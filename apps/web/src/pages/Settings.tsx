import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router'
import { useLayout } from '../components/AppLayout'
import { ShortcutSettings } from '../components/ShortcutSettings'
import { NavButtons } from '../components/NavButtons'
import { ThemeToggle } from '../components/ThemeToggle'
import {
  BellIcon,
  ChevronRightIcon,
  ContrastIcon,
  EditIcon,
  ExternalLinkIcon,
  FileTextIcon,
  InfoIcon,
  KeyboardIcon,
  LockIcon,
  MenuIcon,
  PanelLeftIcon,
  PlugIcon,
  RestoreIcon,
  UserIcon,
} from '../components/Icons'
import { isMac, isStandalone } from '../lib/platform'
import { PLATFORM, shortcutLabel } from '../lib/shortcuts'
import { formatKey } from '../lib/shortcuts/keys'
import {
  DEFAULT_PREFS,
  LINE_WIDTH_DEFAULT,
  LINE_WIDTH_FULL,
  LINE_WIDTH_MAX,
  LINE_WIDTH_MIN,
  ZOOM_MAX,
  ZOOM_MIN,
  setPref,
  usePrefs,
  type LaunchPage,
  type NewPageLocation,
} from '../lib/prefs'
import { setTheme, useTheme, type Theme } from '../lib/theme'
import { ApiError, useAuthMode, useChangePassword, useMe, useOidcLink, useResendVerification } from '../api'
import { IcalSettings } from '../components/IcalSettings'
import { TwoFactorSettings } from '../components/TwoFactorSettings'
import { NotificationSettings } from '../components/NotificationSettings'
import { SidebarSettings } from '../components/SidebarSettings'
import { VersionInfo } from '../components/VersionInfo'
import { DeletedWorkspacesList } from '../components/WorkspaceDanger'
import { LanguageSelect } from '../components/LanguageSelect'
import { getLocale, useT, type TKey } from '../i18n'
import { delegatedDisplayName, oidcErrorText } from './Login'
import { Group, Row, Select, SettingsFlat, Toggle } from '../components/SettingsRows'
import { StatusRow } from '../components/MemberStatus'

// Settings (/w/:wsId/settings): Obsidian-style, a list of sections on the left and the chosen section on
// the right (on a phone the list is its own screen and a section opens over it). The section lives in the
// URL hash (#account, #sidebar…) so links such as the sidebar's "Customize sidebar…" open it directly.
// Rows saved in this browser only (lib/prefs) carry a "This device" tag; everything else is on the account.
// Changes apply immediately.

const REPO_URL = 'https://github.com/PROVE1352/inkling'

const SECTION_IDS = [
  'account',
  'security',
  'notifications',
  'editor',
  'sidebar',
  'files',
  'appearance',
  'connections',
  'shortcuts',
  'about',
] as const
type SectionId = (typeof SECTION_IDS)[number]
const isSectionId = (v: string): v is SectionId => (SECTION_IDS as readonly string[]).includes(v)

const SECTIONS: Record<SectionId, { label: TKey; icon: (size: number) => ReactNode }> = {
  account: { label: 'settings.account', icon: (s) => <UserIcon size={s} /> },
  security: { label: 'settings.security', icon: (s) => <LockIcon size={s} /> },
  notifications: { label: 'notifSettings.title', icon: (s) => <BellIcon size={s} /> },
  editor: { label: 'settings.editor', icon: (s) => <EditIcon size={s} /> },
  sidebar: { label: 'sidebarSettings.title', icon: (s) => <PanelLeftIcon size={s} /> },
  files: { label: 'settings.filesLinks', icon: (s) => <FileTextIcon size={s} /> },
  appearance: { label: 'settings.appearance', icon: (s) => <ContrastIcon size={s} /> },
  connections: { label: 'settings.connections', icon: (s) => <PlugIcon size={s} /> },
  shortcuts: { label: 'settings.shortcuts', icon: (s) => <KeyboardIcon size={s} /> },
  about: { label: 'settings.about', icon: (s) => <InfoIcon size={s} /> },
}

/** Same breakpoint as Tailwind's `sm`: at and above it the list and the section sit side by side. */
const WIDE_QUERY = '(min-width: 640px)'
function useWide(): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mq = window.matchMedia(WIDE_QUERY)
      mq.addEventListener('change', cb)
      return () => mq.removeEventListener('change', cb)
    },
    () => window.matchMedia(WIDE_QUERY).matches,
    () => true,
  )
}

const btn =
  'rounded-md border border-line px-2 py-1 text-xs text-ink transition-colors duration-150 hover:bg-hover disabled:opacity-40'
const iconBtn =
  'flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-sub transition-colors duration-150 hover:bg-hover hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:invisible'
const slider = 'min-w-0 flex-1 accent-[var(--color-accent)] disabled:opacity-40 sm:w-40 sm:flex-none'

/** Account: email verification status and changing your own password. */
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
  // Accounts whose password lives elsewhere: delegated sign-in, or created by OpenID Connect sign-in.
  // Same rule for both: no password fields here, just where to go (docs/adr/1161-*).
  const delegated = user.origin === 'delegated' || user.origin === 'oidc'
  const delegatedName =
    user.origin === 'oidc'
      ? (mode.data?.oidc?.name ?? user.logins?.[0]?.name ?? 'SSO')
      : delegatedDisplayName(mode.data?.delegatedName)
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
            className={btn}
          >
            {t('login.resendVerify')}
          </button>
        )}
      </Row>
      {/* status message for the people in my workspaces (docs/adr/1845-*) */}
      <StatusRow />
      {delegated ? (
        // The password belongs to the external service: nothing to fill in here, just where to go.
        <Row title={t('settings.changePassword')} desc={t('settings.delegatedPassword', { name: delegatedName })} />
      ) : (
        <form onSubmit={submit} className="px-4 py-3">
          <div className="text-sm text-ink">{t('settings.changePassword')}</div>
          <div className="mt-0.5 text-xs leading-relaxed text-sub">{t('settings.changePasswordHint')}</div>
          <fieldset disabled={change.isPending} className="mt-3 grid gap-2 sm:grid-cols-3">
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
          <div className="mt-2 flex items-center justify-end gap-3">
            {msg && (
              <span className={`mr-auto text-xs ${msg.error ? 'text-red-600' : 'text-emerald-600'}`}>{msg.text}</span>
            )}
            <button type="submit" disabled={change.isPending || !cur || !pw} className={btn}>
              {t('reset.submit')}
            </button>
          </div>
        </form>
      )}
      <LinkedLogins />
    </Group>
  )
}

/**
 * Settings › Account › Sign-in methods: OpenID Connect identities linked to this account, and
 * "Connect <name>" for a local account that has none yet (docs/adr/1161-*). There is no disconnect:
 * an account created by the provider would be left without any way to sign in.
 */
function LinkedLogins() {
  const t = useT()
  const me = useMe()
  const mode = useAuthMode()
  const link = useOidcLink()
  const location = useLocation()
  const navigate = useNavigate()
  const [error, setError] = useState<string | null>(null)
  const oidcName = mode.data?.oidc?.name ?? null

  // A failed connect comes back as ?oidc_error=CODE on this page: show it once, then drop it from the URL.
  useEffect(() => {
    const code = new URLSearchParams(location.search).get('oidc_error')
    if (!code) return
    setError(oidcErrorText(code, oidcName ?? 'SSO'))
    const q = new URLSearchParams(location.search)
    q.delete('oidc_error')
    const rest = q.toString()
    navigate({ pathname: location.pathname, search: rest ? `?${rest}` : '', hash: location.hash }, { replace: true })
  }, [location.search, location.pathname, location.hash, navigate, oidcName])

  const user = me.data
  if (!user) return null
  const logins = user.logins ?? []
  const canConnect = !!oidcName && user.origin === 'local' && !logins.some((l) => l.name === oidcName)
  if (logins.length === 0 && !canConnect) return null

  const connect = () => {
    setError(null)
    link.mutate(`${location.pathname}${location.search}#account`, {
      onSuccess: (r) => window.location.assign(r.url),
      onError: (err) =>
        setError(err instanceof ApiError ? oidcErrorText(err.code, oidcName ?? 'SSO') : t('oidc.error.unknown', { name: oidcName ?? 'SSO' })),
    })
  }

  return (
    <>
      {logins.map((l) => (
        <Row
          key={`${l.name}:${l.linkedAt}`}
          title={l.email ? `${l.name} · ${l.email}` : l.name}
          desc={t('settings.loginLinked', { date: new Date(l.linkedAt).toLocaleDateString(getLocale()) })}
        />
      ))}
      {canConnect && (
        <Row
          title={logins.length === 0 ? t('settings.logins') : t('settings.loginConnect', { name: oidcName })}
          desc={error ?? (logins.length === 0 ? t('settings.loginConnectHint', { name: oidcName }) : undefined)}
        >
          <button type="button" className={btn} disabled={link.isPending} onClick={connect}>
            {t('settings.loginConnect', { name: oidcName })}
          </button>
        </Row>
      )}
      {!canConnect && error && <Row title={t('settings.logins')} desc={error} />}
    </>
  )
}

/** Slider + value + a small reset icon: the same shape for line width and zoom. */
function RangeControl({
  label,
  value,
  min,
  max,
  step,
  display,
  onChange,
  disabled,
  resetLabel,
  onReset,
  canReset,
  valueAttr,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  display: string
  onChange: (v: number) => void
  disabled?: boolean
  resetLabel: string
  onReset: () => void
  canReset: boolean
  valueAttr: Record<string, string>
}) {
  return (
    <>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-label={label}
        aria-valuetext={display}
        onChange={(e) => onChange(Number(e.target.value))}
        className={slider}
      />
      <span className="w-14 text-right text-sm tabular-nums text-ink" {...valueAttr}>
        {display}
      </span>
      <button
        type="button"
        onClick={onReset}
        disabled={!canReset}
        aria-label={resetLabel}
        title={resetLabel}
        className={iconBtn}
      >
        <RestoreIcon size={14} />
      </button>
    </>
  )
}

const THEME_LABEL_KEY: Record<Theme, TKey> = { light: 'theme.light', dark: 'theme.dark', system: 'theme.system' }

function EditorSection() {
  const t = useT()
  const prefs = usePrefs()
  const full = prefs.lineWidth === LINE_WIDTH_FULL
  return (
    <Group title={t('settings.editor')}>
      <Row id="lineWidth" title={t('settings.lineWidth')} desc={t('settings.lineWidthDesc')} deviceOnly stack>
        <RangeControl
          label={t('settings.lineWidth')}
          value={full ? LINE_WIDTH_MAX : prefs.lineWidth}
          min={LINE_WIDTH_MIN}
          max={LINE_WIDTH_MAX}
          step={20}
          display={full ? t('settings.lineWidthFull') : `${prefs.lineWidth}px`}
          disabled={full}
          onChange={(v) => setPref('lineWidth', v)}
          resetLabel={t('settings.resetTo', { value: `${LINE_WIDTH_DEFAULT}px` })}
          onReset={() => setPref('lineWidth', LINE_WIDTH_DEFAULT)}
          canReset={prefs.lineWidth !== LINE_WIDTH_DEFAULT}
          valueAttr={{ 'data-line-width-value': '' }}
        />
      </Row>
      <Row id="lineWidthFull" title={t('settings.lineWidthFullRow')} desc={t('settings.lineWidthFullDesc')} deviceOnly>
        <Toggle
          label={t('settings.lineWidthFullRow')}
          checked={full}
          onChange={(v) => setPref('lineWidth', v ? LINE_WIDTH_FULL : LINE_WIDTH_DEFAULT)}
        />
      </Row>
      <Row id="spellcheck" title={t('settings.spellcheck')} desc={t('settings.spellcheckDesc')} deviceOnly>
        <Toggle label={t('settings.spellcheck')} checked={prefs.spellcheck} onChange={(v) => setPref('spellcheck', v)} />
      </Row>
      <Row id="wordCount" title={t('settings.wordCount')} desc={t('settings.wordCountDesc')} deviceOnly>
        <Toggle label={t('settings.wordCount')} checked={prefs.wordCount} onChange={(v) => setPref('wordCount', v)} />
      </Row>
      <Row id="miniToc" title={t('settings.miniToc')} desc={t('settings.miniTocDesc')} deviceOnly>
        <Toggle label={t('settings.miniToc')} checked={prefs.miniToc} onChange={(v) => setPref('miniToc', v)} />
      </Row>
    </Group>
  )
}

function FilesSection() {
  const t = useT()
  const prefs = usePrefs()
  return (
    <Group title={t('settings.filesLinks')}>
      <Row id="launchPage" title={t('settings.launchPage')} desc={t('settings.launchPageDesc')} deviceOnly stack>
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
        desc={t('settings.newPageLocationDesc', { key: shortcutLabel('app.newPage') ?? '' })}
        deviceOnly
        stack
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
      <Row id="linkPreview" title={t('settings.linkPreview')} desc={t('settings.linkPreviewDesc')} deviceOnly>
        <Toggle label={t('settings.linkPreview')} checked={prefs.linkPreview} onChange={(v) => setPref('linkPreview', v)} />
      </Row>
      <Row id="confirmDelete" title={t('settings.confirmDelete')} desc={t('settings.confirmDeleteDesc')} deviceOnly>
        <Toggle
          label={t('settings.confirmDelete')}
          checked={prefs.confirmDelete}
          onChange={(v) => setPref('confirmDelete', v)}
        />
      </Row>
    </Group>
  )
}

function AppearanceSection() {
  const t = useT()
  const prefs = usePrefs()
  const { theme } = useTheme()
  return (
    <Group title={t('settings.appearance')}>
      <Row id="language" title={t('lang.label')} desc={t('lang.description')} stack>
        <LanguageSelect />
      </Row>
      <Row id="theme" title={t('settings.theme')} desc={t('settings.themeDesc')} deviceOnly stack>
        <Select<Theme>
          label={t('settings.theme')}
          value={theme}
          onChange={(v) => setTheme(v)}
          options={(['light', 'dark', 'system'] as Theme[]).map((th) => ({ value: th, label: t(THEME_LABEL_KEY[th]) }))}
        />
      </Row>
      <Row id="zoom" title={t('settings.zoom')} desc={t('settings.zoomDesc')} deviceOnly stack>
        <RangeControl
          label={t('settings.zoom')}
          value={prefs.zoom}
          min={ZOOM_MIN}
          max={ZOOM_MAX}
          step={5}
          display={`${prefs.zoom}%`}
          onChange={(v) => setPref('zoom', v)}
          resetLabel={t('settings.resetTo', { value: `${DEFAULT_PREFS.zoom}%` })}
          onReset={() => setPref('zoom', DEFAULT_PREFS.zoom)}
          canReset={prefs.zoom !== DEFAULT_PREFS.zoom}
          valueAttr={{ 'data-zoom-value': '' }}
        />
      </Row>
    </Group>
  )
}

function ConnectionsSection() {
  const t = useT()
  const navigate = useNavigate()
  const mcpUrl = `${window.location.origin}/mcp`
  const [copied, setCopied] = useState(false)
  const copyMcp = async () => {
    try {
      await navigator.clipboard.writeText(mcpUrl)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      // No permission: the address is selectable text.
    }
  }
  return (
    <>
      <Group title={t('settings.connections')}>
        <div className="px-4 py-3" data-pref="mcp">
          <div className="flex items-center gap-4">
            <div className="min-w-0 flex-1">
              <div className="text-sm text-ink">{t('settings.mcpServer')}</div>
              <div className="mt-0.5 text-xs leading-relaxed text-sub">{t('settings.mcpDesc')}</div>
            </div>
            <button type="button" onClick={() => navigate('/settings/connections')} className={`${btn} shrink-0`}>
              {t('settings.manageConnections')}
            </button>
          </div>
          <div className="mt-2 flex items-center gap-2">
            <code
              aria-label={t('settings.mcpUrl')}
              className="min-w-0 flex-1 select-all truncate rounded bg-side px-2 py-1 font-mono text-xs text-ink"
            >
              {mcpUrl}
            </code>
            <button type="button" onClick={copyMcp} className={`${btn} shrink-0`}>
              {copied ? t('common.copied') : t('settings.copyUrl')}
            </button>
          </div>
        </div>
      </Group>
      <IcalSettings />
    </>
  )
}

function ShortcutsSection() {
  const t = useT()
  return (
    <div>
      <ShortcutSettings />
      <p className="mt-6 border-t border-line pt-3 text-xs leading-relaxed text-sub">
        {isMac
          ? t('settings.shortcutsMacHint', { key: formatKey('Mod-n', PLATFORM), alt: formatKey('Mod-Alt-n', PLATFORM) })
          : t('settings.shortcutsWinHint', { key: shortcutLabel('app.newPage') ?? '' })}
      </p>
    </div>
  )
}

function AboutSection() {
  const t = useT()
  const guide = `${REPO_URL}/blob/main/docs/${getLocale() === 'ko' ? 'GUIDE.ko.md' : 'GUIDE.md'}`
  const link = (href: string) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className={`${btn} inline-flex items-center gap-1`}>
      {t('common.open')}
      <ExternalLinkIcon size={12} />
    </a>
  )
  return (
    <Group title={t('settings.about')}>
      <div className="px-4 py-3">
        <VersionInfo />
      </div>
      <Row title={t('settings.guide')} desc={t('settings.guideDesc')}>
        {link(guide)}
      </Row>
      <Row title={t('settings.github')} desc={t('settings.githubDesc')}>
        {link(REPO_URL)}
      </Row>
    </Group>
  )
}

/** What each section shows, and which group headings it leaves out (the section heading already says it). */
function SectionBody({ id, label }: { id: SectionId; label: string }) {
  switch (id) {
    case 'account':
      return (
        <SettingsFlat omitTitle={label}>
          <AccountGroup />
          <DeletedWorkspacesList />
        </SettingsFlat>
      )
    case 'security':
      return (
        <SettingsFlat omitTitle>
          <TwoFactorSettings />
        </SettingsFlat>
      )
    case 'notifications':
      return (
        <SettingsFlat omitTitle>
          <NotificationSettings />
        </SettingsFlat>
      )
    case 'editor':
      return (
        <SettingsFlat omitTitle>
          <EditorSection />
        </SettingsFlat>
      )
    case 'sidebar':
      return (
        <SettingsFlat omitTitle>
          <SidebarSettings />
        </SettingsFlat>
      )
    case 'files':
      return (
        <SettingsFlat omitTitle>
          <FilesSection />
        </SettingsFlat>
      )
    case 'appearance':
      return (
        <SettingsFlat omitTitle>
          <AppearanceSection />
        </SettingsFlat>
      )
    case 'connections':
      return (
        <SettingsFlat omitTitle={label}>
          <ConnectionsSection />
        </SettingsFlat>
      )
    case 'shortcuts':
      return <ShortcutsSection />
    case 'about':
      return (
        <SettingsFlat omitTitle>
          <AboutSection />
        </SettingsFlat>
      )
  }
}

export function Settings() {
  const t = useT()
  const { wsId } = useParams()
  const navigate = useNavigate()
  const location = useLocation()
  const { onToggleSidebar } = useLayout()
  const wide = useWide()
  const navRef = useRef<HTMLUListElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const lastSection = useRef<SectionId | null>(null)

  const hash = decodeURIComponent(location.hash.slice(1))
  const chosen = isSectionId(hash) ? hash : null
  // A wide screen always shows a section (the first one when the URL names none); a phone shows the list.
  const active: SectionId | null = chosen ?? (wide ? 'account' : null)
  const fromList = (location.state as { fromList?: boolean } | null)?.fromList === true

  // Came from inside the app: go to the previous screen; opened by URL: go to the workspace home (same as Admin).
  const goBack = () => {
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0
    if (idx > 0) navigate(-1)
    else navigate(wsId ? `/w/${wsId}` : '/')
  }

  // Phone: from a section back to the list. Undo the list → section step when that is how we got here,
  // otherwise (opened by a link) replace the entry so the browser's back still leaves Settings.
  const backToList = () => {
    if (fromList) navigate(-1)
    else navigate({ hash: '' }, { replace: true })
  }

  // A new section starts at the top. On a phone, focus moves to the section heading when one opens and back
  // to its list item when returning, so a screen reader or keyboard user does not lose their place.
  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0 })
    if (wide) return
    if (active) {
      lastSection.current = active
      headingRef.current?.focus({ preventScroll: true })
    } else if (lastSection.current) {
      navRef.current?.querySelector<HTMLElement>(`[data-section="${lastSection.current}"]`)?.focus()
    }
  }, [active, wide])

  // ↑/↓ (and Home/End) move between list items; Enter opens one, like any link. Tab leaves the list.
  const onNavKey = (e: React.KeyboardEvent<HTMLUListElement>) => {
    const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End']
    if (!keys.includes(e.key)) return
    const items = [...(navRef.current?.querySelectorAll<HTMLElement>('[data-section]') ?? [])]
    const i = items.indexOf(document.activeElement as HTMLElement)
    const next =
      e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : e.key === 'ArrowDown' ? Math.min(items.length - 1, i + 1) : Math.max(0, i - 1)
    e.preventDefault()
    items[next]?.focus()
  }

  const label = active ? t(SECTIONS[active].label) : ''
  // Phone with a section open: the header's back button returns to the list.
  const inSection = !wide && active !== null

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
        {/* One back button. On a phone inside a section it returns to the section list (also in the installed
            app, where it is the only way back); otherwise it leaves Settings. */}
        {(inSection || !isStandalone()) && (
          <button
            type="button"
            onClick={inSection ? backToList : goBack}
            className="rounded-md px-2 py-1 text-sm text-sub transition-colors duration-150 hover:bg-hover hover:text-ink"
          >
            ← {inSection ? t('settings.backToList') : t('common.back')}
          </button>
        )}
        <div className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-sm font-medium text-ink">
          {inSection ? label : t('common.settings')}
        </div>
        <ThemeToggle />
      </header>

      <div className="flex min-h-0 flex-1">
        <nav
          aria-label={t('settings.sections')}
          className={`${active ? 'hidden' : 'flex'} min-h-0 w-full shrink-0 flex-col overflow-y-auto sm:flex sm:w-52 sm:border-r sm:border-line sm:bg-side/40`}
        >
          <ul ref={navRef} onKeyDown={onNavKey} className="flex flex-col p-2 sm:gap-0.5 sm:py-4">
            {SECTION_IDS.map((id) => {
              const current = id === active
              return (
                <li key={id}>
                  <Link
                    to={{ hash: id }}
                    replace={wide}
                    state={wide ? undefined : { fromList: true }}
                    data-section={id}
                    // One tab stop for the whole list (the open section, or the first item): ↑/↓ move within it.
                    tabIndex={id === (active ?? SECTION_IDS[0]) ? 0 : -1}
                    aria-current={current ? 'page' : undefined}
                    className={`flex items-center gap-3 rounded-md px-3 py-3 text-[15px] transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent sm:gap-2.5 sm:px-2.5 sm:py-1.5 sm:text-sm ${
                      current ? 'bg-hover font-medium text-ink' : 'text-ink hover:bg-hover sm:text-sub sm:hover:text-ink'
                    }`}
                  >
                    <span className="flex shrink-0 text-sub">{SECTIONS[id].icon(16)}</span>
                    <span className="min-w-0 flex-1 truncate">{t(SECTIONS[id].label)}</span>
                    <ChevronRightIcon size={16} className="shrink-0 text-sub sm:hidden" />
                  </Link>
                </li>
              )
            })}
          </ul>
        </nav>

        <div
          ref={contentRef}
          className={`${active ? 'block' : 'hidden'} min-h-0 min-w-0 flex-1 overflow-y-auto sm:block`}
        >
          {active && (
            <section
              key={active}
              aria-labelledby="settings-section-title"
              className="nd-enter mx-auto w-full max-w-2xl px-4 pb-16 pt-4 sm:px-8 sm:pt-8"
            >
              <h2
                id="settings-section-title"
                ref={headingRef}
                tabIndex={-1}
                className="mb-5 text-xl font-semibold text-ink focus:outline-none"
              >
                {label}
              </h2>
              <SectionBody id={active} label={label} />
            </section>
          )}
        </div>
      </div>
    </div>
  )
}
