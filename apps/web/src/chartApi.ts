// Chart data (docs/adr/1602-*): POST /api/workspaces/:id/charts/aggregate.
//
// Cache keys sit under the source's existing keys, so the invalidations the app already does
// refresh charts without new code: a collection chart lives under qk.collection(id) (every row,
// field and view mutation invalidates that prefix), a query chart under ['query', wsId]. Edits by
// others arrive through the workspace version the query block uses (the polled page list).
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import type { ChartAggregateInput, ChartDataDTO } from '@inkling/shared'
import { api, qk, usePages } from './api'

/** Workspace change marker derived from the page list that is already polled (as the query block). */
export function useWorkspaceVersion(wsId: string): string {
  const pages = usePages(wsId)
  return useMemo(() => {
    const list = pages.data ?? []
    let max = ''
    for (const p of list) if (p.updatedAt > max) max = p.updatedAt
    return `${list.length}:${max}`
  }, [pages.data])
}

function localToday(): { today: string; tzOffsetMinutes: number } {
  const now = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return { today: `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`, tzOffsetMinutes: -now.getTimezoneOffset() }
}

export function fetchChartData(wsId: string, input: ChartAggregateInput): Promise<ChartDataDTO> {
  const body = input.source.type === 'query' ? { ...input, ...localToday() } : input
  return api<ChartDataDTO>(`/api/workspaces/${wsId}/charts/aggregate`, { method: 'POST', body: JSON.stringify(body) })
}

export function chartDataKey(wsId: string, input: ChartAggregateInput, version: string, extra = ''): readonly unknown[] {
  const base = input.source.type === 'collection' ? qk.collection(input.source.collectionId) : (['query', wsId] as const)
  return [...base, 'chart', JSON.stringify(input), extra, version] as const
}

/**
 * Aggregate for a chart; `enabled` false until the chart is on screen. `extra` joins the key (a
 * chart view passes its filters, so a filter change asks again at once).
 */
export function useChartData(wsId: string, input: ChartAggregateInput | null, enabled: boolean, extra = '') {
  const version = useWorkspaceVersion(wsId)
  return useQuery({
    queryKey: input ? chartDataKey(wsId, input, version, extra) : ['chart', 'none'],
    queryFn: () => fetchChartData(wsId, input!),
    enabled: enabled && !!input && !!wsId,
    staleTime: 10_000,
    gcTime: 5 * 60_000,
    placeholderData: keepPreviousData,
    retry: false,
  })
}
