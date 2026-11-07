import { t, type TKey } from '../../i18n'

// Resolves JSON Canvas preset colors ('1'–'6') and arbitrary hex ('#rrggbb') to CSS colors.
// Uses the same colors as Obsidian Canvas's default palette.

// `key`/`hex` are stored in documents and must not change; `label` is a getter so it is
// translated at render time, never frozen at import.
function preset(key: string, hex: string, labelKey: TKey): { key: string; hex: string; label: string } {
  return {
    key,
    hex,
    get label() {
      return t(labelKey)
    },
  }
}

export const CANVAS_PRESETS: { key: string; hex: string; readonly label: string }[] = [
  preset('1', '#fb464c', 'canvas.colorRed'),
  preset('2', '#e9973f', 'canvas.colorOrange'),
  preset('3', '#e0de71', 'canvas.colorYellow'),
  preset('4', '#44cf6e', 'canvas.colorGreen'),
  preset('5', '#53dfdd', 'canvas.colorCyan'),
  preset('6', '#a882ff', 'canvas.colorPurple'),
]

const PRESET_MAP = new Map(CANVAS_PRESETS.map((p) => [p.key, p.hex]))

// Stored value → actual CSS color. undefined when there is no value.
export function resolveColor(color?: string): string | undefined {
  if (!color) return undefined
  if (color.startsWith('#')) return color
  return PRESET_MAP.get(color) ?? color
}

// Card background tint (when a color is set, mix a little of it into the app background)
export function tintBackground(color?: string): string {
  const c = resolveColor(color)
  return c ? `color-mix(in srgb, ${c} 12%, var(--color-app))` : 'var(--color-app)'
}

export function borderColor(color?: string): string {
  return resolveColor(color) ?? 'var(--color-line)'
}
