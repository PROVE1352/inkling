import { useEffect, useState } from 'react'
import * as Y from 'yjs'
import type { HocuspocusProvider } from '@hocuspocus/provider'
import type { UserDTO } from '@inkling/shared'
import { userColor } from '../../lib/colors'
import type { CollabUser } from '../OnlineUsers'
import { openCollab, readStatus, readUsers, sameUsers } from '../../lib/collabSocket'
import type { ConnStatus } from '../CollabEditor'

// Origin of Yjs transactions created by local canvas edits. When an observe callback sees this origin,
// the change is our own echo and is ignored — only remote changes are reflected back on screen.
export const LOCAL_ORIGIN = Symbol('inkling-canvas-local')

export type CanvasDoc = {
  doc: Y.Doc
  provider: HocuspocusProvider | null
  cnodes: Y.Map<unknown>
  cedges: Y.Map<unknown>
  status: ConnStatus
  synced: boolean
  users: CollabUser[]
}

type AwarenessLike = {
  setLocalStateField: (field: string, value: unknown) => void
}

// Canvas counterpart of the BlockNote collaborative editor's doc hook. Provider lifecycle mirrors CollabEditor: the provider
// is created inside the effect on the tab-wide socket (lib/collabSocket.ts, docs/adr/0702-*),
// subscribed in the same tick, read defensively, and released in cleanup. The document uses
// Y.Map('cnodes'/'cedges') instead of an XmlFragment.
export function useCanvasDoc(pageId: string, me: UserDTO): CanvasDoc {
  // The component is fully remounted per pageId (via key), so there is exactly one doc per mount.
  const [doc] = useState(() => new Y.Doc())
  const [provider, setProvider] = useState<HocuspocusProvider | null>(null)

  const cnodes = doc.getMap('cnodes') as Y.Map<unknown>
  const cedges = doc.getMap('cedges') as Y.Map<unknown>

  const [status, setStatus] = useState<ConnStatus>('connecting')
  const [synced, setSynced] = useState(false)
  const [users, setUsers] = useState<CollabUser[]>([])

  // Only identity-stable inputs here. me.name used to be a dependency: renaming yourself ran the
  // cleanup (provider destroyed) and then connect() on the destroyed provider — a zombie socket.
  useEffect(() => {
    const handle = openCollab({ name: pageId, document: doc, userKey: me.id })
    const p = handle.provider
    // On the shared socket the socket status says nothing about *this* document: a denied
    // (or revoked) document must still show as disconnected.
    let denied = false
    const onStatus = () => setStatus(denied ? 'disconnected' : readStatus(p))
    const onDenied = () => {
      denied = true
      setStatus('disconnected')
    }
    p.on('authenticationFailed', onDenied)
    const onSynced = (e: { state: boolean }) => setSynced(e.state)
    p.on('status', onStatus)
    p.on('synced', onSynced)
    let last: CollabUser[] = []
    const onAwareness = () => {
      const next = readUsers(p)
      if (!sameUsers(last, next)) {
        last = next
        setUsers(next)
      }
    }
    p.awareness?.on('change', onAwareness)
    onAwareness()
    setSynced(p.isSynced)
    onStatus()
    setProvider(p)
    return () => {
      p.off('status', onStatus)
      p.off('authenticationFailed', onDenied)
      p.off('synced', onSynced)
      p.awareness?.off('change', onAwareness)
      handle.release()
      setProvider(null)
    }
  }, [doc, pageId, me.id])

  useEffect(() => () => doc.destroy(), [doc])

  // Set the awareness user field so I show up in the presence list (there is no BlockNote here to fill it —
  // used by OnlineUsers / the top-bar avatars). Separate effect: a rename updates the field in place.
  useEffect(() => {
    const awareness = provider?.awareness as AwarenessLike | null | undefined
    // `id`: presence shows the member's status (docs/adr/1846-*)
    awareness?.setLocalStateField('user', { name: me.name, color: userColor(me.id), id: me.id })
  }, [provider, me.name, me.id])

  return { doc, provider, cnodes, cedges, status, synced, users }
}
