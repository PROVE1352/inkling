import type { DisabledFeatureName } from '@inkling/shared'
import { useAuthMode } from '../../api'

/**
 * Features the server turned off (DISABLED_FEATURES, docs/adr/2507-*), from /api/auth/mode. The server
 * refuses them anyway (404 FEATURE_DISABLED); the app hides their menus and buttons. Nothing off (or
 * an older server) → an empty set.
 */
export function useDisabledFeatures(): ReadonlySet<string> {
  const list = useAuthMode().data?.disabledFeatures
  return list && list.length ? new Set(list) : EMPTY
}

const EMPTY: ReadonlySet<string> = new Set()

/** One feature is off. */
export function useFeatureOff(name: DisabledFeatureName): boolean {
  return useDisabledFeatures().has(name)
}
