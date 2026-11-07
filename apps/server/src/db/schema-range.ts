import { text, uuid } from 'drizzle-orm/pg-core'

/**
 * Connection range columns (docs/adr/1200-*), shared by oauth_codes, oauth_grants and api_tokens.
 *   range_kind           null or 'all' = everything the owner can see; 'workspaces'; 'subtree'
 *   range_workspace_ids  the workspaces of a 'workspaces' range
 *   range_page_id        the root page of a 'subtree' range (no foreign key on purpose: a deleted
 *                        root must leave the connection seeing nothing, never everything)
 */
export function rangeColumns() {
  return {
    rangeKind: text('range_kind'),
    rangeWorkspaceIds: uuid('range_workspace_ids').array(),
    rangePageId: uuid('range_page_id'),
  }
}
