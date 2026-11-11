// Multipart bodies that end inside a file part, with no closing boundary (GHSA-5849-5m6q-9632):
// every route that reads multipart answers within a few seconds with a 4xx and does not hang.
// @fastify/multipart before 10.1.7 destroyed the file stream of such a part without an error, so a
// handler that awaited something before consuming `part.file` could wait forever on it.
//
// The requests go over a real socket (a Unix socket, so no TCP port is taken) with a Content-Length
// that matches the cut body: the server sees the end of the request while the client keeps the
// connection open for the answer, which is what an attacker does.
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DATA = `${process.env.TMPDIR || '/tmp'}/inkling-mp-truncated-${process.pid}`
process.env.DATA_DIR ||= DATA
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.APP_URL ||= 'https://notes.example.com'

import assert from 'node:assert/strict'
import http from 'node:http'
import { after, before, describe, it } from 'node:test'

const HAS_DB = !!process.env.DATABASE_URL
/** a handler that has not answered by then is counted as hanging */
const ANSWER_WITHIN_MS = 5000
const B = 'w211TruncatedBoundary'

interface Part {
  filename: string
  type: string
  data: Buffer
}

/** Complete parts followed by one part whose data is cut: no CRLF, no closing boundary. */
function cutBody(complete: Part[], cut: Part): Buffer {
  const head = (p: Part) =>
    `--${B}\r\nContent-Disposition: form-data; name="file"; filename="${p.filename}"\r\nContent-Type: ${p.type}\r\n\r\n`
  const chunks: Buffer[] = []
  for (const p of complete) chunks.push(Buffer.from(head(p)), p.data, Buffer.from('\r\n'))
  chunks.push(Buffer.from(head(cut)), cut.data)
  return Buffer.concat(chunks)
}

function send(socketPath: string, url: string, cookie: string, body: Buffer): Promise<{ status: number } | 'hung'> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      socketPath,
      method: 'POST',
      path: url,
      headers: {
        cookie,
        'content-type': `multipart/form-data; boundary=${B}`,
        'content-length': String(body.length),
      },
    })
    const timer = setTimeout(() => {
      req.destroy()
      resolve('hung')
    }, ANSWER_WITHIN_MS)
    req.on('response', (res) => {
      res.resume()
      res.on('end', () => {
        clearTimeout(timer)
        resolve({ status: res.statusCode ?? 0 })
      })
    })
    req.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    req.end(body)
  })
}

describe('[db] multipart body cut inside a file part (GHSA-5849-5m6q-9632)', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  mkdirSync(path.join(process.env.DATA_DIR!, 'uploads'), { recursive: true })
  mkdirSync(path.join(process.env.DATA_DIR!, 'tmp'), { recursive: true })
  const h = await import('../mcpTools/testHarness')
  const { closeDb } = await import('../db/index')
  const collab = await import('../collab')
  const app = await h.buildTestApp()
  const sockDir = mkdtempSync(path.join(os.tmpdir(), 'ink-mp-'))
  const socketPath = path.join(sockDir, 's')

  let cookie: string
  let wsId: string

  before(async () => {
    const u = await h.makeUser('Mia')
    cookie = u.cookie
    wsId = (await h.makeWorkspace(u)).id
    await app.listen({ path: socketPath })
  })
  after(async () => {
    await collab.destroyCollab()
    await app.close()
    await closeDb()
    rmSync(sockDir, { recursive: true, force: true })
  })

  const small = (n: number) => Buffer.alloc(n, 0x61)
  // a cut part larger than the stream buffers, so the file stream is still waiting for data
  const big = 512 * 1024

  const cases: { name: string; url: () => string; body: () => Buffer }[] = [
    {
      name: 'file upload (POST /api/files)',
      url: () => `/api/files?workspaceId=${wsId}`,
      body: () => cutBody([], { filename: 'a.txt', type: 'text/plain', data: small(10) }),
    },
    {
      name: 'file upload, large cut part',
      url: () => `/api/files?workspaceId=${wsId}`,
      body: () => cutBody([], { filename: 'a.txt', type: 'text/plain', data: small(big) }),
    },
    {
      name: 'import (POST /api/workspaces/:id/import)',
      url: () => `/api/workspaces/${wsId}/import`,
      body: () => cutBody([], { filename: 'a.md', type: 'text/markdown', data: Buffer.from('# Cut\n\ntext') }),
    },
    {
      name: 'import, large cut part',
      url: () => `/api/workspaces/${wsId}/import`,
      body: () => cutBody([], { filename: 'a.md', type: 'text/markdown', data: small(big) }),
    },
    {
      name: 'folder import (POST /api/workspaces/:id/import-folder), first part cut',
      url: () => `/api/workspaces/${wsId}/import-folder`,
      body: () => cutBody([], { filename: encodeURIComponent('dir/a.md'), type: 'text/markdown', data: Buffer.from('# A') }),
    },
    {
      name: 'folder import, second part cut',
      url: () => `/api/workspaces/${wsId}/import-folder`,
      body: () =>
        cutBody([{ filename: encodeURIComponent('dir/a.md'), type: 'text/markdown', data: Buffer.from('# A\n') }], {
          filename: encodeURIComponent('dir/b.md'),
          type: 'text/markdown',
          data: small(big),
        }),
    },
    {
      name: 'template import (POST /api/workspaces/:id/templates/import)',
      url: () => `/api/workspaces/${wsId}/templates/import`,
      body: () => cutBody([], { filename: 't.md', type: 'text/markdown', data: Buffer.from('# T\n\ntext') }),
    },
    {
      name: 'template import, large cut part',
      url: () => `/api/workspaces/${wsId}/templates/import`,
      body: () => cutBody([], { filename: 't.md', type: 'text/markdown', data: small(big) }),
    },
  ]

  for (const c of cases) {
    it(`${c.name}: answers with a 4xx instead of hanging`, async () => {
      const res = await send(socketPath, c.url(), cookie, c.body())
      assert.notEqual(res, 'hung', `no answer within ${ANSWER_WITHIN_MS} ms`)
      if (res === 'hung') return
      assert.ok(res.status >= 400 && res.status < 500, `status ${res.status}`)
    })
  }

  it('the server still answers a complete upload afterwards', async () => {
    const data = Buffer.from('hello')
    const body = Buffer.concat([
      cutBody([], { filename: 'ok.txt', type: 'text/plain', data }),
      Buffer.from(`\r\n--${B}--\r\n`),
    ])
    const res = await send(socketPath, `/api/files?workspaceId=${wsId}`, cookie, body)
    assert.deepEqual(res, { status: 200 })
  })
})
