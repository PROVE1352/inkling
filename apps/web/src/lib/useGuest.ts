import { useParams } from 'react-router'
import { useWorkspaces } from '../api'
import { isGuestRole } from './pageAccess'

/**
 * The caller is a guest in this workspace (docs/adr/1250-*): only the pages shared with them, and
 * the server answers 403 to everything else, so guest screens keep those queries off.
 * Without `wsId` it reads the route's :wsId.
 */
export function useIsGuest(wsId?: string): boolean {
  const params = useParams()
  const id = wsId ?? params.wsId ?? ''
  const workspaces = useWorkspaces()
  return isGuestRole(workspaces.data?.find((w) => w.id === id)?.role)
}
