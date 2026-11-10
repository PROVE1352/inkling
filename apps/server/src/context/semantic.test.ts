// Optional semantic search without a database (docs/adr/1740-*–1745-*): configuration, the
// off-by-default guarantee (no fetch, no query, no timer), the /embeddings client against a local
// fake server, backoff and secret redaction.
for (const k of Object.keys(process.env)) if (k.startsWith('EMBEDDING_')) delete process.env[k]

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { readSemanticConfig, embeddingsEndpoint, endpointLabel, resetSemanticConfigForTests, semanticConfig } from './semanticConfig'
import {
  BACKOFF_MAX_MS,
  EmbeddingError,
  embedTexts,
  embeddingHealth,
  inBackoff,
  normalize,
  recordFailure,
  redact,
  resetEmbeddingHealthForTests,
} from './embeddings'
import { startFakeEmbeddings } from './semanticTestServer'
import type { FakeEmbeddingServer } from './semanticTestServer'

describe('semantic search configuration', () => {
  it('is off without EMBEDDING_URL and EMBEDDING_MODEL, with no warning', () => {
    assert.deepEqual(readSemanticConfig({}), { config: null, warning: null })
  })

  it('stays off with a warning when only one of the two is set', () => {
    const a = readSemanticConfig({ EMBEDDING_URL: 'http://localhost:11434/v1' })
    assert.equal(a.config, null)
    assert.match(a.warning ?? '', /EMBEDDING_URL and EMBEDDING_MODEL/)
    const b = readSemanticConfig({ EMBEDDING_MODEL: 'bge-m3' })
    assert.equal(b.config, null)
    assert.match(b.warning ?? '', /only EMBEDDING_MODEL/)
    assert.match(readSemanticConfig({ EMBEDDING_URL: 'ftp://x/v1', EMBEDDING_MODEL: 'm' }).warning ?? '', /http\(s\)/)
  })

  it('accepts an OpenAI-compatible base URL, a local Ollama and a full /embeddings URL', () => {
    assert.equal(embeddingsEndpoint('http://192.168.0.10:11434/v1'), 'http://192.168.0.10:11434/v1/embeddings')
    assert.equal(embeddingsEndpoint('https://api.openai.com/v1/'), 'https://api.openai.com/v1/embeddings')
    assert.equal(embeddingsEndpoint('http://tei:8080/v1/embeddings/'), 'http://tei:8080/v1/embeddings')
    assert.equal(embeddingsEndpoint('not a url'), null)
    const c = readSemanticConfig({ EMBEDDING_URL: 'http://host:11434/v1', EMBEDDING_MODEL: 'bge-m3' }).config!
    assert.equal(c.apiKey, null)
    assert.equal(c.batchSize, 32)
    assert.equal(c.requestsPerMinute, 60)
    assert.equal(c.dimensions, null)
    const d = readSemanticConfig({
      EMBEDDING_URL: 'https://api.example.com/v1',
      EMBEDDING_MODEL: 'text-embedding-3-small',
      EMBEDDING_API_KEY: ' sk-test ',
      EMBEDDING_BATCH_SIZE: '9999',
      EMBEDDING_REQUESTS_PER_MINUTE: '0',
      EMBEDDING_DIMENSIONS: '256',
    }).config!
    assert.equal(d.apiKey, 'sk-test')
    assert.equal(d.batchSize, 256)
    assert.equal(d.requestsPerMinute, 1)
    assert.equal(d.dimensions, 256)
  })

  it('labels the endpoint without credentials or query strings', () => {
    assert.equal(endpointLabel('https://user:pass@api.example.com/v1/embeddings?key=abc'), 'https://api.example.com/v1/embeddings')
  })
})

describe('semantic search is off by default: nothing runs', () => {
  it('semanticCandidates answers null without fetch or a database query; the indexer starts no timer', async () => {
    resetSemanticConfigForTests()
    assert.equal(semanticConfig(), null)
    const realFetch = globalThis.fetch
    let fetches = 0
    globalThis.fetch = (async () => {
      fetches++
      throw new Error('fetch must not be called')
    }) as typeof fetch
    try {
      const { semanticCandidates, semanticStats, semanticStatus } = await import('./semantic')
      const { startSemanticIndexer, runSemanticIndexPass, collectStaleVectors, indexerStats } = await import('./semanticIndexer')
      const timersBefore = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length
      const r = await semanticCandidates({
        workspaceIds: ['00000000-0000-4000-8000-000000000000'],
        query: 'anything',
        limit: 10,
        userId: '00000000-0000-4000-8000-000000000001',
      })
      assert.equal(r, null)
      assert.deepEqual(semanticStats, { calls: 0, dbQueries: 0, cacheLoads: 0, sqlScans: 0 })
      assert.equal(await semanticStatus(), null)
      const logs: string[] = []
      const stop = startSemanticIndexer((m) => logs.push(m))
      assert.deepEqual(await runSemanticIndexPass(), { embedded: 0, more: false })
      assert.equal(await collectStaleVectors(), 0)
      assert.equal(process.getActiveResourcesInfo().filter((x) => x === 'Timeout').length, timersBefore)
      await stop()
      assert.deepEqual(logs, [])
      assert.deepEqual(indexerStats, { passes: 0, scans: 0, requests: 0, embedded: 0, deleted: 0 })
      assert.equal(fetches, 0)
      assert.equal(embeddingHealth.requests, 0)
    } finally {
      globalThis.fetch = realFetch
    }
  })
})

