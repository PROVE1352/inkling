import { useNavigate, useParams } from 'react-router'
import type { PageMetaDTO } from '@inkling/shared'
import { useCreatePage, usePages } from '../api'
import { getPrefs, type NewPageLocation } from './prefs'

// Create input honouring the "New page location" setting (top level | inside the current page |
// same folder as the current page). Without a current page (home, graph, …) it is always top level.
// A page under a collection becomes a "row", so the same folder is used instead of a child.
export function newPageTarget(
  loc: NewPageLocation,
  current: PageMetaDTO | undefined,
  all: PageMetaDTO[] = [],
): { parentId?: string; scope?: PageMetaDTO['scope'] } {
  if (!current || loc === 'root') return {}
  if (loc === 'child' && current.kind !== 'collection') {
    return { parentId: current.id }
  }
  // sibling (or child of a collection): same parent. With no parent, or a collection parent (it would
  // become a row), use the top level of the same section.
  const parent = current.parentId ? all.find((p) => p.id === current.parentId) : undefined
  if (parent && parent.kind !== 'collection') return { parentId: parent.id }
  return { scope: current.scope }
}

// Shared by ⌘N, the sidebar "New page" and the palette "New document". Navigates to the page after creating it.
export function useNewPage(wsId: string) {
  const navigate = useNavigate()
  const { pageId } = useParams()
  const pages = usePages(wsId)
  const createPage = useCreatePage(wsId)

  const create = () => {
    if (createPage.isPending) return
    const current = pageId ? pages.data?.find((p) => p.id === pageId) : undefined
    const target = newPageTarget(getPrefs().newPageLocation, current, pages.data)
    createPage.mutate(
      { workspaceId: wsId, ...target },
      { onSuccess: (page) => navigate(`/w/${wsId}/p/${page.id}`) },
    )
  }

  return { create, isPending: createPage.isPending }
}
