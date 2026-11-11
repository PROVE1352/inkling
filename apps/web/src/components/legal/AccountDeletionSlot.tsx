import { DeleteAccountModal } from '../account/DeleteAccount'

/**
 * Where the consent screen offers to delete the account instead of agreeing (docs/adr/2519-*). A
 * person who has not agreed cannot reach Settings (every app screen waits for the consent), so the
 * deletion happens on the consent screen itself; DELETE /api/me and GET /api/me/delete-preview are
 * exempt from the consent gate for that reason.
 *
 * The dialog is piece B's (`components/account/DeleteAccount.tsx`), wired at the 0.22 merge: the same
 * list of what goes and what stays, the password or a recent sign-in, the typed confirmation, without
 * the export buttons (export waits for the consent).
 */
export const ACCOUNT_DELETION_READY = true

export function AccountDeletionSlot({ onClose }: { onClose: () => void }) {
  return <DeleteAccountModal onClose={onClose} beforeConsent />
}
