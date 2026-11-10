/**
 * Test-only fake of an OpenAI-compatible `/embeddings` endpoint on 127.0.0.1 (docs/adr/1745-*).
 * Never imported by production code. Vectors are a deterministic bag of words hashed into `dims`
 * buckets, with a few cross-language synonyms so a Korean query can find an English section.
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'

export type FakeMode = 'ok' | 'fail500' | 'hang' | 'rate429' | 'reject400' | 'malformed' | 'echoKey401'

export interface FakeRequest {
  auth: string | null
  model: string
  inputs: string[]
  dimensions: number | null
}

export interface FakeEmbeddingServer {
  /** Base URL in the form operators configure (`http://127.0.0.1:port/v1`). */
  url: string
  requests: FakeRequest[]
  mode: FakeMode
  dims: number
  /** Inputs for which the server answers 400 (a "too long" chunk). */
  rejectIf: ((input: string) => boolean) | null
  close(): Promise<void>
}

const SYNONYMS: Record<string, string> = {
  checklist: '체크리스트',
  rollback: '롤백',
  deploy: '배포',
  deployment: '배포',
  team: '팀',
  backup: '백업',
  backups: '백업',
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h
}

export function fakeEmbed(text: string, dims: number): number[] {
  const v = new Array<number>(dims).fill(0.01)
  for (const raw of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    const w = SYNONYMS[raw] ?? raw
    v[fnv1a(w) % dims] += 1
  }
  return v
}

export async function startFakeEmbeddings(dims = 64): Promise<FakeEmbeddingServer> {
  const state: Omit<FakeEmbeddingServer, 'url' | 'close'> = { requests: [], mode: 'ok', dims, rejectIf: null }
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      if (req.method !== 'POST' || !req.url?.endsWith('/embeddings')) {
        res.writeHead(404).end()
        return
      }
      let body: { model?: string; input?: string | string[]; dimensions?: number } = {}
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' }).end('{"error":{"message":"bad json"}}')
        return
      }
      const inputs = Array.isArray(body.input) ? body.input : [String(body.input ?? '')]
      const auth = req.headers.authorization ?? null
      state.requests.push({ auth, model: String(body.model ?? ''), inputs, dimensions: body.dimensions ?? null })
      const json = (status: number, payload: unknown, headers: Record<string, string> = {}) =>
        res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(payload))
      switch (state.mode) {
        case 'hang':
          return // never answers; the client times out
        case 'fail500':
          return json(500, { error: { message: 'model crashed' } })
        case 'rate429':
          return json(429, { error: { message: 'slow down' } }, { 'retry-after': '7' })
        case 'echoKey401':
          // a provider that repeats the presented key in its error message
          return json(401, { error: { message: `Incorrect API key provided: ${auth?.replace(/^Bearer /, '')}` } })
        case 'malformed':
          return json(200, { data: [{ embedding: 'nope' }] })
        case 'reject400':
          return json(400, { error: { message: 'input too long' } })
      }
      if (state.rejectIf && inputs.some((i) => state.rejectIf!(i))) {
        return json(400, { error: { message: 'input too long' } })
      }
      const d = body.dimensions ?? state.dims
      // answer in reverse order with explicit indexes (clients must use `index`)
      const data = inputs.map((t, index) => ({ object: 'embedding', index, embedding: fakeEmbed(t, d) })).reverse()
      json(200, { object: 'list', data, model: body.model, usage: { prompt_tokens: 0, total_tokens: 0 } })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  const out = state as FakeEmbeddingServer
  out.url = `http://127.0.0.1:${port}/v1`
  out.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    })
  return out
}
