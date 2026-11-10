import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { PushSettingsDTO, UpdatePushSettingsInput } from '@inkling/shared'
import { api } from './api'

// Web push settings and devices (docs/adr/2220-*). Kept out of api.ts like notificationsApi.ts.

export const qkPush = {
  settings: ['pushSettings'] as const,
}

export function usePushSettings() {
  return useQuery({
    networkMode: 'always', // offline: fail at once with OfflineError's "No connection" instead of waiting paused
    queryKey: qkPush.settings,
    queryFn: () => api<PushSettingsDTO>('/api/push/settings'),
  })
}

export function useUpdatePushSettings() {
  const qc = useQueryClient()
  return useMutation({
    networkMode: 'always', // offline: fail at once with OfflineError's "No connection" instead of waiting paused
    mutationFn: (input: UpdatePushSettingsInput) =>
      api<PushSettingsDTO>('/api/push/settings', { method: 'PATCH', body: JSON.stringify(input) }),
    // Optimistic: the switch flips at once; a failure refetches the server state.
    onMutate: (input) => {
      qc.setQueryData<PushSettingsDTO>(qkPush.settings, (old) => (old ? { ...old, ...input } : old))
    },
    onSuccess: (data) => qc.setQueryData(qkPush.settings, data),
    onError: () => qc.invalidateQueries({ queryKey: qkPush.settings }),
  })
}

export function useRemovePushDevice() {
  const qc = useQueryClient()
  return useMutation({
    networkMode: 'always', // offline: fail at once with OfflineError's "No connection" instead of waiting paused
    mutationFn: (id: string) => api<void>(`/api/push/devices/${id}`, { method: 'DELETE' }),
    onSettled: () => qc.invalidateQueries({ queryKey: qkPush.settings }),
  })
}

export function useTestPush() {
  return useMutation({
    networkMode: 'always', // offline: fail at once with OfflineError's "No connection" instead of waiting paused
    mutationFn: (deviceId?: string) =>
      api<{ queued: number }>('/api/push/test', { method: 'POST', body: JSON.stringify(deviceId ? { deviceId } : {}) }),
  })
}
