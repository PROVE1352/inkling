// Plugin API v0 — React Query hooks and REST helpers (kept out of the shared src/api.ts).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, useAuthMode } from '../api'
import type { PluginPermission } from './protocol'

export type PluginCommandInfo = { id: string; title: string }
export type PluginBlockInfo = {
  type: string
  title: string
  description?: string
  defaultData?: Record<string, unknown>
  height?: number
}

/** GET /api/plugins item — an approved, enabled plugin whose files match the approval. */
export type PluginInfo = {
  id: string
  name: string
  version: string
  description: string | null
  /** effective permissions (admin-approved ∩ manifest-requested) */
  permissions: PluginPermission[]
  commands: PluginCommandInfo[]
  blocks: PluginBlockInfo[]
  /** /api/plugin-frame/<id>/<hash>/index.html */
  frameUrl: string
}

export type AdminPluginStatus =
  | 'invalid'
  | 'missing'
  | 'not-approved'
  | 'needs-reapproval'
  | 'enabled'
  | 'disabled'

export type AdminPluginDTO = {
  id: string
  status: AdminPluginStatus
  error: string | null
  manifest: {
    id: string
    name: string
    version: string
    minAppVersion: string
    description?: string
    author?: string
    entry: string
    permissions: PluginPermission[]
    commands?: PluginCommandInfo[]
    blocks?: PluginBlockInfo[]
  } | null
  hash: string | null
  install: {
    enabled: boolean
    approvedVersion: string | null
    approvedPermissions: string[]
    approvedHash: string | null
    approvedAt: string | null
    approvedByName: string | null
  } | null
}

export type AdminPluginsResponse = {
  pluginsDir: string
  appVersion: string
  plugins: AdminPluginDTO[]
}

export const pluginKeys = {
  list: ['plugins'] as const,
  admin: ['admin', 'plugins'] as const,
}

/** True when the server runs with EXPERIMENTAL_FEATURES including "plugins". */
export function usePluginsEnabled(): boolean {
  const mode = useAuthMode()
  return !!mode.data?.experimental?.includes('plugins')
}

export function usePlugins() {
  const enabled = usePluginsEnabled()
  return useQuery({
    queryKey: pluginKeys.list,
    queryFn: () => api<{ plugins: PluginInfo[] }>('/api/plugins').then((r) => r.plugins),
    enabled,
    staleTime: 60_000,
    retry: false,
  })
}

export function useAdminPlugins(enabled: boolean) {
  return useQuery({
    queryKey: pluginKeys.admin,
    queryFn: () => api<AdminPluginsResponse>('/api/admin/plugins'),
    enabled,
    retry: false,
  })
}

function useAdminPluginMutation<V>(fn: (v: V) => Promise<unknown>) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: pluginKeys.admin })
      void qc.invalidateQueries({ queryKey: pluginKeys.list })
    },
  })
}

export function useApprovePlugin() {
  return useAdminPluginMutation((v: { id: string; hash: string; permissions: string[] }) =>
    api(`/api/admin/plugins/${encodeURIComponent(v.id)}/approve`, {
      method: 'POST',
      body: JSON.stringify({ hash: v.hash, permissions: v.permissions }),
    }),
  )
}

export function useDisablePlugin() {
  return useAdminPluginMutation((id: string) =>
    api(`/api/admin/plugins/${encodeURIComponent(id)}/disable`, { method: 'POST' }),
  )
}

export function useRemovePlugin() {
  return useAdminPluginMutation((id: string) =>
    api(`/api/admin/plugins/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  )
}
