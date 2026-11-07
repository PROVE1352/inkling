import { t } from '../i18n'
import { getPrefs } from './prefs'

// Global confirm-dialog store. Places with no common anchor (tree context menu, ⌘⌫, multi-delete)
// need the same dialog, so this is a module store instead of ConfirmPopover (an inline wrapper
// around the trigger). Rendered by components/ConfirmDialog.tsx (mounted once in AppLayout).
// Same structure as toast.ts.

export type ConfirmRequest = {
  id: number
  message: string
  confirmLabel: string
  resolve: (ok: boolean) => void
}

let current: ConfirmRequest | null = null
let seq = 0
const listeners = new Set<() => void>()

function emit() {
  for (const l of listeners) l()
}

export function subscribeConfirm(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

export function getConfirm(): ConfirmRequest | null {
  return current
}

export function askConfirm(message: string, confirmLabel: string = t('common.delete')): Promise<boolean> {
  // Resolve any request already showing as cancelled and replace it with the new one
  current?.resolve(false)
  return new Promise((resolve) => {
    const id = ++seq
    current = {
      id,
      message,
      confirmLabel,
      resolve: (ok) => {
        if (current?.id === id) {
          current = null
          emit()
        }
        resolve(ok)
      },
    }
    emit()
  })
}

// Asks only when the "Confirm before deleting" setting is on. Otherwise proceeds at once
// (the default behaviour: move to trash + an undo toast).
export function confirmTrash(message: string): Promise<boolean> {
  if (!getPrefs().confirmDelete) return Promise.resolve(true)
  return askConfirm(message, t('confirm.moveToTrash'))
}
