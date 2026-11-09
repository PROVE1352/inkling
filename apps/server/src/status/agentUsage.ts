import { inArray, eq } from 'drizzle-orm'
import { usageList, usageSince } from '../connectionUsage'
import type { UsageView } from '../connectionUsage'
import { contextCacheSize, contextCacheStats } from '../context/contextCache'
import { activeChangeWaiters } from '../context/changeWait'
import { db } from '../db/index'
import { apiTokens, oauthClients, oauthGrants, users } from '../db/schema'

/**
 * Agent connections and API tokens with their usage since this process started, for the admin
 * status (docs/adr/1552-*). Live (not part of the five-minute probe cache): one statement per kind
 * for the names of at most AGENT_USAGE_ROWS connections. Numbers only.
 */
export const AGENT_USAGE_ROWS = 50

export interface ConnectionUsageDTO {
  kind: 'agent' | 'token'
  /** Grant id (agent) or API token id. */
  id: string
  /** Client name (agent) or token name; null when the connection was revoked meanwhile. */
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

export interface AgentUsageDTO {
  since: string
  totals: { connections: number; calls: number; errors: number; tokens: number; cacheHits: number }
  /** find_context cache since start (docs/adr/1550-*) and changes_since calls waiting now (1551). */
  cache: { hits: number; misses: number; entries: number; bytes: number }
  waiting: number
  connections: ConnectionUsageDTO[]
  /** Connections beyond AGENT_USAGE_ROWS (least recently used, not listed). */
  more: number
}

export async function agentUsageSummary(): Promise<AgentUsageDTO> {
  const all = usageList()
  const totals = { connections: all.length, calls: 0, errors: 0, tokens: 0, cacheHits: 0 }
  for (const { usage } of all) {
    totals.calls += usage.calls
    totals.errors += usage.errors
    totals.tokens += usage.tokens
    totals.cacheHits += usage.cacheHits
  }
  const shown = all.slice(0, AGENT_USAGE_ROWS)
  const grantIds = shown.filter((r) => r.key.startsWith('grant:')).map((r) => r.key.slice(6))
  const tokenIds = shown.filter((r) => r.key.startsWith('token:')).map((r) => r.key.slice(6))
  const grants = grantIds.length
    ? await db
        .select({ id: oauthGrants.id, name: oauthClients.name, userId: users.id, userName: users.name })
        .from(oauthGrants)
        .innerJoin(oauthClients, eq(oauthClients.id, oauthGrants.clientId))
        .innerJoin(users, eq(users.id, oauthGrants.userId))
        .where(inArray(oauthGrants.id, grantIds))
    : []
  const tokens = tokenIds.length
    ? await db
        .select({ id: apiTokens.id, name: apiTokens.name, userId: users.id, userName: users.name })
        .from(apiTokens)
        .innerJoin(users, eq(users.id, apiTokens.userId))
        .where(inArray(apiTokens.id, tokenIds))
    : []
  const names = new Map<string, { name: string; user: { id: string; name: string } }>()
  for (const g of grants) names.set(`grant:${g.id}`, { name: g.name, user: { id: g.userId, name: g.userName } })
  for (const t of tokens) names.set(`token:${t.id}`, { name: t.name, user: { id: t.userId, name: t.userName } })
  const row = (key: string, u: UsageView): ConnectionUsageDTO => ({
    kind: key.startsWith('grant:') ? 'agent' : 'token',
    id: key.slice(6),
    name: names.get(key)?.name ?? null,
    user: names.get(key)?.user ?? null,
    calls: u.calls,
    errors: u.errors,
    tokens: u.tokens,
    cacheHits: u.cacheHits,
    avgMs: u.avgMs,
    p95Ms: u.p95Ms,
    waitSec: Math.round(u.waitMs / 1000),
    lastUsedAt: new Date(u.lastUsedAt).toISOString(),
  })
  const size = contextCacheSize()
  return {
    since: usageSince().toISOString(),
    totals,
    cache: { hits: contextCacheStats.hits, misses: contextCacheStats.misses, entries: size.entries, bytes: size.bytes },
    waiting: activeChangeWaiters(),
    connections: shown.map((r) => row(r.key, r.usage)),
    more: Math.max(0, all.length - shown.length),
  }
}
