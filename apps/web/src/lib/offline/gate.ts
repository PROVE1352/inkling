// The sync gate (docs/adr/2201-*): the provider's `token` callback.
//
// On every (re)connect Hocuspocus's provider awaits `token()` before it sends Auth and SyncStep1, and
// it answers the server's SyncStep1 with everything the local doc has. So the only place to decide
// whether a device copy (or a tab that typed through an outage) may merge is before Auth: here. A
// document that is still empty has nothing to merge and passes without a request. Otherwise the gate
// asks /sync-check, runs decide(), and either returns (merge) or throws, which makes the provider give
// the document up (authenticationFailed); the caller then reopens it from the server.
//
// Updates typed while the check runs are sent before Auth; the server queues them for that document
// on that socket and processes them only after an Auth that never comes when the gate throws. The
// caller never authenticates that name on the same socket again (collabSocket marks it denied).
import * as Y from 'yjs'
import { decide, type Decision, type ServerCheck } from './decide'
import type { PageCopy } from './pageCopy'

/** Thrown by `check` for an answer that says nothing about access (network, 5xx, 401, 2FA). */
export class CheckUnavailable extends Error {}

export const GATE_RETRIES = 3

export function docIsEmpty(doc: Y.Doc): boolean {
  return Y.encodeStateVector(doc).length <= 1
}

export function createGate(opts: {
  doc: Y.Doc
  copy: Pick<PageCopy, 'pending' | 'gen' | 'localClients'>
  check: () => Promise<ServerCheck>
  /** carries out a non-merge decision (or 'retry') before the provider gives the document up */
  onBlocked: (d: Decision | { kind: 'retry' }) => Promise<void> | void
  sleep?: (ms: number) => Promise<void>
}): () => Promise<string> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  return async () => {
    if (docIsEmpty(opts.doc)) return 'cookie'
    let server: ServerCheck | null = null
    for (let attempt = 0; attempt < GATE_RETRIES; attempt++) {
      try {
        server = await opts.check()
        break
      } catch (err) {
        if (!(err instanceof CheckUnavailable)) throw err
        if (attempt < GATE_RETRIES - 1) await sleep(1000 * 2 ** attempt)
      }
    }
    if (!server) {
      await opts.onBlocked({ kind: 'retry' })
      throw new Error('offline-gate:retry')
    }
    const d = decide(
      {
        pending: opts.copy.pending(),
        gen: opts.copy.gen(),
        sv: Y.decodeStateVector(Y.encodeStateVector(opts.doc)),
        localClients: opts.copy.localClients(),
      },
      server,
      Y.decodeStateVector,
    )
    if (d.kind === 'merge') return 'cookie'
    await opts.onBlocked(d)
    throw new Error(`offline-gate:${d.kind}`)
  }
}

/** GET /api/pages/:id/sync-check as a ServerCheck; CheckUnavailable for anything that is not an answer about access. */
export async function fetchSyncCheck(pageId: string, fetchImpl: typeof fetch = fetch): Promise<ServerCheck> {
  let res: Response
  try {
    res = await fetchImpl(`/api/pages/${encodeURIComponent(pageId)}/sync-check`, { credentials: 'same-origin', cache: 'no-store' })
  } catch {
    throw new CheckUnavailable('network')
  }
  if (res.status === 403 || res.status === 404) {
    // 403 TWO_FACTOR_REQUIRED is about the session, not the page: not a reason to delete anything
    const body = (await res.json().catch(() => null)) as { error?: { code?: string } } | null
    if (body?.error?.code === 'TWO_FACTOR_REQUIRED') throw new CheckUnavailable('two-factor')
    return { kind: 'gone' }
  }
  if (!res.ok) throw new CheckUnavailable(`status ${res.status}`)
  const j = (await res.json()) as { gen: number; canEdit: boolean; trashed: boolean; sv: string }
  const bin = atob(j.sv)
  const sv = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) sv[i] = bin.charCodeAt(i)
  return { kind: 'ok', gen: j.gen, canEdit: j.canEdit, trashed: j.trashed, sv }
}
