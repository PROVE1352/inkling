import { useMe, useSetUserLocale } from '../api'
import { getLocaleChoice, LOCALES, setLocaleChoice, useT, type Locale } from '../i18n'
import { LOCALE_NAMES } from '../i18n/names'
import { SELECT_CLASS } from './SettingsRows'

/**
 * UI language picker. Applies immediately (the app remounts in the new language) and, when signed
 * in, saves the choice to the account (users.locale) so other devices and emails follow it.
 * `compact` drops the label for the sign-in screens.
 */
export function LanguageSelect({ compact = false }: { compact?: boolean }) {
  const t = useT()
  const me = useMe()
  const save = useSetUserLocale()
  const value = getLocaleChoice() ?? ''

  const onChange = (raw: string) => {
    const next = (raw || null) as Locale | null
    if (me.data) save.mutate(next)
    setLocaleChoice(next)
  }

  return (
    <select
      aria-label={t('lang.label')}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={
        compact
          ? 'rounded-md border border-line bg-transparent px-2 py-1 text-xs text-sub'
          : SELECT_CLASS
      }
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
