import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { McpServer as McpServerClass } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { text } from './core'
import type { ToolCtx } from './core'

/**
 * Tool profiles (docs/adr/2000-*).
 *
 * A connection picks a profile with the MCP URL's query: `/mcp?profile=core` or `/mcp?profile=full`;
 * without the query it is `full`, the list every connection had before 0.16. The server is stateless
 * (one McpServer per POST) and the query comes with every request, so the profile needs no stored
 * state.
 *
 * `core` lists the tools of the everyday flows (read, search, section writes, comments, inbox,
 * catch_up, section claims, suggestions, rows) plus `more_tools`; the groups below are left out of
 * tools/list. Every tool stays registered and callable under its own name: a client that lets the
 * model call an unlisted name works, and `more_tools` lists the hidden tools, prints one tool's
 * arguments and runs one through the same tools/call handler (validation, id resolution, read-only
 * refusal and metering unchanged). `notifications/tools/list_changed` is not used: there is no
 * stream to send it on in JSON response mode, and showing more tools after it would need state per
 * connection that a cached tool list then disagrees with (ADR 2000, alternatives).
 */

export type { McpProfile } from '../mcpProfile'
export { parseProfile, PROFILE_ERROR, resourceWithoutProfile } from '../mcpProfile'

/** Tool groups that `core` leaves out of tools/list, in the order `more_tools` prints them. */
export const HIDDEN_GROUPS: { group: string; tools: string[]; about: string }[] = [
  { group: 'structure', tools: ['create_collection', 'update_fields', 'create_view', 'create_chart'], about: 'collection properties and views, charts in documents' },
  { group: 'templates', tools: ['list_templates', 'create_from_template'], about: 'pages from templates' },
  { group: 'history', tools: ['list_versions', 'diff_versions', 'restore_version', 'list_trash', 'restore_page'], about: 'saved versions and the trash' },
  { group: 'upkeep', tools: ['check_notes', 'split_page'], about: 'memory check of a workspace or subtree; split a long page' },
  // upload_file (0.16) stays here, not in CORE_TOOLS: attaching a file is not an everyday flow (no recipe,
  // skill step or prompt starts with one; agents write results as Markdown), uploads can be off per
  // workspace or server (docs/adr/2065-*), and listing it would cost every core session ~210 tokens.
  // Against: more_tools flattens per-tool approval for this write tool (KNOWN-ISSUES MCP-PROF-4); use
  // the full profile for that.
  { group: 'files', tools: ['import_folder', 'upload_file'], about: 'many Markdown files at once; upload an attachment' },
  { group: 'ink', tools: ['read_ink'], about: 'handwriting as images' },
]

/** Tools `core` lists (every registered tool is in exactly one of CORE_TOOLS or HIDDEN_GROUPS). */
export const CORE_TOOLS: readonly string[] = [
  'list_workspaces', 'list_pages', 'search', 'find_context', 'read_page', 'read_pages',
  'create_page', 'update_page', 'rename_page', 'move_page', 'trash_page',
  'patch_section', 'patch_sections', 'get_instructions',
  'add_comment', 'list_comments', 'reply_comment', 'resolve_comment',
  'inbox', 'ack', 'catch_up', 'changes_since', 'later',
  'claim_section', 'release_section', 'list_suggestions', 'withdraw_suggestion',
  'query_rows', 'create_row', 'update_row', 'read_file',
  'more_tools',
]

const HIDDEN = new Set(HIDDEN_GROUPS.flatMap((g) => g.tools))

/** Whether `core` lists this tool. A tool in neither table is listed (and toolProfiles.test.ts fails). */
export function listedInCore(name: string): boolean {
  return !HIDDEN.has(name)
}

const failed = (msg: string): CallToolResult => ({ isError: true, content: [{ type: 'text', text: `Error: ${msg}` }] })

type Handler = (req: unknown, extra: unknown) => Promise<unknown>
type ListedTool = { name: string; description?: string; inputSchema?: unknown; annotations?: Record<string, unknown> }

function handlersOf(server: McpServer): Map<string, Handler> {
  const handlers = (server.server as unknown as { _requestHandlers?: Map<string, Handler> })._requestHandlers
  if (!handlers) throw new Error('profiles: the SDK has no request handler map')
  return handlers
}

