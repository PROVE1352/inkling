import { AUTOMATION_MAX_DEPTH } from '@inkling/shared'
import type { AutomationTrigger } from '@inkling/shared'

// Pure parts of the automation queue (docs/adr/2240-*, 2242-*), kept free of the database for unit tests.

/** Does `trigger` fire for this event? (pure; `keys` = the changed field ids) */
export function triggerFires(trigger: AutomationTrigger, kind: string, keys: string[] | null | undefined): boolean {
  if (trigger.type === 'rowAdded') return kind === 'page_added'
  if (trigger.type === 'fieldChanged') return kind === 'page_props' && !!keys && keys.includes(trigger.fieldId)
  return false
}

/** Depth and chain of the runs a write starts. A depth past AUTOMATION_MAX_DEPTH is still queued and recorded as skipped. */
export function nextMarker(actor: { auto?: { ruleId: string; depth: number; chain: string[] } } | null | undefined): { depth: number; chain: string[] } {
  const a = actor?.auto
  if (!a) return { depth: 0, chain: [] }
  return { depth: a.depth + 1, chain: [...new Set([...a.chain, a.ruleId])].slice(-(AUTOMATION_MAX_DEPTH + 2)) }
}
