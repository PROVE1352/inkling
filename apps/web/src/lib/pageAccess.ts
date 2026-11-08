import {
  GUEST_ACCESS_LEVELS,
  PAGE_ACCESS_LEVELS,
  levelRank,
  type PageAccessLevel,
  type WorkspaceAccessRole,
} from '@inkling/shared'
import { t, type TKey } from '../i18n'

// Page access levels and guest mode on the client (docs/adr/1250-* .. 1253-*). The server decides
// every rule; these helpers only keep the UI from offering what it would refuse.

const LEVEL_KEYS: Record<PageAccessLevel, TKey> = {
  view: 'access.level.view',
  comment: 'access.level.comment',
  edit: 'access.level.edit',
  full: 'access.level.full',
}

export function levelLabel(level: PageAccessLevel): string {
  return t(LEVEL_KEYS[level])
}

export function isGuestRole(role: WorkspaceAccessRole | null | undefined): boolean {
  return role === 'guest'
}

/**
 * Levels the caller can hand out to someone: never above their own level (owners and admins
 * have `full`), and a guest never gets `full`.
 */
export function grantableLevels(myLevel: PageAccessLevel, targetIsGuest: boolean): PageAccessLevel[] {
  const pool: readonly PageAccessLevel[] = targetIsGuest ? GUEST_ACCESS_LEVELS : PAGE_ACCESS_LEVELS
  return pool.filter((l) => levelRank(l) <= levelRank(myLevel))
}

/** Default level when adding someone: edit for members, view for guests, capped by what the caller has. */
export function defaultLevelFor(myLevel: PageAccessLevel, targetIsGuest: boolean): PageAccessLevel {
  const want: PageAccessLevel = targetIsGuest ? 'view' : 'edit'
  const options = grantableLevels(myLevel, targetIsGuest)
  return options.includes(want) ? want : (options[options.length - 1] ?? 'view')
}

/** Rough email check for the "invite by email" row (the server validates for real). */
export function looksLikeEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim())
}
