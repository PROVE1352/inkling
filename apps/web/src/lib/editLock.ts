import type { PageLockDTO, PageMetaDTO } from '@inkling/shared'
import { t } from '../i18n'

// Client-side helpers for the page edit lock (docs/adr/0970-*).
// The page list only marks pages that carry their OWN lock (`editLocked`); a lock governs the
// page and its whole subtree, so the nearest locked ancestor-or-self decides.

/** Nearest page (self first, then ancestors) that carries its own lock, or null. */
export function lockRootOf(pages: readonly PageMetaDTO[] | undefined, pageId: string | undefined): PageMetaDTO | null {
  if (!pages || !pageId) return null
  const byId = new Map(pages.map((p) => [p.id, p]))
  const seen = new Set<string>()
  let cur = byId.get(pageId)
  while (cur && !seen.has(cur.id)) {
    if (cur.editLocked) return cur
    seen.add(cur.id)
    cur = cur.parentId ? byId.get(cur.parentId) : undefined
  }
  return null
}

/** "Editable by: owner, editors, workspace owners and admins" (or "Everyone can edit"). */
export function editableByLine(lock: PageLockDTO): string {
  if (lock.people === 'everyone') return t('lock.everyoneEdits')
  const names: string[] = []
  if (lock.owner) names.push(lock.owner.name)
  for (const e of lock.editors) if (e.id !== lock.owner?.id) names.push(e.name)
  names.push(t('lock.ownersAndAdmins'))
  return t('lock.editableBy', { names: names.join(', ') })
}

/** "AI agents: read only" / "comment only" / "suggestions only", or null when agents follow their person. */
export function agentRuleLine(lock: PageLockDTO): string | null {
  if (lock.agents === 'read') return t('lock.agentRule.read')
  if (lock.agents === 'suggest') return t('lock.agentRule.suggest')
  if (lock.agents === 'auto') return t('lock.agentRule.auto')
  if (lock.agents === 'direct') return t('lock.agentRule.direct')
  if (lock.agents === 'comment') return t('lock.agentRule.comment')
  return null
}
