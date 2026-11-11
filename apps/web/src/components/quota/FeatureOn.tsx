import type { ReactNode } from 'react'
import type { DisabledFeatureName } from '@inkling/shared'
import { useFeatureOff } from './features'

/** Renders its children unless the server turned the feature off (DISABLED_FEATURES, docs/adr/2507-*). */
export function FeatureOn({ name, children }: { name: DisabledFeatureName; children: ReactNode }) {
  return useFeatureOff(name) ? null : <>{children}</>
}
