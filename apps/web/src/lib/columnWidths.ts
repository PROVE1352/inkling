import { COLUMN_WIDTH } from '@inkling/shared'
import type { ViewConfig } from '@inkling/shared'

// Column tracks of the collection table (docs/adr/1322-*, docs/adr/1351-*).
// A column without a stored width keeps its pane-sized track: a minimum, and a share (fr) of the
// space left in a wide pane. A column with a stored width (dragged in the header, saved on the view)
// is a fixed track. Each track is wrapped in `var(--tc-<i>, …)` so a drag can preview a width by
// setting one CSS variable on the table root, without re-rendering the rows.

/** column track minimums (px): title, every field, the trailing "+" column */
export const TITLE_MIN = COLUMN_WIDTH.titleMin
export const FIELD_MIN = COLUMN_WIDTH.fieldMin
export const ADD_COL = 44
const STEP = 16
const BIG_STEP = 64

type Widths = Pick<ViewConfig, 'columnWidths' | 'titleWidth'>

export function clampColumnWidth(w: number, title: boolean): number {
  const min = title ? TITLE_MIN : FIELD_MIN
  return Math.min(COLUMN_WIDTH.max, Math.max(min, Math.round(w)))
}

const valid = (w: unknown): w is number => typeof w === 'number' && Number.isFinite(w)

/**
 * Tracks for the title column, each field column and the "+" column, the grid template, and the
 * grid's minimum width (the sum of the fixed widths and the minimums of the others).
 */
export function columnTracks(
  cols: readonly { id: string }[],
  config: Widths,
): { tracks: string[]; template: string; minWidth: number } {
  const stored = config.columnWidths ?? {}
  const tracks: string[] = []
  let minWidth = 0
  let fluid = false
  const titleW = valid(config.titleWidth) ? clampColumnWidth(config.titleWidth, true) : null
  if (titleW === null) {
    tracks.push(`minmax(${TITLE_MIN}px, 1.6fr)`)
    minWidth += TITLE_MIN
    fluid = true
  } else {
    tracks.push(`${titleW}px`)
    minWidth += titleW
  }
  for (const c of cols) {
    const w = Object.hasOwn(stored, c.id) && valid(stored[c.id]) ? clampColumnWidth(stored[c.id], false) : null
    if (w === null) {
      tracks.push(`minmax(${FIELD_MIN}px, 1fr)`)
      minWidth += FIELD_MIN
      fluid = true
    } else {
      tracks.push(`${w}px`)
      minWidth += w
    }
  }
  // all columns fixed: the "+" column takes what is left of a wide pane, so the rows still end at its edge
  tracks.push(fluid ? `${ADD_COL}px` : `minmax(${ADD_COL}px, 1fr)`)
  minWidth += ADD_COL
  const template = tracks
    .map((t, i) => (i < tracks.length - 1 ? `var(--tc-${i}, ${t})` : t))
    .join(' ')
  return { tracks, template, minWidth }
}

/** The config with one width set (fieldId null = the title column) or removed (width null). */
export function withColumnWidth(config: ViewConfig, fieldId: string | null, width: number | null): ViewConfig {
  const next: ViewConfig = { ...config }
  if (fieldId === null) {
    if (width === null) delete next.titleWidth
    else next.titleWidth = clampColumnWidth(width, true)
    return next
  }
  const widths = { ...(config.columnWidths ?? {}) }
  if (width === null) delete widths[fieldId]
  else widths[fieldId] = clampColumnWidth(width, false)
  if (Object.keys(widths).length) next.columnWidths = widths
  else delete next.columnWidths
  return next
}

/** Keyboard on a focused column resize handle: ←/→ by 16 px (Shift: 64), Home to the minimum. */
export function columnWidthForKey(key: string, width: number, shift: boolean, title: boolean): number | null {
  const step = shift ? BIG_STEP : STEP
  switch (key) {
    case 'ArrowLeft':
      return clampColumnWidth(width - step, title)
    case 'ArrowRight':
      return clampColumnWidth(width + step, title)
    case 'Home':
      return title ? TITLE_MIN : FIELD_MIN
    default:
      return null
  }
}
