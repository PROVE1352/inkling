import { sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { parseQuery, QUERY_LIMITS, queryErrorInfo, QuerySyntaxError } from '@inkling/shared'
import type { QueryResultDTO, QueryRowDTO } from '@inkling/shared'
import { getUser, requireUser } from '../auth'
import { db } from '../db/index'
import { indexEpoch, workspaceVersion } from '../versions'
import { AppError } from '../errors'
import { idParam, requireMembership } from '../helpers'
import { compileQuery, QueryCompileError, takeLimit } from '../query/compile'

/**
 * Dataview-style Query block endpoint (stable feature).
 *
 *   POST /api/workspaces/:id/query  { source, today?, tzOffsetMinutes? } → QueryResultDTO
 *
 * Parsing is a hand-written recursive-descent parser (packages/shared/src/query.ts) with
 * length/token/depth caps; compilation emits one parameterized statement (query/compile.ts)
 * filtered by membership + visibleTo; execution runs with a statement_timeout; results are
 * capped. A tiny per-process cache keyed by the workspace "version" absorbs repeated renders
 * of the same block (several open tabs, React re-mounts) without serving stale data.
 */

const STATEMENT_TIMEOUT_MS = 3000
const CACHE_MAX = 200
const CACHE_TTL_MS = 60_000

const bodySchema = z.object({
  source: z.string().max(QUERY_LIMITS.maxLength),
  today: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  tzOffsetMinutes: z.number().int().min(-840).max(840).optional(),
})

interface CacheEntry {
  at: number
  version: string
  result: QueryResultDTO
}
const cache = new Map<string, CacheEntry>()

function cacheGet(key: string, version: string): QueryResultDTO | null {
  const hit = cache.get(key)
  if (!hit) return null
  if (hit.version !== version || Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key)
    return null
  }
  // LRU touch
  cache.delete(key)
  cache.set(key, hit)
  return hit.result
}

function cachePut(key: string, version: string, result: QueryResultDTO): void {
  cache.set(key, { at: Date.now(), version, result })
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}

function utcToday(): string {
  return new Date().toISOString().slice(0, 10)
}

export async function registerQueryRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/workspaces/:id/query',
    {
      preHandler: requireUser,
      // Evaluates a query, never writes: read-only MCP tokens may call it (docs/adr/0935-*).
      config: { rateLimit: { max: 120, timeWindow: '1 minute' }, bearerReadOnlyOk: true },
    },
    async (req) => {
      const user = getUser(req)
      const workspaceId = idParam(req.params)
      const body = bodySchema.parse(req.body)
      await requireMembership(workspaceId, user.id)

      let ast
      try {
        ast = parseQuery(body.source)
      } catch (err) {
        if (err instanceof QuerySyntaxError) throw syntaxError(body.source, err.message, err.pos)
        throw err
      }

      const today = body.today ?? utcToday()
      const tz = body.tzOffsetMinutes ?? 0
      let compiled
      try {
        compiled = compileQuery(ast, { workspaceId, userId: user.id, today, tzOffsetMinutes: tz })
      } catch (err) {
        if (err instanceof QueryCompileError) throw syntaxError(body.source, err.message, err.pos)
        throw err
      }

      // Index epoch: derived indexes trail pages.updated_at by the docIndexer debounce.
      const version = `${await workspaceVersion(workspaceId)}|${indexEpoch()}`
      const key = `${user.id}|${workspaceId}|${today}|${tz}|${body.source}`
      const hit = cacheGet(key, version)
      if (hit) return { ...hit, cached: true }

      const t0 = performance.now()
      let raw: Record<string, unknown>[]
      try {
        raw = await db.transaction(async (tx) => {
          await tx.execute(sql.raw(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`))
          // The jsonb function scans inflate cost estimates past jit_above_cost; JIT compilation
          // then costs more (~15-20 ms) than these short queries take to run. See ADR 0203.
          await tx.execute(sql.raw('SET LOCAL jit = off'))
          return (await tx.execute(compiled.statement)) as unknown as Record<string, unknown>[]
        })
      } catch (err) {
        const code = (err as { code?: string }).code
        if (code === '57014') {
          throw new AppError(400, 'QUERY_TIMEOUT', 'The query took too long — narrow it with FROM or WHERE')
        }
        throw err
      }
      const elapsedMs = Math.round((performance.now() - t0) * 10) / 10

      const page = takeLimit(raw, compiled.limit)
      const truncated = page.truncated
      const rows: QueryRowDTO[] = page.rows.map((r) => {
        const row: QueryRowDTO = {
          pageId: String(r.id),
          title: String(r.title ?? ''),
          cells: Array.isArray(r.cells) ? (r.cells as unknown[]) : [],
        }
        if (ast.type === 'TASK') {
          row.task = {
            blockId: String(r.block_id ?? ''),
            text: String(r.text ?? ''),
            due: String(r.due ?? ''),
            checked: r.checked === true,
          }
        }
        return row
      })

      const result: QueryResultDTO = {
        type: ast.type,
        withoutId: ast.withoutId,
        columns: compiled.columns,
        rows,
        truncated,
        elapsedMs,
      }
      cachePut(key, version, result)
      return result
    },
  )
}

function syntaxError(source: string, message: string, pos: number): AppError {
  const info = queryErrorInfo(source, message, pos)
  const err = new AppError(400, 'QUERY_SYNTAX', `${message} (line ${info.line}, col ${info.col})`)
  // position travels in the message for generic clients; the web block re-parses locally
  // for precise highlighting, so the error body shape stays the app-wide { error: { code, message } }.
  return err
}
