import type { FastifyInstance, FastifyRequest } from 'fastify'
import { AppError } from './errors'

/**
 * Request bodies of POST /mcp (B-L10, docs/adr/1526-*).
 *
 * JSON.parse is synchronous, and what it costs depends on the number of values more than on the
 * size: 12 MB of markdown strings (import_folder) parse in ~10 ms, 12 MB of small objects or numbers
 * in 45–60 ms, all of it blocking the event loop (docs/PERFORMANCE.md). Two rules keep the worst
 * case near the string case without a dependency:
 * - the bearer token is checked before the body is read (an anonymous request never costs a parse);
 * - the body may hold at most MCP_MAX_JSON_VALUES values, counted before parsing by a scan that
 *   skips strings at memchr speed and stops at the limit (≤ ~2 ms for any 12 MB body). Real tool
 *   calls carry a few thousand values at most (import_folder: 300 files × 2).
 */
export const MCP_MAX_JSON_VALUES = 20_000

/**
 * Values in a JSON text, approximately: commas and opening brackets outside strings, plus one.
 * Returns as soon as the count passes `limit`. Strings are skipped with Buffer.indexOf (escaped
 * quotes handled), so long string bodies cost almost nothing.
 */
export function countJsonValues(buf: Buffer, limit = Infinity): number {
  let n = 1
  let i = 0
  const len = buf.length
  while (i < len) {
    const q = buf.indexOf(0x22, i)
    const end = q < 0 ? len : q
    for (let j = i; j < end; j++) {
      const c = buf[j]
      if (c === 0x2c || c === 0x5b || c === 0x7b) {
        if (++n > limit) return n
      }
    }
    if (q < 0) break
    let k = q + 1
    for (;;) {
      const e = buf.indexOf(0x22, k)
      if (e < 0) return n // unterminated string: JSON.parse will say so
      let bs = 0
      for (let b = e - 1; b > q && buf[b] === 0x5c; b--) bs++
      if (bs % 2 === 0) {
        i = e + 1
        break
      }
      k = e + 1
    }
  }
  return n
}

/**
 * JSON parser for the /mcp scope: the value cap, then Fastify's own parser (same prototype
 * poisoning rules as every other route).
 */
export function registerMcpJsonParser(scope: FastifyInstance): void {
  const parse = scope.getDefaultJsonParser('error', 'error')
  // The root app has its own JSON parser (index.ts, empty bodies): replace it in this scope only,
  // or Fastify refuses the second one and the server does not boot (FST_ERR_CTP_ALREADY_PRESENT).
  if (scope.hasContentTypeParser('application/json')) scope.removeContentTypeParser('application/json')
  scope.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req: FastifyRequest, body: Buffer, done) => {
    if (countJsonValues(body, MCP_MAX_JSON_VALUES) > MCP_MAX_JSON_VALUES) {
      done(
        new AppError(
          413,
          'TOO_MANY_VALUES',
          `Request has more than ${MCP_MAX_JSON_VALUES} JSON values; send large data as text (Markdown) or split it into several calls`,
        ),
        undefined,
      )
      return
    }
    parse(req, body.toString('utf8'), done)
  })
}
