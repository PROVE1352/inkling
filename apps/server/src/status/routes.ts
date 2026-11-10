/**
 * GET /api/admin/status — server status summary for admins (docs/adr/1230-*).
 *
 * Admin + browser session only: requireAdmin refuses bearer tokens, and the route is also in the
 * SESSION_ONLY table (tokenPolicy.ts, docs/adr/1204-*). `?refresh=1` skips the five-minute cache of
 * the heavy probes (rate-limited).
 */
import type { FastifyInstance } from 'fastify'
import { requireAdmin } from '../auth'
import { evaluateStatus, type StatusGroup, type StatusItem } from './evaluate'
import { gatherFacts, HEAVY_TTL_MS } from './probes'
import { agentUsageSummary, type AgentUsageDTO } from './agentUsage'
import { semanticConfig } from '../context/semanticConfig'
import type { SemanticStatusDTO } from '../context/semantic'

export interface AdminStatusDTO {
  level: 'ok' | 'warn' | 'error'
  generatedAt: string
  groups: StatusGroup[]
  issues: StatusItem[]
  cache: { hit: boolean; ageSec: number; ttlSec: number }
  /** Agent connections and API tokens since this process started, live (docs/adr/1552-*). */
  agents: AgentUsageDTO
  /**
   * Optional semantic search (docs/adr/1744-*): present only while EMBEDDING_URL/EMBEDDING_MODEL
   * are set, so the response is unchanged when it is off. Never contains the API key.
   */
  semantic?: SemanticStatusDTO | { enabled: true; error: string }
}

export async function registerAdminStatusRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { refresh?: string } }>(
    '/admin/status',
    { preHandler: requireAdmin, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req): Promise<AdminStatusDTO> => {
      const refresh = req.query?.refresh === '1'
      const { facts, cache } = await gatherFacts({ refresh })
      const s = evaluateStatus(facts)
      return {
        level: s.level,
        generatedAt: new Date(facts.now).toISOString(),
        groups: s.groups,
        issues: s.issues,
        cache: { hit: cache.hit, ageSec: Math.max(0, Math.round((facts.now - cache.at) / 1000)), ttlSec: HEAVY_TTL_MS / 1000 },
        agents: await agentUsageSummary(),
        ...(semanticConfig() ? { semantic: await semanticSection() } : {}),
      }
    },
  )
}

/** Loaded only when semantic search is on; a failing count query does not fail the status page. */
async function semanticSection(): Promise<SemanticStatusDTO | { enabled: true; error: string }> {
  try {
    const { semanticStatus } = await import('../context/semantic')
    return (await semanticStatus()) ?? { enabled: true, error: 'unavailable' }
  } catch {
    return { enabled: true, error: 'status query failed' }
  }
}
