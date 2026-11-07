import type { SelectOption } from '@inkling/shared'
import { t, type TKey } from '../i18n'

export type OptionColor = SelectOption['color']

// The 8 select/multiSelect option colours, shared by the FieldsModal editor, badges and dots.
// The ids ('gray', 'red', …) are stored in collection schemas — never rename them.
export const OPTION_COLORS: OptionColor[] = [
  'gray',
  'red',
  'orange',
  'yellow',
  'green',
  'blue',
  'purple',
  'pink',
]

// Badge (background + text) — keeps contrast in both light and dark, via .dark variants.
export const OPTION_BADGE_CLASS: Record<OptionColor, string> = {
  gray: 'bg-gray-200 text-gray-700 dark:bg-gray-600/50 dark:text-gray-100',
  red: 'bg-red-100 text-red-700 dark:bg-red-500/25 dark:text-red-200',
  orange: 'bg-orange-100 text-orange-700 dark:bg-orange-500/25 dark:text-orange-200',
  yellow: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-500/25 dark:text-yellow-100',
  green: 'bg-green-100 text-green-700 dark:bg-green-500/25 dark:text-green-200',
  blue: 'bg-blue-100 text-blue-700 dark:bg-blue-500/25 dark:text-blue-200',
  purple: 'bg-purple-100 text-purple-700 dark:bg-purple-500/25 dark:text-purple-200',
  pink: 'bg-pink-100 text-pink-700 dark:bg-pink-500/25 dark:text-pink-200',
}

// Dot — shown on board column headers and before options in lists.
export const OPTION_DOT_CLASS: Record<OptionColor, string> = {
  gray: 'bg-gray-400',
  red: 'bg-red-500',
  orange: 'bg-orange-500',
  yellow: 'bg-yellow-400',
  green: 'bg-green-500',
  blue: 'bg-blue-500',
  purple: 'bg-purple-500',
  pink: 'bg-pink-500',
}

const OPTION_COLOR_KEY: Record<OptionColor, TKey> = {
  gray: 'colors.gray',
  red: 'colors.red',
  orange: 'colors.orange',
  yellow: 'colors.yellow',
  green: 'colors.green',
  blue: 'colors.blue',
  purple: 'colors.purple',
  pink: 'colors.pink',
}

/** Display name per colour. Getters, so each read is translated in the current language. */
export const OPTION_COLOR_LABEL = Object.defineProperties(
  {} as Record<OptionColor, string>,
  Object.fromEntries(
    OPTION_COLORS.map((c) => [c, { get: () => t(OPTION_COLOR_KEY[c]), enumerable: true }]),
  ),
)
