import { basename, extname } from 'node:path'
import { readFile } from 'node:fs/promises'
import { importMarkdown, listWorkspaces, selectWorkspace } from '../api'
import { strFlag } from '../args'
import { loadConfig } from '../config'
import { ApiError } from '../http'

/**
 * inklingctl push <file.md> [--parent <pageId>] [--title <title>]
 *                          [--workspace <name|id>] [--server <url>]
 *
 * Creates an Inkling page (with content) from a local Markdown file, under --parent if given.
 * Title: --title, otherwise the file name. Uses the server's import route as is.
 */
export async function cmdPush(
  flags: Record<string, string | boolean>,
  positionals: string[],
): Promise<void> {
  const file = positionals[0]
  if (!file) {
    throw new Error('Usage: inklingctl push <file.md> [--parent <pageId>] [--title <title>]')
  }

  const config = await loadConfig()
  if (!config.cookie) {
    throw new Error('Not logged in. Run `inklingctl login` first')
  }
  const server = strFlag(flags, 'server') ?? config.server

  let content: string
  try {
    content = await readFile(file, 'utf8')
  } catch {
    throw new Error(`Cannot read file: ${file}`)
  }

  // Title: --title first, otherwise the file name without extension. The server takes the title
  // from the file name, so the upload is named "<title>.md".
  const title = strFlag(flags, 'title') ?? basename(file, extname(file))
  const uploadName = `${title}.md`
  const parentId = strFlag(flags, 'parent') ?? null

  let workspaces
  try {
    workspaces = await listWorkspaces(server, config.cookie)
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      throw new Error('Session expired. Run `inklingctl login` again')
    }
    throw err
  }
  const ws = selectWorkspace(workspaces, strFlag(flags, 'workspace'))

  let created
  try {
    created = await importMarkdown(server, config.cookie, ws.id, parentId, uploadName, content)
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      throw new Error('Session expired. Run `inklingctl login` again')
    }
    throw err
  }

  const page = created[0]
  if (!page) {
    process.stdout.write('No page was created\n')
    return
  }
  process.stdout.write(`✅ Page created: ${page.title}\n`)
  process.stdout.write(`   ${server}/w/${ws.id}/p/${page.id}\n`)
  process.stdout.write(`   page-id: ${page.id}\n`)
}
