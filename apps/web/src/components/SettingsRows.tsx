import { createContext, useContext, type ReactNode } from 'react'
import { useT } from '../i18n'

// Settings rows shared by the personal settings screen and the workspace settings screen:
// grouped rows like Obsidian's settings (title/description + control on the right).
//
// Two looks. The workspace settings screen keeps the default: a small heading over a bordered box.
// The personal settings screen (pages/Settings.tsx) wraps each category in <SettingsFlat>, which
// drops the box for thin dividers flush with the category heading. Section components (notifications,
// two-step verification, sidebar…) render <Group> themselves and follow whichever look they are in.

type FlatCtx = {
  /** Group titles to leave out: `true` = all of them (the category heading already names the one group). */
  omitTitle: string | true
} | null

const SettingsFlatContext = createContext<FlatCtx>(null)

/** Inside the personal settings screen (flat rows instead of boxes). */
export function useSettingsFlat(): boolean {
  return useContext(SettingsFlatContext) !== null
}

export function SettingsFlat({ omitTitle, children }: { omitTitle: string | true; children: ReactNode }) {
  return <SettingsFlatContext.Provider value={{ omitTitle }}>{children}</SettingsFlatContext.Provider>
}

export function Group({ title, desc, children }: { title: string; desc?: ReactNode; children: ReactNode }) {
  const flat = useContext(SettingsFlatContext)
  if (flat) {
    const showTitle = flat.omitTitle !== true && flat.omitTitle !== title
    return (
      <section className="mb-10 last:mb-0">
        {showTitle && <h3 className="mb-1 text-sm font-semibold text-ink">{title}</h3>}
        {desc && <p className="mb-2 text-xs leading-relaxed text-sub">{desc}</p>}
        {/* Section components pad their own blocks with px-4 for the boxed look; flush them here. */}
        <div className="divide-y divide-line border-y border-line *:px-0!">{children}</div>
      </section>
    )
  }
  return (
    <section className="mb-8">
      <h2 className="mb-1 px-1 text-[11px] font-semibold uppercase tracking-wide text-sub">
        {title}
      </h2>
      {desc && <p className="mb-2 px-1 text-xs text-sub">{desc}</p>}
      <div className="divide-y divide-line rounded-lg border border-line">{children}</div>
    </section>
  )
}

/** Small "This device" tag for preferences kept in this browser only (lib/prefs), not on the account. */
export function DeviceBadge() {
  const t = useT()
  return (
    <span
      title={t('settings.deviceOnlyTitle')}
      className="ml-2 inline-flex shrink-0 items-center rounded border border-line px-1 py-px align-[1px] text-[10px] font-normal leading-none text-sub"
    >
      {t('settings.deviceOnlyBadge')}
    </span>
  )
}

export function Row({
  title,
  desc,
  children,
  id,
  deviceOnly,
  stack,
}: {
  title: string
  desc?: ReactNode
  children?: ReactNode
  id?: string
  /** Saved in this browser only: shows the "This device" tag next to the title. */
  deviceOnly?: boolean
  /** Wide control (slider, select): on a phone it goes on its own line under the text instead of squeezing it. */
  stack?: boolean
}) {
  return (
    <div
      className={`flex gap-4 px-4 py-3 ${stack ? 'flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:gap-4' : 'items-center'}`}
      data-pref={id}
    >
      <div className="min-w-0 flex-1">
        <div className="text-sm text-ink">
          {title}
          {deviceOnly && <DeviceBadge />}
        </div>
        {desc && <div className="mt-0.5 text-xs leading-relaxed text-sub">{desc}</div>}
      </div>
      {children !== undefined && children !== null && children !== false && (
        <div className="flex shrink-0 items-center justify-end gap-2">{children}</div>
      )}
    </div>
  )
}

export function Toggle({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50 ${
        checked ? 'bg-accent' : 'bg-line'
      }`}
    >
      <span
        className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform duration-150 ${
          checked ? 'translate-x-[18px]' : 'translate-x-0.5'
        }`}
      />
    </button>
  )
}

/**
 * One width for every settings select so the right-hand column lines up (wider labels still grow it).
 * On a phone it fills the space it is given (a stacked row's full width).
 */
export const SELECT_CLASS =
  'min-w-[9rem] rounded-md max-sm:flex-1 border border-line bg-app px-2 py-1 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-60 sm:min-w-[12rem]'

export function Select<T extends string>({
  value,
  options,
  onChange,
  label,
  disabled,
}: {
  value: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
  label: string
  disabled?: boolean
}) {
  return (
    <select
      value={value}
      aria-label={label}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value as T)}
      className={SELECT_CLASS}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}
