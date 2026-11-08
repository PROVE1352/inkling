import { useT } from '../i18n'

/** Small "Guest" tag: a person outside the workspace, or a workspace you only have some pages of (docs/adr/1250-*). */
export function GuestBadge({ className = '' }: { className?: string }) {
  const t = useT()
  return (
    <span className={`shrink-0 rounded-full border border-line px-1.5 py-px text-[10px] leading-4 text-sub ${className}`}>
      {t('access.guest')}
    </span>
  )
}
