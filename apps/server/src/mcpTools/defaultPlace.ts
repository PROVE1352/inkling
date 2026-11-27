import { shortId } from './shortIds'
import { cleanText } from './trust'

/**
 * The line a create tool adds when the page went under the workspace's default place for agents' new
 * pages (docs/adr/2592-*). The server sends `defaultParent` only when this connection may see and write
 * that page, so the title never reaches a connection that could not have read it.
 */
export interface DefaultParentDTO {
  id: string
  title: string
}

export function placedText(dp: DefaultParentDTO | undefined | null): string | null {
  if (!dp) return null
  return `placed under "${cleanText(dp.title || 'Untitled')}" (${shortId(dp.id)}), this workspace's default place for new agent pages; pass parentId to choose, or move_page(parentId=null) for the top level`
}

/** One sentence for the descriptions of tools that create pages without a parentId. */
export const DEFAULT_PLACE_NOTE = " Without parentId it may go under the workspace's default page for agents (the answer says so)."
