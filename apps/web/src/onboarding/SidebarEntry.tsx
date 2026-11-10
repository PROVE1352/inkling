import { lazy, Suspense, type ComponentType } from 'react'
import type { OnboardingDTO } from '@inkling/shared'
import type { SidebarCardSize } from '../lib/sidebarMenu'
import { useLocation } from 'react-router'
import { useIsGuest } from '../lib/useGuest'
import { useOnboarding } from './api'

// The folded "Getting started n/m" card at the bottom of the sidebar (docs/adr/2380-*). The card's
// code is its own chunk; this file only decides whether to show it. A chunk that cannot be fetched
// (offline before it was ever cached) renders nothing. The sidebar passes `fit` and `onSize` so the card
// is part of its height budget (docs/adr/2384-*).
type CardProps = {
  wsId: string
  dto: OnboardingDTO
  variant: 'home' | 'sidebar'
  fit?: { open: boolean; height: number } | null
  onSize?: (size: SidebarCardSize | null) => void
}
const Checklist = lazy(() =>
  import('./Checklist').then(
    (m): { default: ComponentType<CardProps> } => ({ default: m.Checklist }),
    (): { default: ComponentType<CardProps> } => ({ default: () => null }),
  ),
)

export function OnboardingSidebarEntry({
  wsId,
  fit,
  onSize,
}: {
  wsId: string
  fit: { open: boolean; height: number } | null
  onSize: (size: SidebarCardSize | null) => void
}) {
  const dto = useOnboarding()
  const guest = useIsGuest(wsId)
  const { pathname } = useLocation()
  // The empty workspace screen shows the whole card itself.
  if (!dto || guest || !dto.checklist.show || pathname.replace(/\/$/, '') === `/w/${wsId}`) return null
  return (
    <Suspense fallback={null}>
      <Checklist wsId={wsId} dto={dto} variant="sidebar" fit={fit} onSize={onSize} />
    </Suspense>
  )
}
