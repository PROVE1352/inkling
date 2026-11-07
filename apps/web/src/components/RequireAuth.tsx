import type { ReactNode } from 'react'
import { Navigate } from 'react-router'
import { useMe } from '../api'
import { FullScreenSpinner } from './Spinner'

// Redirects to /login without a session (me). Shows a spinner while loading.
export function RequireAuth({ children }: { children: ReactNode }) {
  const me = useMe()

  if (me.isLoading) return <FullScreenSpinner />
  if (me.isError || !me.data) return <Navigate to="/login" replace />
  return <>{children}</>
}
