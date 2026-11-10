import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

/**
 * The tools/list answer without what every client already assumes (docs/adr/1945-*):
 *
 * - `execution: {"taskSupport":"forbidden"}`: the SDK adds it to every tool; the SDK's own type says of
 *   `taskSupport` "If not present, defaults to \"forbidden\"" (sdk types.js, ToolExecution), so leaving
 *   it out changes nothing (45 × 39 chars).
 * - `inputSchema.$schema` ("http://json-schema.org/draft-07/schema#"): the SDK's Tool type describes
 *   inputSchema as "A JSON Schema 2020-12 object", and the schemas use only keywords that mean the same
 *   in draft-07 and 2020-12 (type, properties, required, enum, const, anyOf, single-schema items,
 *   min/max, length bounds, propertyNames, additionalProperties, pattern), so the dialect line is noise
 *   (44 × 51 chars). `mcpTools/toolSurface.test.ts` checks the keyword set.
 *
 * Everything else — names, titles, descriptions, annotations, every schema keyword the SDK validates
 * against — is unchanged, and the order of tools and keys is the SDK's (same bytes for the same build,
 * ADR 1543). The SDK (exact pin 1.32.2) installs its tools/list handler on the first registerTool;
 * this wraps that handler, so call it after the tools are registered.
 */
type Handler = (req: unknown, extra: unknown) => Promise<unknown>

export function slimToolListAnswer(answer: { tools?: Record<string, unknown>[] }): { tools?: Record<string, unknown>[] } {
  if (!Array.isArray(answer?.tools)) return answer
  return {
    ...answer,
    tools: answer.tools.map((t) => {
      const out: Record<string, unknown> = { ...t }
      const ex = out.execution as { taskSupport?: string } | undefined
      if (ex && Object.keys(ex).length === 1 && ex.taskSupport === 'forbidden') delete out.execution
      const schema = out.inputSchema as Record<string, unknown> | undefined
      if (schema && '$schema' in schema) {
        const { $schema: _dialect, ...rest } = schema
        out.inputSchema = rest
      }
      return out
    }),
  }
}

/** Wraps the SDK's tools/list handler of `server` (after registration; see the module comment). */
export function slimToolList(server: McpServer): void {
  const handlers = (server.server as unknown as { _requestHandlers?: Map<string, Handler> })._requestHandlers
  const original = handlers?.get('tools/list')
  if (!handlers || !original) throw new Error('slimToolList: no tools/list handler (call it after registering tools)')
  handlers.set('tools/list', async (req, extra) => slimToolListAnswer((await original(req, extra)) as { tools?: Record<string, unknown>[] }))
}
