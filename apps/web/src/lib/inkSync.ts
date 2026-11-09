// Ink layer sync rules — kept free of React so they can be tested on their own.
// See docs/adr/0815-* (412 merge), 0854-* (single in-flight save) and 1340-* (no save before load).
import type { InkStroke } from '@inkling/shared'

/** Server version the local strokes are based on: `updatedAt` (null = no ink yet) and its stroke ids. */
export interface InkBase {
  updatedAt: string | null
  ids: Set<string>
}

/**
 * First load of a page's ink. Strokes drawn while the GET was still on its way are kept on top of the
 * server's list instead of being replaced by it.
 */
export function mergeLoaded(server: InkStroke[], local: InkStroke[]): InkStroke[] {
  if (local.length === 0) return server
  const serverIds = new Set(server.map((s) => s.id))
  return [...server, ...local.filter((s) => !serverIds.has(s.id))]
}

/**
 * 412 INK_CONFLICT merge: the server's strokes, minus those that were in the base and were erased
 * here, plus strokes added here that the server does not have.
 */
export function mergeConflict(server: InkStroke[], local: InkStroke[], base: Set<string>): InkStroke[] {
  const localIds = new Set(local.map((s) => s.id))
  const serverIds = new Set(server.map((s) => s.id))
  return [
    ...server.filter((s) => localIds.has(s.id) || !base.has(s.id)),
    ...local.filter((s) => !base.has(s.id) && !serverIds.has(s.id)),
  ]
}

/**
 * A save may go out only once the layer knows which server version it is editing. Without a base the
 * PUT would carry no `expectedUpdatedAt` and replace the page's ink with whatever is local (often
 * nothing), so the save waits for the load instead.
 */
export function canSaveInk(base: InkBase | undefined): base is InkBase {
  return base !== undefined
}
