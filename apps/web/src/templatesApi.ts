import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  CreatePageFromTemplateInput,
  PageMetaDTO,
  TemplateCursorDTO,
  TemplateDTO,
  TemplatePreviewDTO,
} from '@inkling/shared'
import { api, parseError, qk } from './api'

// Template gallery data (docs/adr/0925-*): preview, instantiate (with {{input}} answers and the
// browser time zone), import and export. The list/save/delete hooks live in api.ts.

export function useTemplatePreview(wsId: string, templateId: string | null) {
  return useQuery({
    queryKey: ['templatePreview', wsId, templateId],
    queryFn: () =>
      api<{ preview: TemplatePreviewDTO }>(
        `/api/workspaces/${wsId}/templates/${encodeURIComponent(templateId!)}/preview`,
      ).then((r) => r.preview),
    enabled: !!wsId && !!templateId,
    staleTime: 60_000,
  })
}

export interface FromTemplateResult {
  page: PageMetaDTO
  pages: PageMetaDTO[]
  cursor?: TemplateCursorDTO
}

/** The browser's IANA zone, so {{date}} / {{time}} follow the creator's clock. */
function browserTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined
  } catch {
    return undefined
  }
}

export function useInstantiateTemplate(wsId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: Omit<CreatePageFromTemplateInput, 'workspaceId' | 'tz'>) =>
      api<FromTemplateResult>('/api/pages/from-template', {
        method: 'POST',
        body: JSON.stringify({ ...input, workspaceId: wsId, tz: browserTimeZone() }),
      }),
    onSuccess: (r) => {
      qc.setQueryData<PageMetaDTO[]>(qk.pages(wsId), (old) => {
        if (!old) return r.pages
        const have = new Set(old.map((p) => p.id))
        return [...old, ...r.pages.filter((p) => !have.has(p.id))]
      })
      qc.invalidateQueries({ queryKey: qk.pages(wsId) })
      // Dated templates (meeting notes, standup) and collections with dates show on the calendar.
      qc.invalidateQueries({ queryKey: ['calendar', wsId] })
    },
  })
}

export function useImportTemplate(wsId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (vars: { file: File; private?: boolean }) => {
      const fd = new FormData()
      fd.append('file', vars.file)
      const res = await fetch(
        `/api/workspaces/${wsId}/templates/import${vars.private ? '?private=1' : ''}`,
        { method: 'POST', credentials: 'same-origin', body: fd },
      )
      if (!res.ok) throw await parseError(res)
      return ((await res.json()) as { template: TemplateDTO }).template
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.templates(wsId) }),
  })
}

/** Download URL of a template file (.md for a document, .zip for a structure). */
export function templateExportUrl(wsId: string, templateId: string): string {
  return `/api/workspaces/${wsId}/templates/${encodeURIComponent(templateId)}/export`
}
