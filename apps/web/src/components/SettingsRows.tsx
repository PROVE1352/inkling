import type { ReactNode } from 'react'

// Settings rows shared by the personal settings screen and the workspace settings screen:
// grouped rows like Obsidian's settings (title/description + control on the right).

export function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-8">
      <h2 className="mb-1 px-1 text-[11px] font-semibold uppercase tracking-wide text-sub">
        {title}
      </h2>
      <div className="divide-y divide-line rounded-lg border border-line">{children}</div>
    </section>
  )
}

export function Row({
  title,
  desc,
  children,
  id,
}: {
  title: string
  desc?: ReactNode
  children: ReactNode
  id?: string
}) {
  return (
    <div className="flex items-center gap-4 px-4 py-3" data-pref={id}>
      <div className="min-w-0 flex-1">
        <div className="text-sm text-ink">{title}</div>
        {desc && <div className="mt-0.5 text-xs leading-relaxed text-sub">{desc}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
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
      className="rounded-md border border-line bg-app px-2 py-1 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-60"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}
