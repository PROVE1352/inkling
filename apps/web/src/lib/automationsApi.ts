// Buttons and database automations (docs/adr/2240-* .. 2245-*): REST hooks for the automation
// settings of a collection, its run log, and the webhook targets members may pick (buttons too).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { AutomationDTO, AutomationInput, AutomationRunDTO, CollectionField, WebhookTargetDTO } from '@inkling/shared'
import { api, useMemberScope } from '../api'

export const qkAutomations = {
  list: (collectionId: string) => ['automations', collectionId] as const,
  runs: (collectionId: string, automationId: string) => ['automationRuns', collectionId, automationId] as const,
  webhookTargets: (wsId: string) => ['webhookTargets', wsId] as const,
}

export type AutomationListDTO = { automations: AutomationDTO[]; canEdit: boolean }

export function useAutomations(collectionId: string, enabled = true) {
  const member = useMemberScope()
  return useQuery({
    networkMode: 'always', // offline: fail at once with OfflineError's "No connection" instead of waiting paused
    queryKey: qkAutomations.list(collectionId),
    queryFn: () => api<AutomationListDTO>(`/api/collections/${collectionId}/automations`),
    enabled: enabled && member && !!collectionId,
    staleTime: 15_000,
  })
}

export function useCreateAutomation(collectionId: string) {
  const qc = useQueryClient()
  return useMutation({
    networkMode: 'always', // offline: fail at once with OfflineError's "No connection" instead of waiting paused
    mutationFn: (input: AutomationInput) =>
      api<{ automation: AutomationDTO }>(`/api/collections/${collectionId}/automations`, {
        method: 'POST',
        body: JSON.stringify(input),
      }).then((r) => r.automation),
    onSuccess: () => qc.invalidateQueries({ queryKey: qkAutomations.list(collectionId) }),
  })
}

export function useUpdateAutomation(collectionId: string) {
  const qc = useQueryClient()
  return useMutation({
    networkMode: 'always', // offline: fail at once with OfflineError's "No connection" instead of waiting paused
    mutationFn: ({ id, patch }: { id: string; patch: Partial<AutomationInput> }) =>
      api<{ automation: AutomationDTO }>(`/api/collections/${collectionId}/automations/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }).then((r) => r.automation),
    onSuccess: (rule) => {
      qc.setQueryData<AutomationListDTO>(qkAutomations.list(collectionId), (old) =>
        old ? { ...old, automations: old.automations.map((a) => (a.id === rule.id ? rule : a)) } : old,
      )
      qc.invalidateQueries({ queryKey: qkAutomations.list(collectionId) })
    },
  })
}

export function useDeleteAutomation(collectionId: string) {
  const qc = useQueryClient()
  return useMutation({
    networkMode: 'always', // offline: fail at once with OfflineError's "No connection" instead of waiting paused
    mutationFn: (id: string) => api<void>(`/api/collections/${collectionId}/automations/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qkAutomations.list(collectionId) }),
  })
}

/** Recent runs of one rule (newest first, as the server keeps them). */
export function useAutomationRuns(collectionId: string, automationId: string | null) {
  return useQuery({
    networkMode: 'always', // offline: fail at once with OfflineError's "No connection" instead of waiting paused
    queryKey: qkAutomations.runs(collectionId, automationId ?? ''),
    queryFn: () =>
      api<{ runs: AutomationRunDTO[] }>(
        `/api/collections/${collectionId}/automations/runs?automationId=${encodeURIComponent(automationId ?? '')}&limit=50`,
      ).then((r) => r.runs),
    enabled: !!collectionId && !!automationId,
    refetchInterval: 15_000,
  })
}

/** Webhooks an owner registered, as members may pick them (no URL). Members only. */
export function useWebhookTargets(wsId: string, enabled = true) {
  const member = useMemberScope(wsId)
  return useQuery({
    networkMode: 'always', // offline: fail at once with OfflineError's "No connection" instead of waiting paused
    queryKey: qkAutomations.webhookTargets(wsId),
    queryFn: () => api<{ targets: WebhookTargetDTO[] }>(`/api/workspaces/${wsId}/webhook-targets`).then((r) => r.targets),
    enabled: enabled && member && !!wsId,
    staleTime: 60_000,
  })
}

/** Fields of a collection, definition only (the same request useCollectionDef makes). */
export function fetchCollectionFields(collectionId: string): Promise<CollectionField[]> {
  return api<{ collection: { fields: CollectionField[] } }>(`/api/pages/${collectionId}/collection?rows=0`).then(
    (r) => r.collection.fields,
  )
}
