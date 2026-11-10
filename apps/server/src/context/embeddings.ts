/**
 * Client of an OpenAI-compatible `/embeddings` endpoint (docs/adr/1740-*): plain fetch + JSON, no
 * SDK. The URL is the operator's own setting, so it is fetched directly (not through safeFetch,
 * which refuses private addresses: a local Ollama must work).
 *
 * Also holds the health state the indexer and the query path share: one failure backs both off,
 * so a dead endpoint costs searches nothing after the first timeout.
 */
import type { SemanticConfig } from './semanticConfig'
import { endpointLabel } from './semanticConfig'

export class EmbeddingError extends Error {
  constructor(
    message: string,
    /** HTTP status, null for network errors, timeouts and malformed answers. */
    readonly status: number | null,
    /** From Retry-After (429/503), in ms. */
    readonly retryAfterMs: number | null = null,
  ) {
    super(message)
  }

  /** The input itself was refused (too long, invalid): retrying the same batch will not help. */
  get inputRejected(): boolean {
    return this.status === 400 || this.status === 413 || this.status === 422
  }
}

/** Shared health of the endpoint (process-local). Messages never contain the API key. */
export const embeddingHealth = {
  lastError: null as { at: string; message: string } | null,
  lastSuccessAt: null as string | null,
  consecutiveFailures: 0,
  /** No request (indexer or query) before this time (ms since epoch). */
  backoffUntil: 0,
  /** Vector length seen in the last good answer (EMBEDDING_DIMENSIONS when set). */
  dims: null as number | null,
  requests: 0,
}

export const BACKOFF_BASE_MS = 5_000
export const BACKOFF_MAX_MS = 10 * 60_000

export function recordFailure(err: unknown, now = Date.now()): void {
  const e = err instanceof EmbeddingError ? err : null
  embeddingHealth.lastError = { at: new Date(now).toISOString(), message: e?.message ?? 'embedding request failed' }
  // A refused input is a property of that chunk, not of the endpoint: no backoff for it.
  if (e?.inputRejected) return
  embeddingHealth.consecutiveFailures++
  const exp = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.min(16, embeddingHealth.consecutiveFailures - 1))
  embeddingHealth.backoffUntil = now + Math.min(BACKOFF_MAX_MS, Math.max(exp, e?.retryAfterMs ?? 0))
}

export function recordSuccess(dims: number, now = Date.now()): void {
  embeddingHealth.consecutiveFailures = 0
  embeddingHealth.backoffUntil = 0
  embeddingHealth.lastSuccessAt = new Date(now).toISOString()
  embeddingHealth.dims = dims
}

export function inBackoff(now = Date.now()): boolean {
  return now < embeddingHealth.backoffUntil
}

/** Tests only. */
export function resetEmbeddingHealthForTests(): void {
  embeddingHealth.lastError = null
  embeddingHealth.lastSuccessAt = null
  embeddingHealth.consecutiveFailures = 0
  embeddingHealth.backoffUntil = 0
  embeddingHealth.dims = null
  embeddingHealth.requests = 0
}

/** Removes the key and anything that looks like a bearer secret from a provider message. */
export function redact(text: string, apiKey: string | null): string {
  let s = text
  if (apiKey) s = s.split(apiKey).join('***')
  return s
    .replace(/Bearer\s+\S+/gi, 'Bearer ***')
    .replace(/\b(sk|pk|rk)-[A-Za-z0-9_*-]{6,}/g, '$1-***')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
}

function retryAfter(h: string | null): number | null {
  if (!h) return null
  const sec = Number(h)
  if (Number.isFinite(sec) && sec >= 0) return Math.min(BACKOFF_MAX_MS, sec * 1000)
  const at = Date.parse(h)
  return Number.isFinite(at) ? Math.min(BACKOFF_MAX_MS, Math.max(0, at - Date.now())) : null
}

/** L2-normalised copy (cosine similarity becomes a dot product). Null for a zero or invalid vector. */
export function normalize(v: ArrayLike<number>): Float32Array | null {
  let sum = 0
  for (let i = 0; i < v.length; i++) {
    const x = v[i]
    if (typeof x !== 'number' || !Number.isFinite(x)) return null
    sum += x * x
  }
  if (!(sum > 0)) return null
  const n = Math.sqrt(sum)
  const out = new Float32Array(v.length)
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n
  return out
}

/**
 * Embeds `inputs` in one request. Returns one normalised vector per input, in input order, all of
 * the same length. Throws EmbeddingError (never another error type) with a message safe to show.
 */
export async function embedTexts(cfg: SemanticConfig, inputs: string[], timeoutMs: number): Promise<Float32Array[]> {
  const where = endpointLabel(cfg.endpoint)
  embeddingHealth.requests++
  let res: Response
  try {
    res = await fetch(cfg.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}),
      },
      body: JSON.stringify({ model: cfg.model, input: inputs, ...(cfg.dimensions ? { dimensions: cfg.dimensions } : {}) }),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
    })
  } catch (err) {
    const name = (err as { name?: string })?.name
    const msg = name === 'TimeoutError' || name === 'AbortError' ? `timeout after ${timeoutMs} ms` : 'connection failed'
    throw new EmbeddingError(`${where}: ${msg}`, null)
  }
  let body: unknown = null
  try {
    body = await res.json()
  } catch {
    body = null
  }
  if (!res.ok) {
    const detail = (body as { error?: { message?: unknown } | string } | null)?.error
    const text = typeof detail === 'string' ? detail : typeof detail?.message === 'string' ? detail.message : ''
    throw new EmbeddingError(
      `${where}: HTTP ${res.status}${text ? ` — ${redact(text, cfg.apiKey)}` : ''}`,
      res.status,
      res.status === 429 || res.status === 503 ? retryAfter(res.headers.get('retry-after')) : null,
    )
  }
  const data = (body as { data?: unknown } | null)?.data
  if (!Array.isArray(data) || data.length !== inputs.length) {
    throw new EmbeddingError(`${where}: malformed answer (expected ${inputs.length} embeddings)`, null)
  }
  const out: (Float32Array | null)[] = new Array(inputs.length).fill(null)
  let dims = 0
  for (let i = 0; i < data.length; i++) {
    const item = data[i] as { embedding?: unknown; index?: unknown }
    const at = typeof item?.index === 'number' && Number.isInteger(item.index) ? item.index : i
    const v = Array.isArray(item?.embedding) ? normalize(item.embedding as number[]) : null
    if (!v || at < 0 || at >= inputs.length || out[at]) {
      throw new EmbeddingError(`${where}: malformed answer (embedding ${i})`, null)
    }
    if (dims && v.length !== dims) throw new EmbeddingError(`${where}: malformed answer (mixed vector lengths)`, null)
    dims = v.length
    out[at] = v
  }
  return out as Float32Array[]
}
