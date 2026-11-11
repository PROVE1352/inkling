import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

/**
 * MCP tool annotations, one table for every tool (docs/adr/2460-*).
 *
 * Every tool states all four hints of the MCP ToolAnnotations type (sdk 1.32.2 types.js), because the
 * spec's defaults are the cautious ones: a tool without annotations reads as "not read-only, may be
 * destructive, not idempotent, open world". `annotateTools` puts the row of this table on each
 * registered tool after registration (more_tools included); a registered tool without a row, or one
 * that brings its own `annotations`, stops the server from building, and
 * `toolAnnotations.test.ts` lists every tool against this table.
 *
 * - readOnlyHint: the tool changes nothing it or another tool reads back. Bookkeeping that every
 *   authenticated request causes is not counted (last-used times, per-connection usage, page read
 *   counters, the taint record of flagged content, the change feed's high-water mark). catch_up is
 *   not read-only: without peek it moves the connection's "last catch_up" marker, which decides what
 *   the next catch_up() returns.
 * - destructiveHint (only meaningful when not read-only): true when the call can remove or overwrite
 *   something that was there (a body, a section, a title, a row value, a page's place or section,
 *   the trash), even when version history, the trash or a later call can bring it back; false when
 *   it only adds (pages, rows, comments, suggestions, claims, uploads) or flips a flag of something
 *   (resolved, acknowledged, the agent's own claim or suggestion). When in doubt: true.
 * - idempotentHint (only meaningful when not read-only): true for writes whose repeat with the same
 *   arguments changes nothing more. Read-only tools carry false, the spec's default.
 * - openWorldHint: false everywhere. Every tool acts on this server's notes and its workspace members;
 *   none fetches a URL the agent names or writes to an address outside the workspace. Member
 *   notifications (in the app, mail, web push), workspace webhooks and the operator's embedding
 *   endpoint are the server's own reactions to any change (the same for an edit in the browser).
 */
export interface ToolHints {
  readOnlyHint: boolean
  destructiveHint: boolean
  idempotentHint: boolean
  openWorldHint: boolean
}

// key order is the order tools/list prints (the same bytes for the same build, docs/adr/1543-*)
const read: ToolHints = { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false }
const write = (destructive: boolean, idempotent: boolean): ToolHints => ({
  readOnlyHint: false,
  destructiveHint: destructive,
  idempotentHint: idempotent,
  openWorldHint: false,
})
/** Adds things only; a repeat adds them again. */
const adds = write(false, false)

/** The annotations of every tool, by name, in tools/list order (more_tools last: core only). */
export const TOOL_ANNOTATIONS: Readonly<Record<string, ToolHints>> = {
  list_workspaces: read,
  list_pages: read,
  search: read,
  read_page: read,
  create_page: adds,
  import_folder: adds,
  update_page: write(true, false), // replace overwrites the body; append twice appends twice
  rename_page: write(true, true), // overwrites the title; the same title again records nothing
  move_page: write(true, true), // can move a page out of the shared section
  trash_page: write(true, true), // removes the page and its subtree from the tree (restorable)
  list_templates: read,
  create_from_template: adds,
  list_comments: read,
  add_comment: adds,
  reply_comment: adds,
  resolve_comment: write(false, true), // a flag; resolved=false reopens
  inbox: read,
  ack: write(false, true), // a flag on the connection's own inbox
  later: read,
  find_context: read,
  read_pages: read,
  patch_section: write(true, false), // replace/delete overwrite; append/insert repeat
  patch_sections: write(true, false),
  get_instructions: read,
  changes_since: read, // the cursor is the caller's; nothing is stored per call
  query_rows: read,
  update_row: write(true, true), // overwrites values (null clears, relations are replaced); a repeat fails on baseVersion
  create_row: adds,
  create_chart: adds,
  create_view: adds,
  split_page: write(true, false), // moves sections out of the page
  read_ink: read,
  list_versions: read,
  diff_versions: read,
  restore_version: write(true, false), // replaces the current body (the previous one stays a version)
  list_trash: read,
  restore_page: write(false, true), // brings pages back; a second call finds nothing in the trash
  read_file: read,
  upload_file: adds,
  import_zip: adds,
  catch_up: write(false, false), // moves its own "last catch_up" marker unless peek=true
  list_suggestions: read,
  withdraw_suggestion: write(false, true), // the agent's own open suggestion
  claim_section: write(false, false), // claiming again extends the claim
  release_section: write(false, true),
  create_collection: adds,
  update_fields: write(true, false), // remove/change hide or rewrite properties
  check_notes: read,
  more_tools: write(true, false), // runs any hidden tool: the worst case of what it dispatches
}

/** The annotations of `name`; throws for a tool the table does not know. */
export function annotationsOf(name: string): ToolHints {
  const hints = Object.hasOwn(TOOL_ANNOTATIONS, name) ? TOOL_ANNOTATIONS[name] : undefined
  if (!hints) throw new Error(`annotations: no row for tool "${name}" in mcpTools/annotations.ts (docs/adr/2460-*)`)
  return { ...hints }
}

type Registered = Record<string, { annotations?: Record<string, unknown> }>

/**
 * Puts the table's annotations on every tool registered on `server`. Call it once, after every
 * registerTool (more_tools included), before the server answers its first request.
 */
export function annotateTools(server: McpServer): void {
  const tools = (server as unknown as { _registeredTools?: Registered })._registeredTools
  if (!tools) throw new Error('annotateTools: the SDK has no registered tool table')
  for (const [name, tool] of Object.entries(tools)) {
    if (tool.annotations !== undefined) {
      throw new Error(`annotations: tool "${name}" sets its own annotations; put them in mcpTools/annotations.ts (docs/adr/2460-*)`)
    }
    tool.annotations = { ...annotationsOf(name) }
  }
}
