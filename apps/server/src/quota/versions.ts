import { limits } from '../limits'

/** The version history budget per page before 0.22, and its AI-step shares (snapshotStore.ts). */
const DEFAULT = { total: 50, perClient: 20, perPage: 30 }

/**
 * Versions kept per page (LIMIT_VERSIONS_PER_PAGE, docs/adr/2505-*), read when pruning so the setting
 * applies without a restart. A lower total scales the AI-step caps down with it (40 % per agent
 * client, 60 % over all clients, at least 1 each), so an agent writing in a loop still cannot push the
 * people's versions out. No setting → 50 / 20 / 30 as before.
 */
export function snapshotBudget(): { total: number; perClient: number; perPage: number } {
  const total = limits.versionsPerPage
  if (total == null || total >= DEFAULT.total) return DEFAULT
  return {
    total,
    perClient: Math.max(1, Math.min(DEFAULT.perClient, Math.floor(total * 0.4))),
    perPage: Math.max(1, Math.min(DEFAULT.perPage, Math.floor(total * 0.6))),
  }
}
