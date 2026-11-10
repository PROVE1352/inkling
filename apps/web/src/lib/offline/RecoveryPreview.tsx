import { useState } from 'react'
import * as Y from 'yjs'
import type { UserDTO } from '@inkling/shared'
import { LocalDocEditor } from '../../components/CollabEditor'
import type { RecoveryItem } from './store'

/** A recovery item's document, read-only, in the page editor (select and copy what you need). */
export function RecoveryPreview({ item, me }: { item: RecoveryItem; me: UserDTO }) {
  const [doc] = useState(() => {
    const d = new Y.Doc()
    Y.applyUpdate(d, item.state)
    return d
  })
  return <LocalDocEditor doc={doc} wsId={item.wsId} uploadPageId={item.pageId} me={me} readOnly />
}
