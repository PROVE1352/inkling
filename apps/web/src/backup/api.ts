// Admin → Backups — React Query hooks (kept out of the shared src/api.ts). Server: apps/server/src/backup/.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../api'

export type BackupRunInfo = {
  at: string
  setId?: string
  kind?: string
  message?: string
  ok?: boolean
  sizeBytes?: number
  durationSec?: number
  tables?: number
  rows?: number
  setCount?: number
}

export type BackupStatus = {
  startedAt?: string
  heartbeatAt?: string
  nextRunAt?: string | null
  running?: { kind: string; startedAt: string; setId: string } | null
  lastSuccess?: BackupRunInfo
  lastFailure?: BackupRunInfo
  lastVerify?: BackupRunInfo
  lastRestoreTest?: BackupRunInfo
  lastRestore?: BackupRunInfo
  remote?: BackupRunInfo
  setCount?: number
  config?: {
    enabled?: boolean
    schedule?: string
    timezone?: string
    keepDaily?: number
    keepWeekly?: number
    keepMonthly?: number
    restoreTestDays?: number
    minFreeMb?: number
    encrypted?: boolean
    cipher?: string
    remote?: string
    remoteTool?: string
  }
}

export type BackupSet = {
  id: string
  kind: string
  createdAt: string
  totalBytes: number
  encrypted: boolean
  appVersion: string | null
  migration: string | null
  migrationsApplied: number | null
  files: { name: string; bytes: number }[]
}

export type AdminBackupsResponse = {
  configured: boolean
  status: BackupStatus | null
  alert: { kind: string; message: string; at: string } | null
  stale: boolean
  pending: 'queued' | 'processing' | null
  sets: BackupSet[]
}

export const backupKeys = { admin: ['admin', 'backups'] as const }

/** Polls fast (4 s) while a run is queued or in progress, otherwise once a minute. */
export function useAdminBackups() {
  return useQuery({
    queryKey: backupKeys.admin,
    queryFn: () => api<AdminBackupsResponse>('/api/admin/backups'),
    refetchInterval: (q) => (q.state.data?.pending || q.state.data?.status?.running ? 4000 : 60000),
  })
}

export function useRunBackup() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => api<{ queued: true }>('/api/admin/backups/run', { method: 'POST' }),
    onSettled: () => qc.invalidateQueries({ queryKey: backupKeys.admin }),
  })
}

export const backupDownloadUrl = (id: string) => `/api/admin/backups/${encodeURIComponent(id)}/download`
