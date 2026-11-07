import { apiFetch, apiJson, ApiError } from './http'

export interface Workspace {
  id: string
  name: string
  icon: string | null
  inviteCode: string
  role: string
}

/** GET /api/workspaces — requires auth. ApiError(401) when not logged in. */
export async function listWorkspaces(server: string, cookie: string): Promise<Workspace[]> {
  const data = await apiJson<{ workspaces: Workspace[] }>(server, '/api/workspaces', { cookie })
  return data.workspaces
}

/** GET /api/health — { ok: true }. */
export async function health(server: string): Promise<boolean> {
  try {
    const data = await apiJson<{ ok?: boolean }>(server, '/api/health')
    return data.ok === true
  } catch {
    return false
  }
}

export interface MeUser {
  id: string
  email: string
  name: string
}

/** GET /api/auth/me — the user when logged in, otherwise null. */
export async function me(server: string, cookie: string | undefined): Promise<MeUser | null> {
  if (!cookie) return null
  try {
    const data = await apiJson<{ user: MeUser }>(server, '/api/auth/me', { cookie })
    return data.user
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return null
    throw err
  }
}

/** GET /api/workspaces/:id/export → zip binary buffer. */
export async function exportWorkspaceZip(
  server: string,
  cookie: string,
  workspaceId: string,
): Promise<Buffer> {
  const res = await apiFetch(server, `/api/workspaces/${workspaceId}/export`, { cookie })
  if (!res.ok) {
    let message = `Export failed (HTTP ${res.status})`
    try {
      const data = (await res.json()) as { error?: { message?: string } }
      if (data?.error?.message) message = data.error.message
    } catch {
      // ignore
    }
    throw new ApiError(res.status, message)
  }
  const ab = await res.arrayBuffer()
  return Buffer.from(ab)
}

export interface ImportedPage {
  id: string
  title: string
}

/**
 * POST /api/workspaces/:id/import?parentId=… — turns Markdown into a page.
 * The title comes from the file name (without extension). With parentId, the page goes under it and inherits its scope.
 * Uses the server's single-.md import route as is (content is converted to BlockNote and saved too).
 */
export async function importMarkdown(
  server: string,
  cookie: string,
  workspaceId: string,
  parentId: string | null,
  filename: string,
  content: string,
): Promise<ImportedPage[]> {
  const form = new FormData()
  form.set('file', new Blob([content], { type: 'text/markdown' }), filename)
  const qs = parentId ? `?parentId=${encodeURIComponent(parentId)}` : ''
  const data = await apiJson<{ pages: ImportedPage[] }>(
    server,
    `/api/workspaces/${workspaceId}/import${qs}`,
    { method: 'POST', cookie, body: form },
  )
  return data.pages
}

/**
 * Pick a workspace from the --workspace argument (name or id).
 *  - If none is given and there is exactly one workspace, use it.
 *  - Exact id match first, then case-insensitive name match.
 */
export function selectWorkspace(list: Workspace[], selector: string | undefined): Workspace {
  if (list.length === 0) throw new Error('You are not a member of any workspace')

  if (!selector) {
    if (list.length === 1) return list[0]
    const names = list.map((w) => `  - ${w.name} (${w.id})`).join('\n')
    throw new Error(`You have several workspaces. Pick one with --workspace:\n${names}`)
  }

  const byId = list.find((w) => w.id === selector)
  if (byId) return byId

  const lower = selector.toLowerCase()
  const byName = list.filter((w) => w.name.toLowerCase() === lower)
  if (byName.length === 1) return byName[0]
  if (byName.length > 1) {
    throw new Error(`Several workspaces share this name. Use the id instead: "${selector}"`)
  }
  throw new Error(`Workspace not found: "${selector}"`)
}
