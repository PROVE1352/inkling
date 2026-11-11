// Database row templates (docs/adr/1180-1184): list/CRUD hooks and the single-row create that
// every "new row" button uses (table, gallery, board column, calendar day).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { DOC_SCHEMA_VERSION } from '@inkling/shared'
import type {
  CreateRowInput,
  CreateRowResultDTO,
  CreateRowTemplateInput,
  PageMetaDTO,
  RowTemplateBodyDTO,
  RowTemplateDTO,
  RowTemplateListDTO,
  UpdateRowTemplateInput,
} from '@inkling/shared'
import { api, qk, useMemberScope } from '../api'

export const qkRowTemplates = (collectionId: string) => ['rowTemplates', collectionId] as const

function browserTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined
  } catch {
    return undefined
  }
}

export function useRowTemplates(collectionId: string) {
  const member = useMemberScope()
  return useQuery({
    queryKey: qkRowTemplates(collectionId),
    queryFn: () => api<RowTemplateListDTO>(`/api/pages/${collectionId}/collection/row-templates`),
    enabled: member,
    staleTime: 30_000,
  })
}

/** One template with its body (base64 Yjs update). Not cached: the editor owns it while open. */
export function fetchRowTemplate(id: string): Promise<RowTemplateBodyDTO> {
  return api<RowTemplateBodyDTO>(`/api/collection-row-templates/${id}`)
}

export function useCreateRowTemplate(collectionId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateRowTemplateInput) =>
      api<{ template: RowTemplateDTO }>(`/api/pages/${collectionId}/collection/row-templates`, {
        method: 'POST',
        body: JSON.stringify(input),
      }).then((r) => r.template),
    onSuccess: () => qc.invalidateQueries({ queryKey: qkRowTemplates(collectionId) }),
  })
}

export function updateRowTemplate(id: string, input: UpdateRowTemplateInput): Promise<RowTemplateDTO> {
  return api<{ template: RowTemplateDTO }>(`/api/collection-row-templates/${id}`, {
    method: 'PATCH',
    // a body update says which document schema made it (docs/adr/2425-*)
    body: JSON.stringify(input.update ? { ...input, schema: DOC_SCHEMA_VERSION } : input),
  }).then((r) => r.template)
}

export function useUpdateRowTemplate(collectionId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateRowTemplateInput }) => updateRowTemplate(id, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: qkRowTemplates(collectionId) }),
  })
}

export function useDeleteRowTemplate(collectionId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api<void>(`/api/collection-row-templates/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qkRowTemplates(collectionId) }),
  })
}

/**
 * New row. `template` undefined → the collection's default, null → empty row. `props` (board
 * column, calendar day) are applied over the template's defaults in the same request.
 */
export function useCreateRow(wsId: string, collectionId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: Omit<CreateRowInput, 'tz'>) =>
      api<CreateRowResultDTO>(`/api/pages/${collectionId}/collection/rows`, {
        method: 'POST',
        body: JSON.stringify({ ...input, tz: browserTimeZone() }),
      }),
    onSuccess: (r) => {
      // Seed the page list so opening the new row right away works (like useCreatePage).
      const { props: _props, ...meta } = r.row
      void _props
      qc.setQueryData<PageMetaDTO[]>(qk.pages(wsId), (old) =>
        old ? (old.some((p) => p.id === meta.id) ? old : [...old, meta as PageMetaDTO]) : old,
      )
      qc.invalidateQueries({ queryKey: qk.collection(collectionId) })
      qc.invalidateQueries({ queryKey: qk.pages(wsId) })
    },
  })
}

// ---- Yjs body helpers (no dependency: btoa/atob over bytes) ----

export function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(s)
}

export function fromBase64(b64: string): Uint8Array {
  const s = atob(b64)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}
