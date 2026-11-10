import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  SlackIntegrationDTO,
  SlackLinkDTO,
  SlackLinkPreviewDTO,
  SlackSettingsInput,
  SlackSettingsResponse,
  SlackTestResultDTO,
} from '@inkling/shared'
import { api } from './api'

// Slack app per workspace: settings, test, disconnect, linked accounts, and the one-time account
// link page (docs/adr/1800-* .. 1806-*). Kept out of api.ts like apiTokens.ts / laterApi.ts.
// The bot token and signing secret only ever travel client → server (PUT); no response carries them.

const send = (method: string, data?: unknown): RequestInit =>
  data === undefined ? { method } : { method, body: JSON.stringify(data) }

export const qkSlack = {
  all: ['slack'] as const,
  settings: (wsId: string) => ['slack', wsId, 'settings'] as const,
  links: (wsId: string) => ['slack', wsId, 'links'] as const,
  linkPreview: (code: string) => ['slack', 'linkPreview', code] as const,
}

const base = (wsId: string) => `/api/workspaces/${wsId}/slack`

/** GET /api/workspaces/:id/slack (owners; 403 otherwise). */
export function useSlackSettings(wsId: string, enabled = true) {
  return useQuery({
    queryKey: qkSlack.settings(wsId),
    queryFn: () => api<SlackSettingsResponse>(base(wsId)),
    enabled: enabled && !!wsId,
  })
}

/** PUT: saves the connection. Omitted botToken / signingSecret keep the stored ones. */
export function useSaveSlackSettings(wsId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: SlackSettingsInput) =>
      api<{ integration: SlackIntegrationDTO }>(base(wsId), send('PUT', input)),
    onSuccess: (r) => {
      qc.setQueryData<SlackSettingsResponse>(qkSlack.settings(wsId), (old) =>
        old ? { ...old, integration: r.integration } : old,
      )
      void qc.invalidateQueries({ queryKey: qkSlack.settings(wsId) })
      // Saving may link members by email right away.
      void qc.invalidateQueries({ queryKey: qkSlack.links(wsId) })
    },
  })
}

/** DELETE: disconnects and removes the linked accounts. */
export function useDisconnectSlack(wsId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => api<{ ok: true }>(base(wsId), send('DELETE')),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qkSlack.settings(wsId) })
      void qc.invalidateQueries({ queryKey: qkSlack.links(wsId) })
    },
  })
}

/** POST …/test: posts a test message to the channel; a pass clears blockedReason. */
export function useTestSlack(wsId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => api<SlackTestResultDTO>(`${base(wsId)}/test`, send('POST')),
    onSettled: () => qc.invalidateQueries({ queryKey: qkSlack.settings(wsId) }),
  })
}

export function useSlackLinks(wsId: string, enabled = true) {
  return useQuery({
    queryKey: qkSlack.links(wsId),
    queryFn: () => api<{ links: SlackLinkDTO[] }>(`${base(wsId)}/links`).then((r) => r.links),
    enabled: enabled && !!wsId,
  })
}

export function useRemoveSlackLink(wsId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (userId: string) =>
      api<{ ok: true }>(`${base(wsId)}/links/${encodeURIComponent(userId)}`, send('DELETE')),
    onSuccess: () => qc.invalidateQueries({ queryKey: qkSlack.links(wsId) }),
  })
}

/** POST /api/slack/link/preview: what a one-time code would link (404 NOT_FOUND when unknown/expired/used). */
export function useSlackLinkPreview(code: string | null, enabled = true) {
  return useQuery({
    queryKey: qkSlack.linkPreview(code ?? ''),
    queryFn: () => api<SlackLinkPreviewDTO>('/api/slack/link/preview', send('POST', { code })),
    enabled: enabled && !!code,
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
  })
}

/** POST /api/slack/link/confirm (403 when the signed-in user is not a member of that workspace). */
export function useConfirmSlackLink() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (code: string) =>
      api<{ ok: true; workspaceId: string }>('/api/slack/link/confirm', send('POST', { code })),
    onSuccess: (r) => qc.invalidateQueries({ queryKey: qkSlack.links(r.workspaceId) }),
  })
}
