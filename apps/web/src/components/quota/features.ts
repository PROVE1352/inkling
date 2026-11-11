import type { DisabledFeatureName } from '@inkling/shared'
import { useAuthMode } from '../../api'

/**
 * Features the server turned off (DISABLED_FEATURES, docs/adr/2507-*), from /api/auth/mode. The server
 * refuses them anyway (404 FEATURE_DISABLED); the app hides their menus and buttons. Nothing off (or
 * an older server) → an empty set.
 */
export function useDisabledFeatures(): ReadonlySet<string> {
  const list = useAuthMode().data?.disabledFeatures
  const set = list && list.length ? new Set(list) : EMPTY
  latest = set
  return set
}

const EMPTY: ReadonlySet<string> = new Set()
/** The set the last render read (/auth/mode loads once per page load), for code outside React. */
let latest: ReadonlySet<string> = EMPTY

/**
 * Outside React (the editor's paste handler and slash items, built when the editor is made): whether a
 * feature is off, as the last component that asked saw it. False until /auth/mode has loaded.
 */
export function featureOffNow(name: DisabledFeatureName): boolean {
  return latest.has(name)
}

/** One feature is off. */
export function useFeatureOff(name: DisabledFeatureName): boolean {
  return useDisabledFeatures().has(name)
}
