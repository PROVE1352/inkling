// Reminder presets of the Later list (docs/adr/1411-*), computed in the device's own time zone (the
// browser's local clock). The server stores the absolute instant and never computes "tomorrow 9:00"
// itself: only the device knows which evening or Monday the person means.

export type LaterPresetId = 'in20' | 'tonight' | 'tomorrow' | 'nextWeek'

export interface LaterPreset {
  id: LaterPresetId
  at: Date
}

/** "Tonight" is offered until half an hour before it. */
const TONIGHT_HOUR = 18
const MORNING_HOUR = 9

function atLocal(base: Date, addDays: number, hour: number): Date {
  // Calendar arithmetic on the local date (setDate handles month ends and DST shifts).
  const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + addDays, hour, 0, 0, 0)
  return d
}

export function laterPresets(now: Date = new Date()): LaterPreset[] {
  const out: LaterPreset[] = []
  const in20 = new Date(now.getTime() + 20 * 60_000)
  in20.setSeconds(0, 0)
  out.push({ id: 'in20', at: in20 })
  const tonight = atLocal(now, 0, TONIGHT_HOUR)
  if (tonight.getTime() - now.getTime() >= 30 * 60_000) out.push({ id: 'tonight', at: tonight })
  out.push({ id: 'tomorrow', at: atLocal(now, 1, MORNING_HOUR) })
  // Next Monday (a Monday means the one after it): getDay() 0 = Sunday … 6 = Saturday.
  const toMonday = ((8 - now.getDay()) % 7) || 7
  out.push({ id: 'nextWeek', at: atLocal(now, toMonday, MORNING_HOUR) })
  return out
}

/** `<input type="datetime-local">` value (local wall time, minutes) for a Date. */
export function toLocalInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

/** The instant of a `datetime-local` value, read as local wall time; null when empty or invalid. */
export function fromLocalInput(v: string): Date | null {
  const m = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)$/.exec(v)
  if (!m) return null
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), 0, 0)
  return Number.isNaN(d.getTime()) ? null : d
}
