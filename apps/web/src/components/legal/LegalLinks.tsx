import { Link } from 'react-router'
import { getLocaleChoice, LOCALES, setLocaleChoice, useT, type Locale } from '../../i18n'
import { LOCALE_NAMES } from '../../i18n/names'
import { Row } from '../SettingsRows'
import { DOC_PATH, useLegalMode, type LegalDocName } from './legalApi'

/**
 * Links to this server's terms and privacy policy (LEGAL_DIR, docs/adr/2519-*): under the sign-in and
 * sign-up forms, at the foot of the sidebar, in Settings › About. Only the documents the server has;
 * nothing without LEGAL_DIR.
 */

const LABEL: Record<LegalDocName, 'legal.terms' | 'legal.privacy'> = { terms: 'legal.terms', privacy: 'legal.privacy' }

/** "Terms of Service · Privacy Policy" in small text (sign-in, sign-up and consent screens). */
export function LegalLinks() {
  const t = useT()
  const docs = useLegalMode()?.docs ?? []
  if (docs.length === 0) return null
  return (
    <nav aria-label={t('legal.linksLabel')} className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-xs" data-testid="legal-links">
      {docs.map((d) => (
        <Link key={d} to={DOC_PATH[d]} className="text-sub hover:text-ink hover:underline">
          {t(LABEL[d])}
        </Link>
      ))}
    </nav>
  )
}

/** The same links, one line at the foot of the sidebar. */
export function LegalSidebarLinks() {
  const t = useT()
  const docs = useLegalMode()?.docs ?? []
  if (docs.length === 0) return null
  return (
    <nav aria-label={t('legal.linksLabel')} className="mt-1 flex flex-wrap gap-x-2 px-1 text-[11px]" data-testid="legal-sidebar-links">
      {docs.map((d) => (
        <Link key={d} to={DOC_PATH[d]} className="text-sub/80 hover:text-ink hover:underline">
          {t(LABEL[d])}
        </Link>
      ))}
    </nav>
  )
}

/** Settings › About rows. */
export function LegalSettingsRows() {
  const t = useT()
  const docs = useLegalMode()?.docs ?? []
  if (docs.length === 0) return null
  return (
    <>
      {docs.map((d) => (
        <Row key={d} title={t(LABEL[d])} desc={t(d === 'terms' ? 'legal.settingsTermsDesc' : 'legal.settingsPrivacyDesc')}>
          <Link
            to={DOC_PATH[d]}
            className="rounded-md border border-line px-2 py-1 text-xs text-ink transition-colors duration-150 hover:bg-hover"
          >
            {t('common.open')}
          </Link>
        </Row>
      ))}
    </>
  )
}

/**
 * Language picker for the screens a person sees before agreeing. It changes this browser only:
 * saving the language on the account (PATCH /api/auth/me/locale) is refused until the consent, and
 * the consent screen saves the choice right after it.
 */
export function LegalLanguageSelect() {
  const t = useT()
  return (
    <select
      aria-label={t('lang.label')}
      value={getLocaleChoice() ?? ''}
      onChange={(e) => setLocaleChoice((e.target.value || null) as Locale | null)}
      className="rounded-md border border-line bg-transparent px-2 py-1 text-xs text-sub"
    >
      <option value="">{t('lang.auto')}</option>
      {LOCALES.map((l) => (
        <option key={l} value={l}>
          {LOCALE_NAMES[l]}
        </option>
      ))}
    </select>
  )
}
