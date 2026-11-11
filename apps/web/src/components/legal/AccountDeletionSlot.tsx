/**
 * Where the consent screen offers to delete the account instead of agreeing (docs/adr/2519-*). A
 * person who has not agreed cannot reach Settings (every app screen waits for the consent), so the
 * deletion has to happen on the consent screen itself; DELETE /api/me and GET /api/me/delete-preview
 * are exempt from the consent gate for that reason.
 *
 * The deletion screen is piece B's `components/account/DeleteAccount.tsx`. Until the pieces are merged
 * this slot is off and the consent screen shows no deletion button. Merge: set the flag to true and
 * return that component here.
 */
export const ACCOUNT_DELETION_READY = false

export function AccountDeletionSlot() {
  return null
}