/** Names of the tools registered on `server` (the SDK's own table, registration order). */
function registeredNames(server: McpServer): string[] {
  return Object.keys((server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools)
}

/** `more_tools()`: the hidden tools that are registered, one line per group. */
export function renderMoreToolsIndex(registered: Set<string>): string {
  const lines = [
    'Tools this connection does not list (profile core). more_tools(tool=…) prints one tool\'s arguments; ' +
      'more_tools(tool=…, arguments={…}) runs it. Connect with /mcp?profile=full to list them all.',
  ]
  for (const g of HIDDEN_GROUPS) {
    const names = g.tools.filter((t) => registered.has(t))
    if (names.length) lines.push(`- ${g.group}: ${names.join(', ')} — ${g.about}`)
  }
  return lines.join('\n')
}

/** `more_tools(tool)`: the tool's description and argument schema exactly as tools/list would show them. */
export function renderToolSpec(t: ListedTool): string {
  const hints = Object.entries(t.annotations ?? {})
    .filter(([, v]) => v === true)
    .map(([k]) => k.replace(/Hint$/, ''))
  return [
    `${t.name}${hints.length ? ` (${hints.join(', ')})` : ''}: ${t.description ?? ''}`,
    `arguments (JSON Schema): ${JSON.stringify(t.inputSchema ?? { type: 'object' })}`,
    `Run it: more_tools(tool="${t.name}", arguments={…}).`,
  ].join('\n')
}

/**
 * Apply the connection's profile to `server` (after every tool is registered and the list is
 * slimmed, docs/adr/1945-*): `full` changes nothing; `core` registers `more_tools` and filters
 * tools/list to listedInCore().
 */
export function applyProfile(server: McpServer, ctx: ToolCtx): void {
  if ((ctx.profile ?? 'full') === 'full') return
  const handlers = handlersOf(server)
  const list = handlers.get('tools/list')
  const callTool = handlers.get('tools/call')
  if (!list || !callTool) throw new Error('applyProfile: call it after the tools are registered')

  const fullList = async (extra: unknown) => ((await list({ method: 'tools/list', params: {} }, extra)) as { tools: ListedTool[] }).tools

  // Registered with the SDK's own registerTool, past the meter and id wrappers installed on this
  // instance (docs/adr/1552-*, 1940-*): more_tools has no id arguments, and the tool it runs is
  // metered by its own call, so one run is counted once.
  McpServerClass.prototype.registerTool.call(
    server,
    'more_tools',
    {
      title: 'More tools',
      description:
        'This connection lists the core tools. Call with no arguments for the others (collection structure and charts, ' +
        'templates, version history and trash, check_notes, split_page, folder import, file upload, handwriting); tool=<name> for its ' +
        'arguments; tool and arguments to run it.',
      inputSchema: {
        tool: z.string().trim().min(1).max(64).optional().describe('A tool name from more_tools()'),
        arguments: z.record(z.string(), z.unknown()).optional().describe("That tool's arguments: runs it"),
      },
    },
    (async (args: { tool?: string; arguments?: Record<string, unknown> }, extra: unknown): Promise<CallToolResult> => {
      const registered = new Set(registeredNames(server).filter((n) => n !== 'more_tools'))
      if (!args.tool) {
        if (args.arguments) return failed('arguments need tool: more_tools(tool="name", arguments={…})')
        return text(renderMoreToolsIndex(registered))
      }
      const name = args.tool
      if (!registered.has(name)) {
        return failed(`no tool named "${name}"; more_tools() lists the hidden ones, and the tools you see are called directly`)
      }
      if (!args.arguments) {
        const spec = (await fullList(extra)).find((t) => t.name === name)
        return text(renderToolSpec(spec ?? { name }))
      }
      // the same path as a direct call: zod validation, id resolution, wrapWrite, metering
      return (await callTool({ method: 'tools/call', params: { name, arguments: args.arguments } }, extra)) as CallToolResult
    }) as never,
  )

  handlers.set('tools/list', async (req, extra) => {
    const answer = (await list(req, extra)) as { tools?: ListedTool[] }
    if (!Array.isArray(answer?.tools)) return answer
    return { ...answer, tools: answer.tools.filter((t) => listedInCore(t.name)) }
  })
}
