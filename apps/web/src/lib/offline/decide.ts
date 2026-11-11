// Whether a device copy may sync with the server (docs/adr/2201-*). Pure: no IndexedDB, no socket.
//
// Every server write edits the page's one Y.Doc, so merging a device copy can neither revive text the
// server deleted nor double the body. What a blind merge can do is lose edits without a word: an edit
// made offline inside a block that a version restore, an AI-edit revert, a split or a full rewrite
// removed lands in a deleted block. Those writes bump the page's generation; unsent edits based on an
// older generation are kept as a recovery item instead. A copy holding ops the server no longer has
// (a database restored from a backup, a crash that lost acknowledged but unstored edits) is kept as a
// recovery item too: merging it would quietly push newer content back over the restored state.
// Unsent edits made by an app older than the page's newest node type (docs/adr/2425-*) are kept too:
// that app's editor deleted the nodes it did not know, and merging would send those deletions.

/** What GET /api/pages/:id/sync-check answered (or why it did not). */
export type ServerCheck =
  /** `needs`: the document schema the page needs (docs/adr/2425-*), only when the copy's edits are older than this build */
  | { kind: 'ok'; gen: number; canEdit: boolean; trashed: boolean; sv: Uint8Array; needs?: number }
  /** 403 / 404: no access any more (member removed, page made private, guest row gone, purged) */
  | { kind: 'gone' }

export type LocalCopy = {
  /** unsent local edits exist (this tab's or ones stored on the device) */
  pending: boolean
  /** generation the copy descends from (null: never learned, e.g. an older server) */
  gen: number | null
  /** state vector of the local document */
  sv: Map<number, number>
  /** clientIDs whose ops may legitimately be missing on the server (they made the unsent edits) */
  localClients: ReadonlySet<number>
  /** document schema of the oldest app that made the unsent edits (docs/adr/2425-*); 1 for copies of 0.19 and older */
  schema?: number
}

export type Decision =
  /** sync as usual: the copy's unsent edits (if any) go to the server */
  | { kind: 'merge' }
  /** do not sync this document: keep its unsent edits as a recovery item, start over from the server */
  | { kind: 'recover'; reason: 'replaced' | 'restored' | 'readonly' | 'trashed' | 'outdated' }
  /** do not sync: nothing unsent and the page is in the trash — drop the copy, start over */
  | { kind: 'reset'; reason: 'trashed' }
  /** no access: delete the copy (unsent edits included, ADR 2203) */
  | { kind: 'forget' }

/** True when the server has every op of `local` except those of `skip` (same history). */
export function serverHasHistory(server: Map<number, number>, local: Map<number, number>, skip: ReadonlySet<number>): boolean {
  for (const [client, clock] of local) {
    if (skip.has(client)) continue
    if ((server.get(client) ?? 0) < clock) return false
  }
  return true
}

export function decide(local: LocalCopy, server: ServerCheck, decodeSv: (sv: Uint8Array) => Map<number, number>): Decision {
  if (server.kind === 'gone') return { kind: 'forget' }
  if (server.trashed) return local.pending ? { kind: 'recover', reason: 'trashed' } : { kind: 'reset', reason: 'trashed' }
  // Even without unsent marks: those ops were acknowledged once and the server lost them since.
  if (!serverHasHistory(decodeSv(server.sv), local.sv, local.localClients)) return { kind: 'recover', reason: 'replaced' }
  if (!local.pending) return { kind: 'merge' }
  // Made by an app that did not know every node type now on the page (docs/adr/2425-*): its editor
  // deleted what it could not show, and those deletions are among the unsent edits.
  if (server.needs !== undefined && (local.schema ?? 1) < server.needs) return { kind: 'recover', reason: 'outdated' }
  // Unknown generation on either side (older server, copy never synced): the history check above is all we have.
  if (local.gen !== null && server.gen !== local.gen) return { kind: 'recover', reason: 'restored' }
  // The server would drop these edits (SyncStatus false) on every reconnect: stop and show them instead.
  if (!server.canEdit) return { kind: 'recover', reason: 'readonly' }
  return { kind: 'merge' }
}
