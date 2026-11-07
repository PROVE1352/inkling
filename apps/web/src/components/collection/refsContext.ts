import { createContext, useContext } from 'react'
import type { RowRefDTO } from '@inkling/shared'

/** Linked-row titles for relation cells (server-filtered `refs` of the collection bundle). */
export const CollectionRefsContext = createContext<Record<string, RowRefDTO> | null>(null)

export function useCollectionRefs(): Record<string, RowRefDTO> | null {
  return useContext(CollectionRefsContext)
}
