import { useAuthMode } from '../api'
import { useT } from '../i18n'

/**
 * The instance label every screen shows (INSTANCE_LABEL, restricted mode, docs/adr/2519-*), e.g.
 * "Demo", so nobody mistakes this server for another one. Nothing when the server sets no label.
 *
 *   sidebar  in the sidebar head, under the workspace switcher (wide screens, and the phone drawer)
 *   banner   a thin strip above the page on phones, where the sidebar is a closed drawer; on wide
 *            screens only while the sidebar is collapsed (the sidebar copy is hidden then)
 *   auth     under the title of the sign-in, sign-up, consent and document screens
 *
 * Colours are the theme tokens (ink on accent-soft, accent border), readable in the light and dark themes. Sits
 * beside the account expiry line (AccountExpiry) without pushing it: one short line, truncated.
 */
export function InstanceBadge({ placement }: { placement: 'sidebar' | 'banner' | 'auth' }) {
  const t = useT()
  const label = useAuthMode().data?.instanceLabel
  if (!label) return null
  const title = t('legal.instanceTitle', { label })
  if (placement === 'banner') {
    return (
      <div
        data-instance-banner
        title={title}
        className="flex shrink-0 items-center justify-center border-b border-line bg-accent-soft px-3 py-0.5 text-[11px] font-semibold tracking-wide text-ink md:hidden [[data-sidebar-shell]:has(>[inert])~main_&]:md:flex"
      >
        <span className="truncate">{label}</span>
      </div>
    )
  }
  const pill = (
    <span
      title={title}
      data-instance-badge={placement}
      className="inline-block max-w-full truncate rounded border border-accent/40 bg-accent-soft px-1.5 py-px align-middle text-[11px] font-semibold tracking-wide text-ink"
    >
      {label}
    </span>
  )
  if (placement === 'auth') return pill
  return <div className="mt-1 flex min-w-0 px-1">{pill}</div>
}
