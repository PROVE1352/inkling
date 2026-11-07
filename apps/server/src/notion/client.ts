import { AppError } from '../errors'

// ---------------------------------------------------------------------------
// Thin fetch wrapper over the Notion REST API (no official SDK dependency).
//  - Notion-Version: 2022-06-28
//  - rate limit 3 req/s → at least 350ms between requests
//  - failed responses become AppError(502 NOTION_ERROR) carrying Notion's message
// ---------------------------------------------------------------------------

const NOTION_API = 'https://api.notion.com/v1'
const NOTION_VERSION = '2022-06-28'
const MIN_INTERVAL_MS = 350
const REQUEST_TIMEOUT_MS = 15000

/** Whether AbortSignal.timeout fired (slow/unresponsive outbound request). */
function isTimeoutError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

export interface CreatedPage {
  id: string
  url: string
}

export interface AppendResult {
  results: { id: string }[]
}

/** Extract 32 hex chars (with or without dashes) from a URL/string and return them as a dash-normalized page id. */
export function extractNotionPageId(input: string): string | null {
  const s = (input ?? '').trim()
  if (!s) return null
  const dashed = s.match(
    /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g,
  )
  if (dashed && dashed.length > 0) return normalizeId(dashed[dashed.length - 1])
  const bare = s.match(/[0-9a-fA-F]{32}/g)
  if (bare && bare.length > 0) return normalizeId(bare[bare.length - 1])
  return null
}

function normalizeId(id: string): string {
  const hex = id.replace(/-/g, '').toLowerCase()
  if (hex.length !== 32) return id
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export class NotionClient {
  private lastRequestAt = 0

  constructor(private readonly token: string) {}

  private authHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      'Notion-Version': NOTION_VERSION,
    }
  }

  /** Gate that enforces the minimum interval — every Notion request waits here first. */
  private async throttle(): Promise<void> {
    const now = Date.now()
    const wait = this.lastRequestAt + MIN_INTERVAL_MS - now
    if (wait > 0) await sleep(wait)
    this.lastRequestAt = Date.now()
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    await this.throttle()
    let res: Response
    try {
      res = await fetch(`${NOTION_API}${path}`, {
        method,
        headers: { ...this.authHeaders(), 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch (err) {
      if (isTimeoutError(err)) {
        throw new AppError(504, 'NOTION_TIMEOUT', 'Notion took too long to respond')
      }
      throw new AppError(502, 'NOTION_ERROR', `Could not connect to Notion: ${asMessage(err)}`)
    }
    return this.parse<T>(res)
  }

  private async parse<T>(res: Response): Promise<T> {
    if (res.ok) return (await res.json()) as T
    let message = `HTTP ${res.status}`
    try {
      const body = (await res.json()) as { message?: string; code?: string }
      if (body?.message) message = body.message
    } catch {
      // If the body cannot be parsed, keep the status-code message
    }
    throw new AppError(502, 'NOTION_ERROR', `Notion API error: ${message}`)
  }

  /** Create a child page with only a title (children are appended afterwards). */
  async createPage(parentPageId: string, title: string): Promise<CreatedPage> {
    return this.request<CreatedPage>('POST', '/pages', {
      parent: { type: 'page_id', page_id: parentPageId },
      properties: {
        title: {
          title: [{ type: 'text', text: { content: title || 'Untitled' } }],
        },
      },
    })
  }

  /** Append children to a block (the caller ensures at most 100 per request). */
  async appendChildren(
    blockId: string,
    children: Record<string, unknown>[],
  ): Promise<AppendResult> {
    return this.request<AppendResult>('PATCH', `/blocks/${blockId}/children`, {
      children,
    })
  }

  /**
   * single_part file upload.
   *  1) POST /file_uploads → { id, upload_url }
   *  2) POST upload_url (multipart/form-data, field 'file')
   *  3) return the file_upload id
   */
  async uploadFile(buffer: Buffer, filename: string, mime: string): Promise<string> {
    const created = await this.request<{ id: string; upload_url: string }>(
      'POST',
      '/file_uploads',
      { mode: 'single_part', filename },
    )

    await this.throttle()
    const fd = new FormData()
    fd.append('file', new Blob([buffer], { type: mime || 'application/octet-stream' }), filename)

    let res: Response
    try {
      res = await fetch(created.upload_url, {
        method: 'POST',
        headers: this.authHeaders(), // FormData sets Content-Type
        body: fd,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch (err) {
      if (isTimeoutError(err)) {
        throw new AppError(504, 'NOTION_TIMEOUT', 'Notion upload took too long')
      }
      throw new AppError(502, 'NOTION_ERROR', `File upload failed: ${asMessage(err)}`)
    }
    await this.parse<unknown>(res)
    return created.id
  }
}

function asMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
