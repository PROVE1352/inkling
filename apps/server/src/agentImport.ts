import { currentConnectionKey } from './agentAccess'
import { assertAgentUploadsAllowed, assertDailyUploadBudget } from './agentUploads'
import type { AgentImportRules } from './md/importer'
import { importLimits } from './md/importLimits'
import { AGENT_UPLOAD_MAX_BYTES, agentUploadMime } from './uploadCheck'

/**
 * Imports through a connection (MCP import_zip, a bearer POST /workspaces/:id/import or
 * /import-folder; docs/adr/2162-*). The Markdown of an import is what import_folder already sends;
 * its attachments are uploads, so the 0.16 rules for upload_file apply to each of them:
 * the AI upload switch (server AGENT_UPLOADS and the workspace setting) and the daily budget, checked
 * once before the first attachment; the per-file cap (AGENT_UPLOAD_MAX_MB) and the server's type
 * decision per attachment (refused ones are skipped and reported, the pages still import); the
 * stored files carry the connection in files.uploaded_via, so they count toward the budget.
 */
export function agentImportRules(workspaceId: string, userId: string): AgentImportRules {
  return {
    via: currentConnectionKey() ?? 'bearer',
    maxFileBytes: AGENT_UPLOAD_MAX_BYTES,
    typeOf: (name, bytes) => agentUploadMime(name, bytes),
    beforeAttachments: async () => {
      await assertAgentUploadsAllowed(workspaceId)
      await assertDailyUploadBudget(userId)
    },
  }
}

/**
 * The one zip a connection sends is itself an upload: at most AGENT_UPLOAD_MAX_MB, and never above the
 * import route's own cap (IMPORT_MAX_UPLOAD_MB), so the tool's precheck and the route agree.
 */
export const AGENT_IMPORT_MAX_ZIP_BYTES = Math.min(AGENT_UPLOAD_MAX_BYTES, importLimits.maxUploadBytes)
