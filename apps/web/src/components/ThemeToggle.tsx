import { setTheme, useTheme, type Theme } from '../lib/theme'
import { MonitorIcon, MoonIcon, SunIcon } from './Icons'
import { useT, type TKey } from '../i18n'

// Button that cycles light → dark → system.
const ORDER: Theme[] = ['light', 'dark', 'system']
const LABEL_KEY: Record<Theme, TKey> = {
  light: 'theme.light',
  dark: 'theme.dark',
  system: 'theme.system',
}

export function ThemeToggle() {
  const t = useT()
  const { theme } = useTheme()

  const cycle = () => {
    const next = ORDER[(ORDER.indexOf(theme) + 1) % ORDER.length]
    setTheme(next)
  }

  return (
    <button
      type="button"
      onClick={cycle}
      title={t('theme.title', { theme: t(LABEL_KEY[theme]) })}
      aria-label={t('theme.toggle', { theme: t(LABEL_KEY[theme]) })}
      className="rounded-md p-1.5 text-sub transition-colors duration-150 hover:bg-hover hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      {theme === 'light' && <SunIcon size={18} />}
      {theme === 'dark' && <MoonIcon size={18} />}
      {theme === 'system' && <MonitorIcon size={18} />}
    </button>
  )
}
