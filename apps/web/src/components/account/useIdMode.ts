import { useAuthMode } from '../../api'

/** LOGIN_ID_MODE=username (docs/adr/2512-*): identifiers are sign-in IDs, never shown as "email". */
export function useIdMode(): boolean {
  return useAuthMode().data?.loginId === 'username'
}
