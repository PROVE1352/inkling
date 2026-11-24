import { Navigate } from 'react-router'
import { useMe, useWorkspaces } from '../api'
import { landingWorkspace } from '../lib/workspaceListing'
import { useWorkspaceGroups } from '../workspaceListingApi'
import { FullScreenSpinner } from '../components/Spinner'
import { Onboarding } from './Onboarding'

// Entry logic for '/'.
export function Home() {
  const me = useMe()
  // only once someone is signed in: a signed-out visitor goes to /login without a 401 for the list
  // (right after signing in `me` is already in the cache, so this does not wait)
  const workspaces = useWorkspaces({ enabled: !!me.data })
  const groups = useWorkspaceGroups()

  if (me.isLoading) return <FullScreenSpinner />
  if (me.isError || !me.data) return <Navigate to="/login" replace />

  if (workspaces.isPending) return <FullScreenSpinner />
  const list = workspaces.data ?? []
  if (list.length === 0) return <Onboarding />

  let last: string | null = null
  try {
    last = localStorage.getItem('inkling:lastWs')
  } catch {
    last = null
  }
  // the last one used, else the first one not archived in switcher order (docs/adr/2300-*)
  const target = landingWorkspace(list, groups, last)?.id ?? list[0].id
  return <Navigate to={`/w/${target}`} replace />
}
