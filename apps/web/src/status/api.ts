// Admin status summary — React Query hook (server: apps/server/src/status/, docs/adr/1230-*).
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../api'

export type StatusLevel = 'ok' | 'warn' | 'error' | 'off'
export type StatusGroupId = 'backup' | 'storage' | 'app' | 'security' | 'update'
export type StatusData = Record<string, string | number | boolean | null>

export type StatusItem = { key: string; group: StatusGroupId; level: StatusLevel; data: StatusData }
export type StatusGroup = { id: StatusGroupId; level: StatusLevel; summary: string | null; items: StatusItem[] }

export type AdminStatusDTO = {
  level: 'ok' | 'warn' | 'error'
  generatedAt: string
  groups: StatusGroup[]
  issues: StatusItem[]
  cache: { hit: boolean; ageSec: number; ttlSec: number }
  /** Agent connections and API tokens since the server started (docs/adr/1552-*). */
  agents?: AgentUsage
}

export type ConnectionUsage = {
  kind: 'agent' | 'token'
  id: string
  name: string | null
  user: { id: string; name: string } | null
  calls: number
  errors: number
  tokens: number
  cacheHits: number
  avgMs: number
  p95Ms: number
  waitSec: number
  lastUsedAt: string
}

export type AgentUsage = {
  since: string
  totals: { connections: number; calls: number; errors: number; tokens: number; cacheHits: number }
  cache: { hits: number; misses: number; entries: number; bytes: number }
  waiting: number
  connections: ConnectionUsage[]
  more: number
}

export const statusKeys = { admin: ['admin', 'status'] as const }

/** Admins only (`enabled`); the server caches its heavy probes for 5 minutes, so does the client. */
export function useAdminStatus(enabled: boolean) {
  return useQuery({
    queryKey: statusKeys.admin,
    queryFn: () => api<AdminStatusDTO>('/api/admin/status'),
    enabled,
    staleTime: 5 * 60 * 1000,
    refetchInterval: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
    retry: false,
  })
}

/** "Check again": bypasses the server cache (?refresh=1) and stores the answer as the query's data. */
export function useRecheckStatus() {
  const qc = useQueryClient()
  const [pending, setPending] = useState(false)
  const run = async () => {
    setPending(true)
    try {
      const data = await api<AdminStatusDTO>('/api/admin/status?refresh=1')
      qc.setQueryData(statusKeys.admin, data)
    } finally {
      setPending(false)
    }
  }
  return { run, pending }
}
