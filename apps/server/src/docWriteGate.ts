import { underWriteGate } from './aclVersion'
import { assertWorkspaceWritable } from './quota/room'
import { db } from './db/index'
import type { CheckedAccess } from './aclVersion'
import { assertAgentAllowed } from './agentAccess'
import { assertPageEditable, CAP_EDIT } from './editLock'

/**
 * Write gate for document (Yjs) edits (docs/adr/1150-*). `apply` performs the in-memory edit
 * synchronously; the gate runs it inside a short transaction that holds the workspace's access row
 * FOR SHARE, so a lock change, agent block or move either commits before the edit (and is seen by
 * the re-check) or waits until the edit is in the document. Persisting (the store hook) happens
 * after the gate's commit, outside it.
 */
export type DocGate = (apply: () => void) => Promise<void>

/**
 * Gate for an edit of `pageId` by `userId` that passed its checks with `checked` (role + access
 * version). When the version or role moved on since, membership, agent block and the edit lock are
 * checked again under the gate, on the gate's connection only.
 */
export function pageEditGate(
  pageId: string,
  workspaceId: string,
  userId: string,
  checked: CheckedAccess,
  bit: number = CAP_EDIT,
): DocGate {
  return async (apply) => {
    // A full workspace or an oversized page takes no body write (LIMIT_STORAGE, docs/adr/2506-*);
    // checked on every write, not only when the access version moved. No limit → no read.
    await assertWorkspaceWritable(db, workspaceId, pageId)
    return underWriteGate(
      workspaceId,
      userId,
      checked,
      async (fresh, tx) => {
        await assertAgentAllowed(workspaceId, fresh.acl.version, tx)
        await assertPageEditable(pageId, userId, { role: fresh.role, acl: fresh.acl, exec: tx, bit })
      },
      apply,
    )
  }
}
