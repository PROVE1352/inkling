// The account block at the foot of the sidebar can be collapsed to one line (0.26). Remembered per
// person in this browser, like the shared/private section collapse (PageTree useSectionCollapse):
// localStorage, never the server. Default: expanded.

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export function accountCollapseKey(userId: string): string {
  return `inkling:sidebar-account:${userId}`
}

/** Whether the person collapsed the block in this browser (false when unknown or storage fails). */
export function readAccountCollapsed(storage: StorageLike | null | undefined, userId: string | undefined): boolean {
  if (!storage || !userId) return false
  try {
    return storage.getItem(accountCollapseKey(userId)) === '1'
  } catch {
    return false
  }
}

/** Stores the choice; expanded is the default, so it removes the key instead of storing '0'. */
export function writeAccountCollapsed(storage: StorageLike | null | undefined, userId: string | undefined, collapsed: boolean): void {
  if (!storage || !userId) return
  try {
    if (collapsed) storage.setItem(accountCollapseKey(userId), '1')
    else storage.removeItem(accountCollapseKey(userId))
  } catch {
    // ignore storage failures (private mode, quota): the block just opens again next time
  }
}
