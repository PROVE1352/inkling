import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { MemberDTO, MemberStatusDTO, SetMemberStatusInput } from '@inkling/shared'
import { api } from './api'

// Member status (docs/adr/1845-*). Kept out of api.ts like laterApi.ts.

export const qkStatus = { mine: ['memberStatus', 'mine'] as const }

export function useMyStatus() {
  return useQuery({
    queryKey: qkStatus.mine,
    queryFn: () => api<{ status: MemberStatusDTO | null }>('/api/me/status').then((r) => r.status),
    staleTime: 60_000,
  })
}

export function useSetMyStatus() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: SetMemberStatusInput | null) =>
      (input
        ? api<{ status: MemberStatusDTO | null }>('/api/me/status', { method: 'PUT', body: JSON.stringify(input) })
        : api<{ status: MemberStatusDTO | null }>('/api/me/status', { method: 'DELETE' })
      ).then((r) => r.status),
    onSuccess: (status) => {
      qc.setQueryData(qkStatus.mine, status)
      // every workspace's members list carries it
      void qc.invalidateQueries({ queryKey: ['members'] })
    },
  })
}

/** A status still in force on this device's clock (the server already drops cleared ones). */
export function liveStatus(s: MemberStatusDTO | null | undefined, now = Date.now()): MemberStatusDTO | null {
  if (!s) return null
  if (s.clearAt && new Date(s.clearAt).getTime() <= now) return null
  return s
}

/** "🎓 Exam week" — the short form shown next to a name. */
export function statusLabel(s: MemberStatusDTO): string {
  return [s.emoji, s.text].filter(Boolean).join(' ')
}

/** userId → live status, from a members list. */
export function statusByUser(members: MemberDTO[] | undefined): Map<string, MemberStatusDTO> {
  const out = new Map<string, MemberStatusDTO>()
  for (const m of members ?? []) {
    const s = liveStatus(m.status)
    if (s) out.set(m.id, s)
  }
  return out
}
