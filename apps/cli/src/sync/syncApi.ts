import { apiFetch as rawFetch, apiJson as rawJson, ApiError } from '../http'
import type { FetchOptions } from '../http'

/**
 * Rate limits (429) are expected on a first sync of a large vault (global 300/min on PATCH and
 * file uploads). Wait — honouring Retry-After when the response exposes it — and retry.
 */
const MAX_RETRIES = 8
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function apiFetch(server: string, pathname: string, opts: FetchOptions = {}): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await rawFetch(server, pathname, opts)
    if (res.status !== 429 || attempt >= MAX_RETRIES) return res
    const after = Number(res.headers.get('retry-after'))
    const wait = Number.isFinite(after) && after > 0 ? after * 1000 : Math.min(2000 * 2 ** attempt, 30_000)
    process.stderr.write(`rate limited by the server; retrying in ${Math.round(wait / 1000)} s\n`)
    await sleep(wait)
  }
}

async function apiJson<T>(server: string, pathname: string, opts: FetchOptions = {}): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await rawJson<T>(server, pathname, opts)
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 429 || attempt >= MAX_RETRIES) throw err
      const wait = Math.min(2000 * 2 ** attempt, 30_000)
      process.stderr.write(`rate limited by the server; retrying in ${Math.round(wait / 1000)} s\n`)
      await sleep(wait)
    }
  }
}

/** Client for the experimental vault-sync endpoints (docs/adr/0200-vault-sync-protocol.md). */

export interface SyncPage {
  id: string
  parentId: string | null
  kind: 'doc' | 'folder' | 'canvas' | 'collection'
  title: string
  updatedAt: string
  /** null = unchanged since the cursor (or not a doc) */
  revision: string | null
  contentHash: string | null
}

export interface ChangesResponse {
  cursor: string
  pages: SyncPage[]
  trashed: { id: string; deletedAt: string }[]
}

export interface PageMarkdown {
  revision: string
  contentHash: string
  markdown: string
  /** frontmatter keys of the written note that the page does not store (writes only) */
  droppedFrontmatterKeys?: string[]
}

export class RevisionMismatch extends Error {
  current: PageMarkdown
  constructor(current: PageMarkdown) {
    super('revision mismatch')
    this.current = current
  }
}

export class SyncApi {
  constructor(
    private server: string,
    private auth: string,
    private workspaceId: string,
  ) {}

  changes(since: string | null): Promise<ChangesResponse> {
    const qs = since ? `?since=${encodeURIComponent(since)}` : ''
    return apiJson<ChangesResponse>(this.server, `/api/workspaces/${this.workspaceId}/sync/changes${qs}`, {
      auth: this.auth,
    })
  }

  async read(ids: string[]): Promise<Map<string, PageMarkdown>> {
    const out = new Map<string, PageMarkdown>()
    for (let i = 0; i < ids.length; i += 100) {
      const data = await apiJson<{ pages: (PageMarkdown & { id: string })[] }>(
        this.server,
        `/api/workspaces/${this.workspaceId}/sync/read`,
        {
          method: 'POST',
          auth: this.auth,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: ids.slice(i, i + 100) }),
        },
      )
      for (const p of data.pages) out.set(p.id, p)
    }
    return out
  }

  /** PUT markdown; throws RevisionMismatch (with the server's current version) on HTTP 412. */
  async write(pageId: string, markdown: string, expectedRevision: string): Promise<PageMarkdown> {
    const res = await apiFetch(this.server, `/api/pages/${pageId}/sync/md`, {
      method: 'PUT',
      auth: this.auth,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ markdown, expectedRevision }),
    })
    if (res.status === 412) {
      const body = (await res.json()) as { current: PageMarkdown }
      throw new RevisionMismatch(body.current)
    }
    if (!res.ok) throw await toError(res)
    return (await res.json()) as PageMarkdown
  }

  async create(input: {
    parentId: string | null
    title: string
    kind: 'doc' | 'folder'
    markdown?: string
    /** retry key (docs/adr/2166-*): the same key creates the page once; servers before 0.17 ignore it */
    clientKey?: string
  }): Promise<{ page: { id: string; parentId: string | null; title: string }; replayed?: boolean } & Partial<PageMarkdown>> {
    return apiJson(this.server, `/api/workspaces/${this.workspaceId}/sync/pages`, {
      method: 'POST',
      auth: this.auth,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
  }

  /** Trash a leaf page. Returns 'ok' | 'changed' (412) | 'has-children' (409) | 'gone' (404). */
  async trash(pageId: string, expectedRevision: string | null): Promise<'ok' | 'changed' | 'has-children' | 'gone'> {
    const qs = expectedRevision ? `?expectedRevision=${encodeURIComponent(expectedRevision)}` : ''
    const res = await apiFetch(this.server, `/api/pages/${pageId}/sync${qs}`, {
      method: 'DELETE',
      auth: this.auth,
    })
    if (res.status === 204) return 'ok'
    if (res.status === 412) return 'changed'
    if (res.status === 409) return 'has-children'
    if (res.status === 404) return 'gone'
    throw await toError(res)
  }

  /** Rename and/or move via the regular page PATCH route. */
  async patch(pageId: string, body: { title?: string; parentId?: string | null }): Promise<void> {
    await apiJson(this.server, `/api/pages/${pageId}`, {
      method: 'PATCH',
      auth: this.auth,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  async upload(pageId: string, name: string, mime: string, data: Buffer): Promise<string> {
    const form = new FormData()
    form.set('file', new Blob([new Uint8Array(data)], { type: mime }), name)
    const r = await apiJson<{ file: { id: string } }>(
      this.server,
      `/api/files?workspaceId=${this.workspaceId}&pageId=${pageId}`,
      { method: 'POST', auth: this.auth, body: form },
    )
    return r.file.id
  }

  async download(fileId: string): Promise<{ data: Buffer; mime: string }> {
    const res = await apiFetch(this.server, `/files/${fileId}`, { auth: this.auth })
    if (!res.ok) throw await toError(res)
    return {
      data: Buffer.from(await res.arrayBuffer()),
      mime: (res.headers.get('content-type') ?? 'application/octet-stream').split(';')[0].trim(),
    }
  }
}

async function toError(res: Response): Promise<ApiError> {
  let message = `Request failed (HTTP ${res.status})`
  let code: string | undefined
  try {
    const data = (await res.json()) as { error?: { code?: string; message?: string } }
    if (data?.error?.message) message = data.error.message
    code = data?.error?.code
  } catch {
    // non-JSON body
  }
  return new ApiError(res.status, message, code)
}