describe('/embeddings client against a local fake server', () => {
  let fake: FakeEmbeddingServer
  const cfg = () =>
    readSemanticConfig({ EMBEDDING_URL: fake.url, EMBEDDING_MODEL: 'fake-1', EMBEDDING_API_KEY: 'sk-secret-test-key-123456' }).config!

  before(async () => {
    fake = await startFakeEmbeddings(32)
  })
  after(async () => {
    await fake.close()
  })

  it('sends model, inputs and the key; returns normalised vectors in input order', async () => {
    fake.mode = 'ok'
    const out = await embedTexts(cfg(), ['deploy rollback', 'team checklist', 'x'], 2_000)
    assert.equal(out.length, 3)
    for (const v of out) {
      assert.equal(v.length, 32)
      const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0))
      assert.ok(Math.abs(n - 1) < 1e-5)
    }
    const last = fake.requests.at(-1)!
    assert.equal(last.auth, 'Bearer sk-secret-test-key-123456')
    assert.equal(last.model, 'fake-1')
    assert.deepEqual(last.inputs, ['deploy rollback', 'team checklist', 'x'])
    // the server answered in reverse order: the `index` field decides
    const again = await embedTexts(cfg(), ['team checklist'], 2_000)
    assert.deepEqual(Array.from(again[0]), Array.from(out[1]))
  })

  it('no Authorization header without a key; `dimensions` only when set', async () => {
    fake.mode = 'ok'
    const c = readSemanticConfig({ EMBEDDING_URL: fake.url, EMBEDDING_MODEL: 'm', EMBEDDING_DIMENSIONS: '16' }).config!
    const [v] = await embedTexts(c, ['a b'], 2_000)
    assert.equal(v.length, 16)
    assert.equal(fake.requests.at(-1)!.auth, null)
    assert.equal(fake.requests.at(-1)!.dimensions, 16)
  })

  it('errors carry the status, never the key (even when the provider echoes it)', async () => {
    fake.mode = 'echoKey401'
    await assert.rejects(embedTexts(cfg(), ['a'], 2_000), (err: unknown) => {
      assert.ok(err instanceof EmbeddingError)
      assert.equal(err.status, 401)
      assert.doesNotMatch(err.message, /secret-test-key/)
      assert.match(err.message, /HTTP 401/)
      assert.match(err.message, /^http:\/\/127\.0\.0\.1:\d+\/v1\/embeddings: /)
      return true
    })
    fake.mode = 'rate429'
    await assert.rejects(embedTexts(cfg(), ['a'], 2_000), (err: unknown) => {
      assert.ok(err instanceof EmbeddingError)
      assert.equal(err.status, 429)
      assert.equal(err.retryAfterMs, 7_000)
      return true
    })
    fake.mode = 'reject400'
    await assert.rejects(embedTexts(cfg(), ['a'], 2_000), (err: unknown) => err instanceof EmbeddingError && err.inputRejected)
    fake.mode = 'malformed'
    await assert.rejects(embedTexts(cfg(), ['a'], 2_000), (err: unknown) => err instanceof EmbeddingError && /malformed/.test(err.message))
    fake.mode = 'ok'
  })

  it('a hanging endpoint times out', async () => {
    fake.mode = 'hang'
    const t0 = Date.now()
    await assert.rejects(embedTexts(cfg(), ['a'], 300), (err: unknown) => err instanceof EmbeddingError && /timeout after 300 ms/.test(err.message))
    assert.ok(Date.now() - t0 < 2_000)
    fake.mode = 'ok'
  })

  it('an unreachable endpoint is a connection error', async () => {
    const c = readSemanticConfig({ EMBEDDING_URL: 'http://127.0.0.1:1/v1', EMBEDDING_MODEL: 'm' }).config!
    await assert.rejects(embedTexts(c, ['a'], 1_000), (err: unknown) => err instanceof EmbeddingError && err.status === null)
  })
})

describe('backoff and redaction', () => {
  it('backs off exponentially up to 10 minutes, honours Retry-After, not for refused inputs', () => {
    resetEmbeddingHealthForTests()
    const now = 1_000_000
    recordFailure(new EmbeddingError('x', 500), now)
    assert.equal(embeddingHealth.backoffUntil, now + 5_000)
    recordFailure(new EmbeddingError('x', 500), now)
    assert.equal(embeddingHealth.backoffUntil, now + 10_000)
    recordFailure(new EmbeddingError('x', 429, 60_000), now)
    assert.equal(embeddingHealth.backoffUntil, now + 60_000)
    for (let i = 0; i < 20; i++) recordFailure(new EmbeddingError('x', null), now)
    assert.equal(embeddingHealth.backoffUntil, now + BACKOFF_MAX_MS)
    resetEmbeddingHealthForTests()
    recordFailure(new EmbeddingError('too long', 400), now)
    assert.equal(embeddingHealth.backoffUntil, 0)
    assert.equal(inBackoff(now), false)
    assert.equal(embeddingHealth.lastError?.message, 'too long')
    resetEmbeddingHealthForTests()
  })

  it('redacts keys and bearer tokens', () => {
    assert.equal(redact('bad key abc123secret here', 'abc123secret'), 'bad key *** here')
    assert.equal(redact('Authorization: Bearer xyz.abc', null), 'Authorization: Bearer ***')
    assert.equal(redact('Incorrect API key provided: sk-proj-abcdefghijkl', null), 'Incorrect API key provided: sk-***')
  })

  it('normalize refuses zero and non-finite vectors', () => {
    assert.equal(normalize([0, 0]), null)
    assert.equal(normalize([1, Number.NaN]), null)
    assert.deepEqual(Array.from(normalize([3, 4])!), [0.6000000238418579, 0.800000011920929])
  })
})
