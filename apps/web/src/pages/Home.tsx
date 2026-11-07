import { Navigate } from 'react-router'
import { useMe, useWorkspaces } from '../api'
import { FullScreenSpinner } from '../components/Spinner'
import { Onboarding } from './Onboarding'

// Entry logic for '/'.
export function Home() {
  const me = useMe()
  const workspaces = useWorkspaces()

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
  const target = list.find((w) => w.id === last)?.id ?? list[0].id
  return <Navigate to={`/w/${target}`} replace />
}
