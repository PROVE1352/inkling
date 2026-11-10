/**
 * Configuration of the optional semantic search (docs/adr/1740-*). Pure: no database, no network.
 *
 * On only when EMBEDDING_URL and EMBEDDING_MODEL are both set. EMBEDDING_URL is the base of an
 * OpenAI-compatible API (`https://api.openai.com/v1`, a local Ollama `http://host:11434/v1`,
 * text-embeddings-inference, …) or the full `…/embeddings` URL. Everything else has a default.
 *
 *   EMBEDDING_URL                    base URL or …/embeddings (http or https)
 *   EMBEDDING_MODEL                  model name sent with every request and stored with every vector
 *   EMBEDDING_API_KEY                optional; sent as `Authorization: Bearer …`, never logged or shown
 *   EMBEDDING_DIMENSIONS             optional; sent as `dimensions` (models that can shorten vectors)
 *   EMBEDDING_BATCH_SIZE             chunks per request (default 32, 1–256)
 *   EMBEDDING_REQUESTS_PER_MINUTE    indexer request rate (default 60)
 *   EMBEDDING_TIMEOUT_MS             indexer request timeout (default 30000)
 *   EMBEDDING_QUERY_TIMEOUT_MS       timeout of the one query embedding per search (default 3000)
 *   EMBEDDING_MAX_CHARS              characters of one chunk sent to the model (default 4000)
 *   EMBEDDING_CACHE_MB               in-process vector cache for queries (default 128)
 *   EMBEDDING_QUERY_PREFIX           optional text put before every query ("query: " for e5 models)
 *   EMBEDDING_PASSAGE_PREFIX         optional text put before every chunk ("passage: " for e5 models)
 *
 * The prefixes are taken as written (not trimmed: e5 wants the space after the colon). Changing
 * either one changes `vectorModel`, the name vectors are stored under, so the stored vectors are
 * replaced as after a model change (docs/adr/2404-*).
 *
 * Read lazily (first call) so tests can set the environment after importing; memoised after that.
 */
// Importing env first guarantees dotenv has loaded .env before process.env is read.
import '../env'
import { createHash } from 'node:crypto'

export interface SemanticConfig {
  /** Full URL of the embeddings endpoint (…/embeddings). */
  endpoint: string
  /** Model name sent with every request. */
  model: string
  /**
   * Name the vectors are stored and looked up under (page_chunk_vectors.model): the model, plus a
   * short hash of the prefixes when one is set. Without prefixes it equals `model` (vectors written
   * before 0.20 stay valid).
   */
  vectorModel: string
  /** Put before the query / before each chunk text when embedding; '' = nothing (docs/adr/2404-*). */
  queryPrefix: string
  passagePrefix: string
  /** Never printed; only sent in the Authorization header. */
  apiKey: string | null
  dimensions: number | null
  batchSize: number
  requestsPerMinute: number
  timeoutMs: number
  queryTimeoutMs: number
  maxChars: number
  cacheBytes: number
}

export interface SemanticConfigResult {
  config: SemanticConfig | null
  /** Why a partly filled configuration stays off (boot warning); null when complete or empty. */
  warning: string | null
}

function intEnv(v: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(v)
  if (!v?.trim() || !Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.floor(n)))
}

/** `…/v1` → `…/v1/embeddings`; a URL already ending in /embeddings is kept. Null when not http(s). */
export function embeddingsEndpoint(raw: string): string | null {
  let u: URL
  try {
    u = new URL(raw.trim())
  } catch {
    return null
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  const path = u.pathname.replace(/\/+$/, '')
  u.pathname = /\/embeddings$/i.test(path) ? path : `${path}/embeddings`
  return u.toString()
}

/** Host and path of the endpoint for logs and the admin status: no credentials, no query string. */
export function endpointLabel(endpoint: string): string {
  try {
    const u = new URL(endpoint)
    return `${u.protocol}//${u.host}${u.pathname}`
  } catch {
    return '(invalid URL)'
  }
}

export function readSemanticConfig(e: NodeJS.ProcessEnv = process.env): SemanticConfigResult {
  const url = e.EMBEDDING_URL?.trim() || ''
  const model = e.EMBEDDING_MODEL?.trim() || ''
  if (!url && !model) return { config: null, warning: null }
  if (!url || !model) {
    return {
      config: null,
      warning: `semantic search stays off: set both EMBEDDING_URL and EMBEDDING_MODEL (only ${url ? 'EMBEDDING_URL' : 'EMBEDDING_MODEL'} is set)`,
    }
  }
  const endpoint = embeddingsEndpoint(url)
  if (!endpoint) {
    return { config: null, warning: 'semantic search stays off: EMBEDDING_URL is not an http(s) URL' }
  }
  const dims = intEnv(e.EMBEDDING_DIMENSIONS, 0, 0, 16_384)
  const queryPrefix = e.EMBEDDING_QUERY_PREFIX ?? ''
  const passagePrefix = e.EMBEDDING_PASSAGE_PREFIX ?? ''
  return {
    config: {
      endpoint,
      model,
      vectorModel: vectorModelName(model, queryPrefix, passagePrefix),
      queryPrefix,
      passagePrefix,
      apiKey: e.EMBEDDING_API_KEY?.trim() || null,
      dimensions: dims > 0 ? dims : null,
      batchSize: intEnv(e.EMBEDDING_BATCH_SIZE, 32, 1, 256),
      requestsPerMinute: intEnv(e.EMBEDDING_REQUESTS_PER_MINUTE, 60, 1, 6_000),
      timeoutMs: intEnv(e.EMBEDDING_TIMEOUT_MS, 30_000, 500, 300_000),
      queryTimeoutMs: intEnv(e.EMBEDDING_QUERY_TIMEOUT_MS, 3_000, 200, 60_000),
      maxChars: intEnv(e.EMBEDDING_MAX_CHARS, 4_000, 200, 100_000),
      cacheBytes: intEnv(e.EMBEDDING_CACHE_MB, 128, 0, 16_384) * 1024 * 1024,
    },
    warning: null,
  }
}

/**
 * Stored name of the vectors: the model alone without prefixes, else `model#p<8 hex>` (sha1 of both
 * prefixes). A new prefix is a new name, so the indexer re-embeds and prunes like for a new model.
 */
export function vectorModelName(model: string, queryPrefix: string, passagePrefix: string): string {
  if (!queryPrefix && !passagePrefix) return model
  return `${model}#p${createHash('sha1').update(`${queryPrefix}\u0000${passagePrefix}`).digest('hex').slice(0, 8)}`
}

let memo: SemanticConfigResult | undefined

/** The configuration, or null when semantic search is off (the default). */
export function semanticConfig(): SemanticConfig | null {
  memo ??= readSemanticConfig()
  return memo.config
}

/** Boot warning for a half-filled configuration (null otherwise). */
export function semanticConfigWarning(): string | null {
  memo ??= readSemanticConfig()
  return memo.warning
}

/** Tests only: read the environment again on the next call. */
export function resetSemanticConfigForTests(): void {
  memo = undefined
}
