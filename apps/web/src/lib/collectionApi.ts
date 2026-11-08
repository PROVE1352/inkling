// React Query hooks for the collection extensions (relations, batch rows, covers,
// sheets sync, iCal). Kept out of api.ts so parallel work on the shared wrapper stays small.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  BatchCreateRowsInput,
  BatchUpdateRowsInput,
  IcalIssueDTO,
  IcalStatusDTO,
  RowDTO,
  RowOptionsDTO,
  SheetSyncDTO,
  SheetSyncInput,
} from '@inkling/shared'
import { BATCH_MAX_ROWS } from '@inkling/shared'
import { api, qk, useAuthMode, useMemberScope } from '../api'

export const qkx = {
  rowOptions: (pageId: string, q: string) => ['collectionRowOptions', pageId, q] as const,
  covers: (pageId: string) => ['collectionCovers', pageId] as const,
  sheetSync: (pageId: string) => ['sheetSync', pageId] as const,
  ical: ['icalStatus'] as const,
}

/** Rows of a (relation target) collection for the picker — server applies visibility. */
export function useRowOptions(pageId: string | undefined, q: string, enabled = true) {
  const member = useMemberScope()
  return useQuery({
    queryKey: qkx.rowOptions(pageId ?? '', q),
    queryFn: () =>
      api<RowOptionsDTO>(
        `/api/pages/${pageId}/collection/row-options?limit=50${q ? `&q=${encodeURIComponent(q)}` : ''}`,
      ),
    enabled: !!pageId && enabled && member,
    staleTime: 15_000,
    retry: false,
  })
}

/** Gallery "first image" covers: { rowId: '/files/<id>' }. */
export function useCovers(pageId: string, enabled: boolean) {
  const member = useMemberScope()
  return useQuery({
    queryKey: qkx.covers(pageId),
    queryFn: () =>
      api<{ covers: Record<string, string> }>(`/api/pages/${pageId}/collection/covers`).then(
        (r) => r.covers,
      ),
    enabled: enabled && member,
    staleTime: 60_000,
  })
}

/** Insert many rows, chunked by BATCH_MAX_ROWS and ~4 MB of JSON. Reports progress. */
export async function batchCreateRows(
  pageId: string,
  rows: BatchCreateRowsInput['rows'],
  onProgress?: (done: number, total: number) => void,
): Promise<RowDTO[]> {
  const out: RowDTO[] = []
  let i = 0
  while (i < rows.length) {
    const part: BatchCreateRowsInput['rows'] = []
    let bytes = 0
    while (i < rows.length && part.length < BATCH_MAX_ROWS) {
      const size = JSON.stringify(rows[i]).length
      if (part.length > 0 && bytes + size > 4 * 1024 * 1024) break
      part.push(rows[i])
      bytes += size
      i++
    }
    const res = await api<{ rows: RowDTO[] }>(`/api/pages/${pageId}/collection/rows/batch`, {
      method: 'POST',
      body: JSON.stringify({ rows: part }),
    })
    out.push(...res.rows)
    onProgress?.(i, rows.length)
  }
  return out
}

export async function batchUpdateRows(
  pageId: string,
  rows: BatchUpdateRowsInput['rows'],
): Promise<number> {
  let updated = 0
  for (let i = 0; i < rows.length; i += BATCH_MAX_ROWS) {
    const res = await api<{ updated: number }>(`/api/pages/${pageId}/collection/rows/batch`, {
      method: 'PATCH',
      body: JSON.stringify({ rows: rows.slice(i, i + BATCH_MAX_ROWS) }),
    })
    updated += res.updated
  }
  return updated
}

export function useInvalidateCollection(pageId: string) {
  const qc = useQueryClient()
  return () => {
    qc.invalidateQueries({ queryKey: qk.collection(pageId) })
    qc.invalidateQueries({ queryKey: ['pages'] })
  }
}

// ---------------------------------------------------------------------------
// Experimental flags (server exposes enabled names on /auth/mode as `experimental`)
// ---------------------------------------------------------------------------

export function useExperimental(name: string): boolean {
  const mode = useAuthMode()
  const list = (mode.data as { experimental?: string[] } | undefined)?.experimental
  return Array.isArray(list) && list.includes(name)
}

// ---------------------------------------------------------------------------
// Google Sheets read sync (experimental `sheets-sync`)
// ---------------------------------------------------------------------------

export function useSheetSync(pageId: string, enabled: boolean) {
  return useQuery({
    queryKey: qkx.sheetSync(pageId),
    queryFn: () =>
      api<{ sync: SheetSyncDTO | null }>(`/api/pages/${pageId}/collection/sheet-sync`).then(
        (r) => r.sync,
      ),
    enabled,
  })
}

export function useSaveSheetSync(pageId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: SheetSyncInput) =>
      api<{ sync: SheetSyncDTO }>(`/api/pages/${pageId}/collection/sheet-sync`, {
        method: 'PUT',
        body: JSON.stringify(input),
      }).then((r) => r.sync),
    onSuccess: (sync) => qc.setQueryData(qkx.sheetSync(pageId), sync),
  })
}

export function useDeleteSheetSync(pageId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () =>
      api<void>(`/api/pages/${pageId}/collection/sheet-sync`, { method: 'DELETE' }),
    onSuccess: () => qc.setQueryData(qkx.sheetSync(pageId), null),
  })
}

export function useRunSheetSync(pageId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () =>
      api<{ sync: SheetSyncDTO }>(`/api/pages/${pageId}/collection/sheet-sync/run`, {
        method: 'POST',
      }).then((r) => r.sync),
    onSuccess: (sync) => {
      qc.setQueryData(qkx.sheetSync(pageId), sync)
      qc.invalidateQueries({ queryKey: qk.collection(pageId) })
    },
    onError: () => qc.invalidateQueries({ queryKey: qkx.sheetSync(pageId) }),
  })
}

// ---------------------------------------------------------------------------
// iCal subscription
// ---------------------------------------------------------------------------

export function useIcalStatus() {
  return useQuery({
    queryKey: qkx.ical,
    queryFn: () => api<{ ical: IcalStatusDTO }>('/api/me/ical').then((r) => r.ical),
  })
}

export function useIssueIcal() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () =>
      api<{ ical: IcalIssueDTO }>('/api/me/ical', { method: 'POST' }).then((r) => r.ical),
    onSuccess: (ical) =>
      qc.setQueryData<IcalStatusDTO>(qkx.ical, {
        active: true,
        createdAt: ical.createdAt,
        lastUsedAt: null,
      }),
  })
}

export function useRevokeIcal() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => api<void>('/api/me/ical', { method: 'DELETE' }),
    onSuccess: () =>
      qc.setQueryData<IcalStatusDTO>(qkx.ical, { active: false, createdAt: null, lastUsedAt: null }),
  })
}

/** Collection definition only (fields + views, no rows) — relation/rollup pickers. */
export function useCollectionDef(pageId: string | undefined) {
  const member = useMemberScope()
  return useQuery({
    queryKey: ['collectionDef', pageId ?? ''] as const,
    queryFn: () =>
      api<{ collection: import('@inkling/shared').CollectionDTO }>(
        `/api/pages/${pageId}/collection?rows=0`,
      ).then((r) => r.collection),
    enabled: !!pageId && member,
    staleTime: 30_000,
    retry: false,
  })
}
