// Relative time / local date formatting helpers (M2). Display formatting follows the UI locale
// (i18n/index.ts); the ISO helpers below are locale-neutral data formats.
import { fmtDateTime, fmtRelative } from '../i18n'

/** "3 minutes ago", in the UI locale. */
export function relativeTime(iso: string): string {
  return fmtRelative(iso)
}

// Local-time-zone YYYY-MM-DD. Built from local fields to avoid the UTC shift of Date
// (shared by daily-note titles and calendar cell matching; same format as the M3 date values).
export function toISODate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function todayISODate(): string {
  return toISODate(new Date())
}

// How many days after today a local 'YYYY-MM-DD' is. Today=0, tomorrow=1, yesterday=-1; null if
// malformed. Built from local fields and compared at midnight to avoid the UTC shift (M17 D-day).
export function daysFromToday(ymd: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd)
  if (!m) return null
  const target = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  if (Number.isNaN(target.getTime())) return null
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  return Math.round((target.getTime() - today.getTime()) / 86_400_000)
}

/** Short date + time in the UI locale. */
export function formatDateTime(iso: string): string {
  return fmtDateTime(iso)
}
