/**
 * Ids kept beside names in audit JSON (0.22 security fix F8, docs/adr/2535-*). A small module of its
 * own so the audit route and account deletion share it without importing each other.
 */

/**
 * Audit JSON keys that hold people's names, each with the key that holds their ids in the same
 * object (same index for lists). Written by editLock.ts (a lock's editors) and routes/workspaceAdmin.ts
 * (an agent block's member). The id keys are not shown on the audit screen (hideAuditIds below).
 */
export const AUDIT_NAME_ID_PAIRS: readonly { name: string; ids: string }[] = [
  { name: 'editors', ids: 'editorIds' },
  { name: 'user', ids: 'userId' },
]

/** The audit screen's copy of a JSON value: the id keys of AUDIT_NAME_ID_PAIRS left out. */
export function hideAuditIds(v: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!v) return v
  if (!AUDIT_NAME_ID_PAIRS.some((p) => p.ids in v)) return v
  const out = { ...v }
  for (const p of AUDIT_NAME_ID_PAIRS) delete out[p.ids]
  return out
}
