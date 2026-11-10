import { Navigate } from 'react-router'
import { useMe, useWorkspaces } from '../api'
import { landingWorkspace } from '../lib/workspaceListing'
import { useWorkspaceGroups } from '../workspaceListingApi'
import { FullScreenSpinner } from '../components/Spinner'
import { Onboarding } from './Onboarding'

// Entry logic for '/'.
export function Home() {
  const me = useMe()
  const workspaces = useWorkspaces()
  const groups = useWorkspaceGroups()

  if (me.isLoading) return <FullScreenSpinner />
  if (me.isError || !me.data) return <Navigate to="/login" replace />

  if (workspaces.isLoading) return <FullScreenSpinner />
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
