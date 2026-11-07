import { createContext, useContext } from 'react'

/**
 * The collection page's edit lock denies editing (docs/adr/0970-*): cells render as display only
 * and no add/delete/drag/config UI is shown. Viewing, switching views and opening rows stay.
 */
export const CollectionReadOnlyContext = createContext(false)

export function useCollectionReadOnly(): boolean {
  return useContext(CollectionReadOnlyContext)
}
